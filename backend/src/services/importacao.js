const pool = require('../db');
const tse = require('./tse');
const votos = require('./votosSecao');
const campanha = require('./campanha');
const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');

// "Importar votos do TSE" — um botão (briefing "Votos por seção" v2, item 4).
//
// O briefing sugere baixar o ZIP "votacao_secao_{ANO}_{UF}" dos dados
// abertos. Aqui a fonte é o boletim de urna de cada seção, no portal de
// resultados do TSE — a mesma varredura de "Votos por Seção" (votosSecao.js).
// Dá o mesmo número (conferido voto a voto em MS e AC, 712 candidatos) e tem
// duas vantagens: sai na noite da eleição, e não dias depois (em 2024 o ZIP
// só saiu 4 dias após o 1º turno), e já traz brancos, nulos, comparecimento e
// aptos de cada seção, que o briefing pede para "secoes_totais".
//
// Nada é gravado por candidato: o boletim fica em tse_urnas, uma linha por
// urna com todos os candidatos. Reimportar é o mesmo upsert por urna — nunca
// duplica — e o estado de um adversário não vira milhões de linhas a mais.
// Esta tabela (importacoes_tse) guarda o histórico e a auditoria: quem pediu,
// quando, de onde veio e o que deu.

class Indisponivel extends Error {}

function origem(d) {
  return `resultados.tse.jus.br · ${d.ciclo}/arquivo-urna/${d.pleito} · boletins de urna de ${String(d.uf).toUpperCase()}`;
}

// Municípios que entram na conta: o da campanha municipal, os municípios-alvo,
// ou nenhum filtro (estado todo).
function municipioDaConsulta(d) {
  return campanha.MUNICIPAIS.includes(d.cargo) ? (d.municipios[0]?.codigo || null) : null;
}

async function garantirCodigos(d) {
  if (d.ciclo && d.pleito && d.eleicao) return d;
  // O TSE pode ter publicado a eleição depois que o candidato foi cadastrado.
  const e = await campanha.resolverEleicao(d.ano, d.turno, d.cargo);
  if (!e) return d;
  await pool.query(
    'UPDATE candidato_dados SET ciclo = $2, pleito = $3, eleicao = $4 WHERE candidato_id = $1',
    [d.candidato_id, e.ciclo, e.pleito, e.eleicao]
  );
  return { ...d, ...e };
}

async function registrar(d, usuario, campos) {
  const { rows } = await pool.query(
    `INSERT INTO importacoes_tse (candidato_id, usuario_id, usuario_nome, arquivo, ciclo, pleito, uf, cargo, numero,
       status, total_oficial, erro, concluido_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $10 IN ('indisponivel','erro') THEN now() END)
     RETURNING *`,
    [d.candidato_id, usuario?.id || null, usuario?.nome || null, d.ciclo ? origem(d) : 'TSE',
      d.ciclo || '-', d.pleito || '-', d.uf, d.cargo, d.numero,
      campos.status, campos.total_oficial ?? null, campos.erro ?? null]
  );
  return rows[0];
}

// Um clique: confere que o TSE já publicou, dispara a carga do estado (ou a
// atualização, se já tinha sido carregado) e abre o registro da importação.
async function iniciar(candidatoId, usuario) {
  let d = await campanha.carregarDados(candidatoId);
  if (!d) throw new Error('Preencha e salve os dados do candidato antes de importar.');
  d = await garantirCodigos(d);
  try {
    if (!d.ciclo) throw new Indisponivel();
    const municipio = municipioDaConsulta(d);
    const [cand, urnas] = await Promise.all([
      tse.candidatosCargo({ ciclo: d.ciclo, eleicao: d.eleicao, uf: d.uf, municipio, cargo: d.cargo }).catch(() => null),
      votos.urnasDoEstado(d.ciclo, d.pleito, d.uf).catch(() => null),
    ]);
    if (!cand || !urnas) throw new Indisponivel();
    const c = cand.candidatos.find((x) => x.numero === d.numero);
    if (!c) {
      const erro = `O número ${d.numero} não está na lista oficial do TSE para ${d.cargo_nome}${municipio ? ` em ${d.municipios[0].nome}` : ''} em ${d.ano}. Confira o cadastro do candidato.`;
      await registrar(d, usuario, { status: 'erro', erro });
      return { status: 'erro', erro };
    }
    // Só os municípios que o candidato precisa — nunca o estado inteiro
    // (pedido da dona do sistema, 05/10/2026).
    const escopo = await municipiosDoEscopo(d, urnas.mapa);
    if (!escopo.length) {
      const erro = 'Campanha de estado todo: cadastre zona e seção das pessoas da rede antes de importar — a importação busca só os municípios onde a rede vota.';
      await registrar(d, usuario, { status: 'erro', erro });
      return { status: 'erro', erro };
    }
    const st = await votos.statusColeta(d.ciclo, d.pleito, d.uf);
    // Já carregado antes: baixa de novo (o TSE corrige boletim depois da
    // eleição). Sem apagar nada — a tela segue com o que havia até terminar.
    await votos.iniciarColeta({ ciclo: d.ciclo, pleito: d.pleito, uf: d.uf, usuarioId: usuario?.id, refazer: st.status === 'concluida', municipios: escopo });
    const imp = await registrar(d, usuario, { status: 'coletando', total_oficial: c.votos });
    await pool.query('UPDATE importacoes_tse SET municipios_escopo = $2 WHERE id = $1', [imp.id, escopo]);
    return { status: 'coletando', importacao: { ...imp, municipios_escopo: escopo } };
  } catch (e) {
    if (!(e instanceof Indisponivel)) throw e;
    const imp = await registrar(d, usuario, { status: 'indisponivel', erro: 'Dados do TSE ainda não disponíveis' });
    return { status: 'indisponivel', mensagem: 'Dados do TSE ainda não disponíveis. Tente de novo mais tarde.', importacao: imp };
  }
}

// Fecha a importação quando a carga do estado termina: soma os votos do
// candidato, conta seções e municípios e confere com o total oficial.
async function finalizar(imp, d) {
  const municipio = municipioDaConsulta(d);
  const r = await votos.resultadoCandidato({
    ciclo: d.ciclo, pleito: d.pleito, eleicao: d.eleicao, uf: d.uf, cargo: d.cargo, numero: d.numero,
    municipio, candidatoId: d.candidato_id,
  });
  // Soma só os municípios desta importação (a tabela pode ter outros, que
  // outra campanha do mesmo estado mandou baixar).
  const escopo = new Set(imp.municipios_escopo || []);
  const muns = escopo.size ? r.municipios.filter((m) => escopo.has(m.codigo)) : r.municipios;
  const total = muns.reduce((s, m) => s + (m.votos || 0), 0);
  const secoes = muns.reduce((s, m) => s + (m.comVoto || 0), 0);
  const urnasLidas = muns.reduce((s, m) => s + (m.urnas || 0), 0);
  const oficial = r.candidato ? r.candidato.votos : imp.total_oficial;
  // O total oficial é da cidade (vereador/prefeito) ou do estado. Só dá para
  // conferir quando a importação cobriu tudo o que o oficial cobre.
  const cobreTudo = campanha.MUNICIPAIS.includes(d.cargo) || (r.resumo.urnasDoEstado && urnasLidas >= r.resumo.urnasDoEstado);
  const { rows } = await pool.query(
    `UPDATE importacoes_tse SET status = 'concluida', linhas = $2, secoes = $3, municipios = $4, total_votos = $5,
       total_oficial = $6, confere = $7, concluido_em = now()
     WHERE id = $1 RETURNING *`,
    [imp.id, urnasLidas, secoes, muns.filter((m) => m.votos > 0).length, total, oficial,
      oficial == null || !cobreTudo ? null : total === oficial]
  );
  return rows[0];
}

// Municípios a baixar: o do vereador/prefeito, os municípios-alvo, ou — na
// campanha de estado todo — os municípios onde há gente da rede votando.
async function municipiosDoEscopo(d, mapa) {
  if (d.abrangencia !== 'estado') return d.municipios.map((m) => m.codigo);
  const { rows } = await pool.query(`SELECT zona, secao, municipio_votacao FROM (${SQL_ARVORE_CANDIDATO}) r`, [d.candidato_id]);
  const out = new Set();
  for (const a of rows) {
    if (a.municipio_votacao) out.add(a.municipio_votacao);
    const loc = mapa && mapa.secoes.get(`${tse.pad4(a.zona)}|${tse.pad4(a.secao)}`);
    if (loc) out.add(loc.municipio);
  }
  return [...out];
}

async function ultima(candidatoId) {
  const { rows } = await pool.query(
    'SELECT * FROM importacoes_tse WHERE candidato_id = $1 ORDER BY iniciado_em DESC LIMIT 1', [candidatoId]
  );
  return rows[0] || null;
}

// Estado da última importação; fecha a que estava em andamento se a carga do
// estado já terminou (não precisa de laço próprio: quem abre a tela fecha).
async function situacao(candidatoId) {
  let imp = await ultima(candidatoId);
  let progresso = null;
  if (imp && imp.status === 'coletando') {
    const d = await campanha.carregarDados(candidatoId);
    const st = await votos.statusColeta(imp.ciclo, imp.pleito, imp.uf);
    progresso = { coletadas: st.coletadas, total: st.total, semBu: st.semBu || 0 };
    if (st.status === 'concluida' && d && d.ciclo) {
      imp = await finalizar(imp, d);
    } else if (st.status === 'erro') {
      const { rows } = await pool.query(
        `UPDATE importacoes_tse SET status = 'erro', erro = $2, concluido_em = now() WHERE id = $1 RETURNING *`,
        [imp.id, st.erro || 'O TSE não respondeu.']
      );
      imp = rows[0];
    }
  }
  const { rows: historico } = await pool.query(
    `SELECT id, usuario_nome, arquivo, status, linhas, secoes, municipios, total_votos, total_oficial, confere, erro,
            iniciado_em, concluido_em
       FROM importacoes_tse WHERE candidato_id = $1 ORDER BY iniciado_em DESC LIMIT 15`, [candidatoId]
  );
  return { atual: imp, progresso, historico };
}

module.exports = { iniciar, situacao, ultima };
