const pool = require('../db');
const campanha = require('./campanha');
const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');

// Números do Módulo Mandato: o painel por bairro e nicho (Fase 3), a
// prestação de contas (Fase 5) e o cruzamento do perfil de atuação (Fase 5).
// As três telas leem daqui para mostrar o mesmo número — se cada uma somasse
// do seu jeito, a prestação de contas publicada diria uma coisa e o painel
// interno outra.

const ABERTAS = ['recebida', 'em_analise', 'encaminhada', 'aguardando_resposta', 'em_execucao'];
const ATENDIDAS = ['respondida', 'concluida'];

// Bairro é digitado de jeitos diferentes por quem cadastra ("Jd. América",
// "JARDIM AMERICA") e o TSE escreve em maiúsculas sem padrão. A chave junta só
// o que é o mesmo nome escrito diferente: acento, caixa e espaço. Abreviação
// não é desfeita aqui de propósito: "Jd" pode ser Jardim, mas casar por
// palpite misturaria bairros diferentes (lição do mapa, docs/04).
function chaveBairro(b) {
  return String(b || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
const SEM_BAIRRO = 'Bairro não informado';
const SEM_NICHO = 'Sem nicho';

function periodo(p = {}) {
  const ok = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null);
  return { de: ok(p.de), ate: ok(p.ate) };
}

// Agregado por bairro ou nicho. somentePublicados: para a rede e o público,
// proposições, emendas e trabalhos só contam o que a equipe marcou como
// publicado; demandas entram só como contagem (nunca o conteúdo).
async function agregados(candidatoId, { agrupar = 'bairro', de = null, ate = null, somentePublicados = false } = {}) {
  const porNicho = agrupar === 'nicho';
  const grupoSql = (tabela) => (porNicho
    ? `COALESCE((SELECT nome FROM nichos n WHERE n.id = ${tabela}.nicho_id), '${SEM_NICHO}')`
    : `COALESCE(NULLIF(trim(${tabela}.bairro), ''), '${SEM_BAIRRO}')`);
  const pub = (col) => (somentePublicados ? `AND ${col}` : '');

  const [dem, pro, eme, tra] = await Promise.all([
    pool.query(
      `SELECT ${grupoSql('d')} AS grupo,
              count(*)::int AS recebidas,
              count(*) FILTER (WHERE d.status = ANY($4))::int AS atendidas,
              count(*) FILTER (WHERE d.status = ANY($5))::int AS pendentes,
              count(*) FILTER (WHERE d.status = ANY($5) AND d.prazo_em < now())::int AS vencidas
         FROM mandato_demandas d
        WHERE d.candidato_id = $1
          AND ($2::date IS NULL OR d.created_at >= $2::date)
          AND ($3::date IS NULL OR d.created_at < $3::date + 1)
        GROUP BY 1`, [candidatoId, de, ate, ATENDIDAS, ABERTAS]
    ),
    pool.query(
      `SELECT ${grupoSql('p')} AS grupo, count(*)::int AS proposicoes,
              count(*) FILTER (WHERE p.status IN ('aprovada','sancionada','respondida'))::int AS proposicoes_aprovadas
         FROM mandato_proposicoes p
        WHERE p.candidato_id = $1 ${pub('p.publicada')}
          AND ($2::date IS NULL OR COALESCE(p.protocolada_em, p.created_at::date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(p.protocolada_em, p.created_at::date) <= $3::date)
        GROUP BY 1`, [candidatoId, de, ate]
    ),
    pool.query(
      `SELECT ${grupoSql('e')} AS grupo, count(*)::int AS emendas,
              COALESCE(sum(e.valor) FILTER (WHERE e.fase <> 'cancelada'), 0)::float AS emendas_valor,
              COALESCE(sum(e.valor) FILTER (WHERE e.fase IN ('paga','executada')), 0)::float AS emendas_pago
         FROM mandato_emendas e
        WHERE e.candidato_id = $1 ${pub('e.publicada')}
          AND ($2::date IS NULL OR make_date(e.ano, 12, 31) >= $2::date)
          AND ($3::date IS NULL OR make_date(e.ano, 1, 1) <= $3::date)
        GROUP BY 1`, [candidatoId, de, ate]
    ),
    pool.query(
      `SELECT ${grupoSql('t')} AS grupo, count(*)::int AS trabalhos
         FROM mandato_trabalhos t
        WHERE t.candidato_id = $1 ${pub('t.publicado')}
          AND ($2::date IS NULL OR COALESCE(t.realizado_em, t.created_at::date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(t.realizado_em, t.created_at::date) <= $3::date)
        GROUP BY 1`, [candidatoId, de, ate]
    ),
  ]);

  // Junta as quatro listas pela chave do grupo (bairro sem acento/caixa).
  const grupos = new Map();
  const vazio = (nome) => ({
    grupo: nome, recebidas: 0, atendidas: 0, pendentes: 0, vencidas: 0,
    proposicoes: 0, proposicoes_aprovadas: 0, emendas: 0, emendas_valor: 0, emendas_pago: 0, trabalhos: 0,
  });
  for (const lista of [dem.rows, pro.rows, eme.rows, tra.rows]) {
    for (const r of lista) {
      const k = porNicho ? r.grupo : chaveBairro(r.grupo);
      if (!grupos.has(k)) grupos.set(k, vazio(r.grupo));
      const g = grupos.get(k);
      for (const [campo, v] of Object.entries(r)) if (campo !== 'grupo') g[campo] += v;
    }
  }
  const linhas = [...grupos.values()].sort((a, b) => (b.recebidas + b.trabalhos) - (a.recebidas + a.trabalhos) || a.grupo.localeCompare(b.grupo));
  const totais = vazio('Total');
  for (const g of linhas) for (const k of Object.keys(totais)) if (k !== 'grupo') totais[k] += g[k];
  return { agrupar: porNicho ? 'nicho' : 'bairro', de, ate, totais, grupos: linhas };
}

// Painel interno: os agregados + o que precisa de atenção hoje.
async function painel(candidatoId) {
  const [porBairro, porNicho, status, fases, propStatus, vencidas] = await Promise.all([
    agregados(candidatoId, { agrupar: 'bairro' }),
    agregados(candidatoId, { agrupar: 'nicho' }),
    pool.query('SELECT status, count(*)::int AS n FROM mandato_demandas WHERE candidato_id = $1 GROUP BY 1', [candidatoId]),
    pool.query(`SELECT fase, count(*)::int AS n, COALESCE(sum(valor),0)::float AS valor
                  FROM mandato_emendas WHERE candidato_id = $1 GROUP BY 1`, [candidatoId]),
    pool.query('SELECT status, count(*)::int AS n FROM mandato_proposicoes WHERE candidato_id = $1 GROUP BY 1', [candidatoId]),
    pool.query(
      `SELECT id, protocolo, titulo, bairro, status, prazo_em FROM mandato_demandas
        WHERE candidato_id = $1 AND status = ANY($2) AND prazo_em < now()
        ORDER BY prazo_em LIMIT 20`, [candidatoId, ABERTAS]
    ),
  ]);
  const { rows: agenda } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'pedido')::int AS pedidos,
            count(*) FILTER (WHERE status IN ('confirmado','reagendado') AND marcado_para >= now())::int AS proximos
       FROM mandato_agenda WHERE candidato_id = $1`, [candidatoId]
  );
  return {
    porBairro, porNicho,
    demandasPorStatus: Object.fromEntries(status.rows.map((r) => [r.status, r.n])),
    emendasPorFase: fases.rows,
    proposicoesPorStatus: Object.fromEntries(propStatus.rows.map((r) => [r.status, r.n])),
    vencidas: vencidas.rows,
    agenda: agenda[0],
  };
}

// Perfil de atuação (briefing 2.2): cruza a votação por seção com nichos e
// demandas. Por bairro: votos do vereador nas urnas daquele bairro (o bairro
// é o do LOCAL DE VOTAÇÃO, segundo o TSE), gente da rede que mora ali e o que
// o mandato já fez ou deve ali. Por nicho: tamanho da base × demandas ×
// proposições. Só números — é o que vai para a IA, nunca nome de ninguém.
async function cruzamentoAtuacao(candidatoId) {
  const [porBairro, porNicho] = await Promise.all([
    agregados(candidatoId, { agrupar: 'bairro' }),
    agregados(candidatoId, { agrupar: 'nicho' }),
  ]);

  // Rede por bairro (onde mora) e por nicho, na mesma consulta da pirâmide.
  const { rows: rede } = await pool.query(SQL_ARVORE_CANDIDATO, [candidatoId]);
  const redePorBairro = new Map();
  for (const a of rede) {
    const k = chaveBairro(a.regiao && a.regiao !== '—' ? a.regiao : '');
    if (!k) continue;
    redePorBairro.set(k, (redePorBairro.get(k) || 0) + 1);
  }
  const ids = rede.map((a) => a.id);
  const { rows: rn } = ids.length ? await pool.query(
    `SELECT n.nome, count(*)::int AS n FROM apoiador_nichos an JOIN nichos n ON n.id = an.nicho_id
      WHERE n.candidato_id = $1 AND an.apoiador_id = ANY($2) GROUP BY n.nome`, [candidatoId, ids]
  ) : { rows: [] };
  const redePorNicho = new Map(rn.map((r) => [r.nome, r.n]));

  // Votos por bairro, se a eleição do candidato estiver cadastrada e importada.
  let votos = null; let avisoVotos = null;
  const d = await campanha.carregarDados(candidatoId).catch(() => null);
  if (!d || !d.ciclo || !d.pleito) {
    avisoVotos = 'Cadastre a eleição na aba 🎯 Candidato e importe os votos do TSE para cruzar com a votação por seção.';
  } else {
    // require tardio: entrega.js puxa routes/apoiadores, que já está carregado aqui.
    const { urnasDoCandidato } = require('./entrega');
    try {
      const { urnas } = await urnasDoCandidato(d);
      if (!urnas.size) avisoVotos = 'Os votos do TSE ainda não foram importados (aba 🎯 Candidato → Importar votos do TSE).';
      votos = new Map(); let total = 0;
      for (const u of urnas.values()) {
        const k = chaveBairro(u.bairro === 'Bairro não informado' ? '' : u.bairro);
        const v = votos.get(k) || { votos: 0, secoes: 0, comparecimento: 0, nome: u.bairro };
        v.votos += u.votos; v.secoes += 1; v.comparecimento += u.comparecimento;
        votos.set(k, v); total += u.votos;
        votos.total = total;
      }
    } catch (e) {
      avisoVotos = 'Não foi possível ler os votos do TSE agora. Tente de novo em instantes.';
      votos = null;
    }
  }

  // Bairros: união do que há em demandas/trabalhos, na rede e nos votos.
  const bairros = new Map();
  const pega = (k, nome) => {
    if (!bairros.has(k)) bairros.set(k, { bairro: nome, votos: null, secoes: 0, pct_votos: null, rede: 0, recebidas: 0, pendentes: 0, vencidas: 0, atendidas: 0, trabalhos: 0, emendas_valor: 0, proposicoes: 0 });
    return bairros.get(k);
  };
  for (const g of porBairro.grupos) {
    if (g.grupo === SEM_BAIRRO) continue;
    const b = pega(chaveBairro(g.grupo), g.grupo);
    Object.assign(b, { recebidas: g.recebidas, pendentes: g.pendentes, vencidas: g.vencidas, atendidas: g.atendidas, trabalhos: g.trabalhos, emendas_valor: g.emendas_valor, proposicoes: g.proposicoes });
  }
  for (const [k, n] of redePorBairro) {
    const nome = rede.find((a) => chaveBairro(a.regiao) === k)?.regiao || k;
    pega(k, nome).rede = n;
  }
  if (votos) {
    for (const [k, v] of votos) {
      if (!k) continue;
      const b = pega(k, v.nome);
      b.votos = v.votos; b.secoes = v.secoes;
      b.pct_votos = votos.total ? Math.round((v.votos / votos.total) * 1000) / 10 : null;
    }
  }
  const listaBairros = [...bairros.values()]
    .sort((a, b) => (b.votos || 0) - (a.votos || 0) || b.rede - a.rede || b.recebidas - a.recebidas)
    .slice(0, 60);

  const nichos = porNicho.grupos.filter((g) => g.grupo !== SEM_NICHO).map((g) => ({
    nicho: g.grupo, rede: redePorNicho.get(g.grupo) || 0, recebidas: g.recebidas, pendentes: g.pendentes,
    proposicoes: g.proposicoes, trabalhos: g.trabalhos,
  }));
  for (const [nome, n] of redePorNicho) if (!nichos.some((x) => x.nicho === nome)) nichos.push({ nicho: nome, rede: n, recebidas: 0, pendentes: 0, proposicoes: 0, trabalhos: 0 });
  nichos.sort((a, b) => b.rede - a.rede || b.recebidas - a.recebidas);

  return {
    votosTotal: votos?.total ?? null,
    avisoVotos,
    eleicao: d ? { ano: d.ano, cargo: d.cargo_nome, numero: d.numero } : null,
    bairros: listaBairros,
    nichos,
  };
}

module.exports = { ABERTAS, ATENDIDAS, agregados, painel, cruzamentoAtuacao, periodo, chaveBairro };
