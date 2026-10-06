const pool = require('../db');
const tse = require('./tse');
const campanha = require('./campanha');
const votosSecao = require('./votosSecao');
const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');

// Relatório "Prometido × Entregue" (briefing "Votos por seção" v2, item 5).
//
// Para cada Líder, Coordenador e Mobilizador: junta as seções onde votam as
// pessoas da rede dele (ele mesmo + todos abaixo) e compara com os votos do
// candidato nessas seções. O voto é secreto e o dado do TSE é por seção, não
// por pessoa: o número indica a entrega da ÁREA DE INFLUÊNCIA, nunca o voto
// de alguém — a tela diz isso.
//
// Desde 06/10/2026 "votos" é o ATRIBUÍDO à equipe (utils/atribuicao.js): cada
// seção divide entre as equipes, pelos cadastrados de cada uma ali, só o que
// cabe na rede. Até então a seção contava inteira para cada liderança, e a
// soma dos líderes de Dourados passou do total do candidato. O total da urna
// continua em "votosSecoes", como referência. Sem meta declarada, a entrega
// fica "sem meta": usar o tamanho da rede como meta fazia parecer que alguém
// tinha prometido — e misturava a meta de candidatos de cargos diferentes
// com as mesmas pessoas.
//
// Os votos vêm de tse_urnas (o boletim de cada urna, carregado pelo botão
// "Importar votos do TSE"); a rede vem da mesma consulta da pirâmide.

const { votosDaEquipe, votosDaRede, inteiro } = require('../utils/atribuicao');

const NIVEIS_COM_META = [1, 2, 3];

// Linhas por urna do escopo da campanha (um município, os municípios-alvo ou o
// estado). Guardadas 1 minuto: abrir o relatório, filtrar e exportar em
// seguida não refaz a soma. A chave muda quando a carga do estado avança.
const cacheUrnas = new Map();
async function urnasDoCandidato(d) {
  const { rows: and } = await pool.query(
    'SELECT coletadas, atualizado_em FROM tse_coletas WHERE ciclo = $1 AND pleito = $2 AND uf = $3', [d.ciclo, d.pleito, d.uf]
  );
  const municipios = d.abrangencia === 'estado' ? null : d.municipios.map((m) => m.codigo);
  const chave = JSON.stringify([d.ciclo, d.pleito, d.eleicao, d.uf, d.cargo, d.numero, municipios,
    and[0] ? `${and[0].coletadas}|${and[0].atualizado_em.toISOString()}` : '']);
  const c = cacheUrnas.get(chave);
  if (c && c.expira > Date.now()) return c.valor;

  const cand = await tse.candidatosCargo({
    ciclo: d.ciclo, eleicao: d.eleicao, uf: d.uf, cargo: d.cargo,
    municipio: campanha.MUNICIPAIS.includes(d.cargo) ? municipios?.[0] : null,
  }).catch(() => null);
  // Mesmo critério do TSE usado em Votos por Seção: voto em número fora da
  // lista oficial (registro negado/anulado) é nulo; sub judice fica à parte.
  const lista = cand?.candidatos || null;
  const validos = lista && lista.filter((x) => x.valido).map((x) => x.numero);
  const subJudice = lista ? lista.filter((x) => x.subJudice).map((x) => x.numero) : [];
  const { rows } = await pool.query(
    `SELECT u.municipio, u.zona, u.secao, u.aptos, u.comparecimento,
            x.votos,
            COALESCE((c.j->>'vv')::int, 0) - a.anul - a.sj AS vv,
            COALESCE((c.j->>'b')::int, 0) AS brancos,
            COALESCE((c.j->>'n')::int, 0) + a.anul AS nulos,
            l.local_numero, l.local_nome, l.bairro, l.endereco, l.lat, l.lng
       FROM tse_urnas u
       CROSS JOIN LATERAL (SELECT u.cargos->$4 AS j OFFSET 0) c
       CROSS JOIN LATERAL (SELECT COALESCE((c.j->'v'->>$5)::int, 0) AS votos) x
       CROSS JOIN LATERAL (SELECT
           CASE WHEN $8::text[] IS NULL THEN 0 ELSE COALESCE((SELECT sum(x::int) FROM jsonb_array_elements_text(
             jsonb_path_query_array((c.j->'v') - $8::text[] - $9::text[], '$.*')) x), 0)::int END AS anul,
           COALESCE((SELECT sum((c.j->'v'->>k)::int) FROM unnest($9::text[]) k), 0)::int AS sj) a
       LEFT JOIN tse_locais l ON l.ano = $6 AND l.uf = u.uf AND l.zona = u.zona AND l.secao = u.secao
      WHERE u.ciclo = $1 AND u.pleito = $2 AND u.uf = $3 AND c.j IS NOT NULL
        AND ($7::text[] IS NULL OR u.municipio = ANY($7))`,
    [d.ciclo, d.pleito, d.uf, String(d.cargo), d.numero, (await votosSecao.anoLocais(d.ano, d.uf)) || d.ano, municipios, validos, subJudice]
  );
  const munNomes = new Map((await tse.municipiosEleicao(d.ciclo, d.eleicao, d.uf).catch(() => [])).map((m) => [m.codigo, m.nome]));
  const urnas = new Map();
  for (const r of rows) {
    urnas.set(`${r.zona}|${r.secao}`, {
      chave: `${r.zona}|${r.secao}`, municipio: r.municipio, municipioNome: munNomes.get(r.municipio) || r.municipio,
      zona: r.zona, secao: r.secao, aptos: r.aptos || 0, comparecimento: r.comparecimento || 0,
      votos: r.votos, vv: Math.max(0, r.vv), brancos: r.brancos, nulos: r.nulos,
      local: r.local_nome || null, localNumero: r.local_numero || null, bairro: r.bairro || 'Bairro não informado',
      endereco: r.endereco || null, lat: r.lat, lng: r.lng,
    });
  }
  // Senador em 2026 elege dois: cada eleitor vota duas vezes no cargo, e
  // brancos + nulos chegam a ser o dobro do comparecimento.
  const valor = { urnas, votosPorEleitor: d.cargo === 5 && cand?.vagas === 2 ? 2 : 1, oficial: lista && lista.find((x) => x.numero === d.numero) };
  if (cacheUrnas.size > 30) cacheUrnas.delete(cacheUrnas.keys().next().value);
  cacheUrnas.set(chave, { valor, expira: Date.now() + 60 * 1000 });
  return valor;
}

function faixaDoSinal(pct, d) {
  if (pct == null) return 'cinza';
  if (pct >= d.faixa_verde) return 'verde';
  if (pct >= d.faixa_amarela) return 'amarelo';
  return 'vermelho';
}

function somar(lista) {
  const t = { aptos: 0, comparecimento: 0, votos: 0, vv: 0, brancos: 0, nulos: 0 };
  for (const u of lista) for (const k of Object.keys(t)) t[k] += u[k] || 0;
  return t;
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// filtros: { municipio, zona, bairro, nivel, nicho, lideranca }
// raiz: id da pessoa que está vendo (liderança/coordenador) — só a rede dela.
async function relatorio(candidatoId, { filtros = {}, raiz = null, detalhe = null, locais = false } = {}) {
  const d = await campanha.carregarDados(candidatoId);
  if (!d) return { semDados: true };
  if (!d.ciclo) return { semDados: false, dados: d, indisponivel: true };

  const [{ urnas, votosPorEleitor, oficial }, mapa, { rows: rede }] = await Promise.all([
    urnasDoCandidato(d),
    tse.configSecoes(d.ciclo, d.pleito, d.uf).catch(() => null),
    pool.query(SQL_ARVORE_CANDIDATO, [candidatoId]),
  ]);
  const { rows: nichosRows } = rede.length
    ? await pool.query('SELECT apoiador_id, nicho_id FROM apoiador_nichos WHERE apoiador_id = ANY($1)', [rede.map((a) => a.id)])
    : { rows: [] };
  const nichosDe = new Map();
  for (const r of nichosRows) {
    if (!nichosDe.has(r.apoiador_id)) nichosDe.set(r.apoiador_id, new Set());
    nichosDe.get(r.apoiador_id).add(r.nicho_id);
  }

  // Urna de cada pessoa (zona + seção principal). Seção agregada vota na urna
  // da principal. Quem mora em outro estado e não informou o município de
  // votação vota lá: fica fora.
  const urnaDe = new Map();
  let comSecao = 0;
  for (const a of rede) {
    const z = tse.pad4(a.zona); const s = tse.pad4(a.secao);
    if (!z || !s) continue;
    const est = String(a.estado || '').trim().toLowerCase();
    if (est && est !== d.uf && !a.municipio_votacao) continue;
    const loc = mapa?.secoes.get(`${z}|${s}`);
    if (mapa && !loc) continue;
    urnaDe.set(a.id, `${z}|${loc ? loc.principal : s}`);
    comSecao++;
  }
  // Cadastrados da rede INTEIRA em cada urna — a base da divisão dos votos.
  // Não depende de quem está vendo: o Líder que só vê a própria rede recebe a
  // mesma fatia que o candidato vê para ele.
  const cadastradosNaUrna = new Map();
  for (const k of urnaDe.values()) cadastradosNaUrna.set(k, (cadastradosNaUrna.get(k) || 0) + 1);

  // Filtros de território valem para as URNAS: "em Dourados", a entrega de
  // cada liderança conta só as seções de Dourados.
  const urnaNoFiltro = (k) => {
    const u = urnas.get(k);
    if (!u) return false;
    if (filtros.municipio && u.municipio !== filtros.municipio) return false;
    if (filtros.zona && u.zona !== tse.pad4(filtros.zona)) return false;
    if (filtros.bairro && u.bairro !== filtros.bairro) return false;
    return true;
  };

  // Pirâmide: mesma regra da árvore do sistema (parent_id, ou quem cadastrou
  // quando o cadastro ficou sem responsável).
  const porId = new Map(rede.map((a) => [a.id, a]));
  const filhos = new Map();
  for (const a of rede) {
    const pai = a.parent_id || a.cadastrado_por;
    if (!pai || pai === a.id) continue;
    if (!filhos.has(pai)) filhos.set(pai, []);
    filhos.get(pai).push(a.id);
  }
  const subarvore = (id) => {
    const vistos = new Set([id]); const pilha = [id];
    while (pilha.length) for (const f of filhos.get(pilha.pop()) || []) if (!vistos.has(f)) { vistos.add(f); pilha.push(f); }
    return vistos;
  };

  // Quem está vendo (liderança/coordenador) só enxerga a própria rede.
  const visiveis = raiz ? subarvore(raiz) : null;
  const filtroLider = filtros.lideranca && porId.has(filtros.lideranca) ? subarvore(filtros.lideranca) : null;

  const linhas = [];
  for (const a of rede) {
    if (!NIVEIS_COM_META.includes(a.nivel)) continue;
    const equipe = subarvore(a.id);
    // Quantos da equipe (ela mesma incluída: também vota) em cada urna.
    const naUrna = new Map();
    for (const id of equipe) { const k = urnaDe.get(id); if (k && urnaNoFiltro(k)) naUrna.set(k, (naUrna.get(k) || 0) + 1); }
    const urnasEquipe = new Set(naUrna.keys());
    let atribuidos = 0;
    for (const [k, n] of naUrna) atribuidos += votosDaEquipe(urnas.get(k).votos, cadastradosNaUrna.get(k), n);
    // Mesma base da "rede cadastrada": só quem está abaixo, sem a própria pessoa.
    const comSecaoEquipe = [...equipe].filter((id) => id !== a.id && urnaDe.has(id)).length;
    linhas.push({ a, equipe, urnasEquipe, naUrna, atribuidos, comSecaoEquipe });
  }

  // Trava: a soma do atribuído aos Líderes (e a dos Coordenadores, e a dos
  // Mobilizadores) não pode passar do que a rede pode ter dado, nem do total
  // importado do TSE no escopo. Pela regra da divisão isso não acontece; se um
  // dia acontecer (pirâmide com ciclo, alguém em duas equipes do mesmo nível),
  // a tela avisa em vez de mostrar número impossível calado.
  const urnasEscopo = [...urnas.keys()].filter(urnaNoFiltro);
  const totalImportado = urnasEscopo.reduce((t, k) => t + urnas.get(k).votos, 0);
  const atribuidosRede = urnasEscopo.reduce((t, k) => t + votosDaRede(urnas.get(k).votos, cadastradosNaUrna.get(k)), 0);
  const somaPorNivel = { 1: 0, 2: 0, 3: 0 };
  for (const l of linhas) somaPorNivel[l.a.nivel] += l.atribuidos;
  const PAPEL_PLURAL = { 1: 'Líderes', 2: 'Coordenadores', 3: 'Mobilizadores' };
  const alertas = NIVEIS_COM_META
    .filter((n) => somaPorNivel[n] > Math.min(atribuidosRede, totalImportado) + 0.5)
    .map((n) => `A soma dos ${PAPEL_PLURAL[n]} (${inteiro(somaPorNivel[n])}) passou do total de votos do candidato nestas seções (${Math.min(atribuidosRede, totalImportado)}). Confira se alguém está em duas equipes ao mesmo tempo.`);

  // Seções compartilhadas: a mesma urna na área de duas pessoas do MESMO nível
  // (um líder sempre "compartilha" com os próprios coordenadores — isso não
  // conta; dois líderes diferentes na mesma seção, sim).
  const atuantes = new Map(); // nivel|urna → [ids]
  for (const l of linhas) {
    for (const k of l.urnasEquipe) {
      const ch = `${l.a.nivel}|${k}`;
      if (!atuantes.has(ch)) atuantes.set(ch, []);
      atuantes.get(ch).push(l.a.id);
    }
  }
  // Lideranças que votam/atuam em cada urna (para a lista de seções).
  const liderancasNaUrna = new Map();
  for (const l of linhas) {
    for (const k of l.urnasEquipe) {
      if (!liderancasNaUrna.has(k)) liderancasNaUrna.set(k, []);
      liderancasNaUrna.get(k).push(l.a.id);
    }
  }

  const resultado = [];
  for (const l of linhas) {
    const a = l.a;
    if (visiveis && !visiveis.has(a.id)) continue;
    if (filtroLider && !filtroLider.has(a.id)) continue;
    if (filtros.nivel && a.nivel !== Number(filtros.nivel)) continue;
    if (filtros.nicho && !(nichosDe.get(a.id) || new Set()).has(filtros.nicho)) continue;
    // Com filtro de território, quem não tem ninguém votando ali sai da lista.
    if ((filtros.municipio || filtros.zona || filtros.bairro) && !l.urnasEquipe.size) continue;
    const lista = [...l.urnasEquipe].map((k) => urnas.get(k));
    const t = somar(lista);
    const redeCadastrada = l.equipe.size - 1;
    const meta = a.meta_votos != null ? a.meta_votos : null;
    const votos = inteiro(l.atribuidos);
    const entrega = meta ? pct(votos, meta) : null;
    const compartilhadas = [...l.urnasEquipe].filter((k) => (atuantes.get(`${a.nivel}|${k}`) || []).length > 1);
    resultado.push({
      id: a.id, nome: a.nome, nivel: a.nivel, vinculo: !!a.vinculo,
      superior: (() => { const p = porId.get(a.parent_id || a.cadastrado_por); return p ? p.nome : null; })(),
      zona: tse.pad4(a.zona) || null, secao: tse.pad4(a.secao) || null,
      redeCadastrada, comSecao: l.comSecaoEquipe,
      meta, metaDeclarada: meta != null,
      secoesCobertas: l.urnasEquipe.size,
      // votos = atribuído à equipe; votosSecoes = total do candidato nas urnas.
      votos, votosSecoes: t.votos, entrega,
      pctSecao: pct(t.votos, t.vv),
      brancos: t.brancos, nulos: t.nulos,
      pctBrancosNulos: pct(t.brancos + t.nulos, t.comparecimento * votosPorEleitor),
      aptos: t.aptos, comparecimento: t.comparecimento,
      compartilhadas: compartilhadas.length,
      sinal: l.urnasEquipe.size && meta ? faixaDoSinal(entrega, d) : 'cinza',
      secoes: [...l.urnasEquipe].sort(),
      secoesCompartilhadas: compartilhadas.sort(),
    });
    // Ficha de uma pessoa (pedido da dona do sistema, 05/10/2026: clicar no
    // apoiador e ler "cadastrou tantos, entregou tanto na seção Y"): seção
    // por seção, quantos da equipe dela votam ali e quem são.
    if (detalhe === a.id) {
      const porUrna = new Map();
      for (const id of l.equipe) {
        const k = urnaDe.get(id);
        if (!k || !l.urnasEquipe.has(k)) continue;
        if (!porUrna.has(k)) porUrna.set(k, []);
        porUrna.get(k).push(porId.get(id)?.nome);
      }
      const r = resultado[resultado.length - 1];
      r.semSecao = [...l.equipe].filter((id) => id !== a.id && !urnaDe.has(id)).map((id) => porId.get(id)?.nome).filter(Boolean);
      r.porSecao = [...porUrna.entries()].map(([k, nomesEquipe]) => {
        const u = urnas.get(k);
        return { ...u, cadastrados: nomesEquipe.length, pessoas: nomesEquipe.slice(0, 30),
          cadastradosRede: cadastradosNaUrna.get(k) || 0,
          atribuidos: inteiro(votosDaEquipe(u.votos, cadastradosNaUrna.get(k), l.naUrna.get(k) || 0)),
          pctSecao: pct(u.votos, u.vv), pctBrancosNulos: pct(u.brancos + u.nulos, u.comparecimento * votosPorEleitor),
          compartilhada: (atuantes.get(`${a.nivel}|${k}`) || []).length > 1 };
      }).sort((x, y) => y.cadastrados - x.cadastrados || y.votos - x.votos);
    }
  }
  resultado.sort((x, y) => (y.entrega ?? -1) - (x.entrega ?? -1) || y.votos - x.votos);
  // Filtrando por uma liderança, a linha dela é o TOTAL da rede dela e vai
  // para o topo (pedido da dona, 06/10/2026: "aqui não aparece o total por
  // líder"); antes ela se perdia no meio da equipe, ordenada por entrega.
  if (filtroLider) {
    const i = resultado.findIndex((r) => r.id === filtros.lideranca);
    if (i > 0) resultado.unshift(...resultado.splice(i, 1));
  }

  // Visão por zona e por seção: todas as seções do escopo (ou só as da rede
  // de quem está vendo), com aptos, comparecimento, votos, brancos e nulos,
  // ordenada pela maior taxa de brancos + nulos.
  let urnasVisao = [...urnas.keys()].filter(urnaNoFiltro);
  if (visiveis) {
    const daRede = new Set([...visiveis].map((id) => urnaDe.get(id)).filter(Boolean));
    urnasVisao = urnasVisao.filter((k) => daRede.has(k));
  }
  const nomes = new Map(rede.map((a) => [a.id, a.nome]));
  const secoes = urnasVisao.map((k) => {
    const u = urnas.get(k);
    const ids = liderancasNaUrna.get(k) || [];
    return {
      ...u, pctSecao: pct(u.votos, u.vv), pctBrancosNulos: pct(u.brancos + u.nulos, u.comparecimento * votosPorEleitor),
      cadastradosRede: cadastradosNaUrna.get(k) || 0,
      daRede: votosDaRede(u.votos, cadastradosNaUrna.get(k)),
      liderancas: ids.filter((id) => !visiveis || visiveis.has(id)).map((id) => nomes.get(id)),
      compartilhada: [1, 2, 3].some((n) => (atuantes.get(`${n}|${k}`) || []).length > 1),
    };
  }).sort((x, y) => (y.pctBrancosNulos ?? -1) - (x.pctBrancosNulos ?? -1));
  const zonasMap = new Map();
  for (const s of secoes) {
    const ch = `${s.municipio}|${s.zona}`;
    if (!zonasMap.has(ch)) zonasMap.set(ch, { municipio: s.municipio, municipioNome: s.municipioNome, zona: s.zona, secoes: 0, lista: [] });
    const z = zonasMap.get(ch); z.secoes++; z.lista.push(s);
  }
  const zonas = [...zonasMap.values()].map((z) => {
    const t = somar(z.lista);
    return { municipio: z.municipio, municipioNome: z.municipioNome, zona: z.zona, secoes: z.secoes, ...t,
      pctSecao: pct(t.votos, t.vv), pctBrancosNulos: pct(t.brancos + t.nulos, t.comparecimento * votosPorEleitor) };
  }).sort((x, y) => (y.pctBrancosNulos ?? -1) - (x.pctBrancosNulos ?? -1));

  const totais = somar(secoes);

  // Fase 2 (mapa): os mesmos números agrupados por local de votação (escola).
  // "Entrega no local" = votos ali ÷ soma das metas de quem vota ali.
  let locaisOut;
  if (locais) {
    const cad = new Map(); const meta = new Map(); const nomesNaUrna = new Map();
    for (const a of rede) {
      const k = urnaDe.get(a.id);
      if (!k || (visiveis && !visiveis.has(a.id))) continue;
      cad.set(k, (cad.get(k) || 0) + 1);
      if (NIVEIS_COM_META.includes(a.nivel) && a.meta_votos != null) meta.set(k, (meta.get(k) || 0) + a.meta_votos);
      if (NIVEIS_COM_META.includes(a.nivel)) { if (!nomesNaUrna.has(k)) nomesNaUrna.set(k, []); nomesNaUrna.get(k).push(a.nome); }
    }
    const so = filtroLider ? new Set([...filtroLider].map((id) => urnaDe.get(id)).filter(Boolean)) : null;
    const porLocal = new Map();
    for (const s of secoes) {
      if (so && !so.has(s.chave)) continue;
      const k = `${s.municipio}|${s.localNumero || s.zona}`;
      if (!porLocal.has(k)) {
        porLocal.set(k, {
          id: k, nome: s.local || `Zona ${s.zona}`, bairro: s.bairro, endereco: s.endereco, municipio: s.municipioNome,
          lat: s.lat, lng: s.lng, secoes: [], aptos: 0, comparecimento: 0, votos: 0, vv: 0, brancos: 0, nulos: 0,
          cadastrados: 0, meta: 0, liderancas: new Set(),
        });
      }
      const l = porLocal.get(k);
      l.secoes.push(`${s.zona}/${s.secao}`);
      for (const c of ['aptos', 'comparecimento', 'votos', 'vv', 'brancos', 'nulos']) l[c] += s[c] || 0;
      l.cadastrados += cad.get(s.chave) || 0;
      l.meta += meta.get(s.chave) || 0;
      (nomesNaUrna.get(s.chave) || []).forEach((n) => l.liderancas.add(n));
    }
    locaisOut = [...porLocal.values()].map((l) => {
      const entregaLocal = l.meta ? pct(l.votos, l.meta) : null;
      return {
        ...l, liderancas: [...l.liderancas].slice(0, 12), pctSecao: pct(l.votos, l.vv),
        pctBrancosNulos: pct(l.brancos + l.nulos, l.comparecimento * votosPorEleitor), entrega: entregaLocal,
        // vazio = escola sem ninguém da rede votando ali (vazio territorial).
        sinal: entregaLocal == null ? (l.cadastrados ? 'cinza' : 'vazio') : faixaDoSinal(entregaLocal, d),
      };
    });
  }
  const todasUrnas = [...urnas.values()];
  const municipiosDisp = [...new Map(todasUrnas.map((u) => [u.municipio, u.municipioNome])).entries()]
    .map(([codigo, nome]) => ({ codigo, nome })).sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'));
  const zonasDisp = [...new Set(todasUrnas.filter((u) => !filtros.municipio || u.municipio === filtros.municipio).map((u) => u.zona))].sort();
  const bairrosDisp = [...new Set(todasUrnas.filter((u) => (!filtros.municipio || u.municipio === filtros.municipio) && (!filtros.zona || u.zona === tse.pad4(filtros.zona))).map((u) => u.bairro))].sort((x, y) => x.localeCompare(y, 'pt-BR'));
  const { rows: nichos } = await pool.query('SELECT id, nome FROM nichos WHERE candidato_id = $1 ORDER BY nome', [candidatoId]);

  return {
    dados: { nome: d.nome_urna || d.nome_candidato, numero: d.numero, partido: d.partido, cargo: d.cargo_nome, ano: d.ano, turno: d.turno,
      uf: d.uf, abrangencia: d.abrangencia, municipios: d.municipios, faixaVerde: d.faixa_verde, faixaAmarela: d.faixa_amarela },
    aviso: 'Indica a entrega da área de influência, não o voto individual.',
    urnasCarregadas: urnas.size,
    totalOficial: oficial ? oficial.votos : null,
    rede: { total: visiveis ? visiveis.size - 1 : rede.length, comSecao: visiveis ? [...visiveis].filter((id) => urnaDe.has(id)).length : comSecao },
    totais: { ...totais, pctBrancosNulos: pct(totais.brancos + totais.nulos, totais.comparecimento * votosPorEleitor), secoes: secoes.length },
    // Escopo = as seções dos filtros de território (município, zona, bairro),
    // da rede inteira do candidato. foraDaRede = votos que nenhuma equipe pode
    // reivindicar: urna sem ninguém da rede, ou mais votos que cadastrados.
    atribuicao: {
      totalImportado, atribuidosRede, foraDaRede: totalImportado - atribuidosRede,
      somaPorNivel: Object.fromEntries(NIVEIS_COM_META.map((n) => [n, inteiro(somaPorNivel[n])])),
      alertas,
    },
    liderancas: resultado,
    zonas, secoes, locais: locaisOut,
    filtrosDisponiveis: { municipios: municipiosDisp, zonas: zonasDisp, bairros: bairrosDisp, nichos,
      liderancas: rede.filter((a) => a.nivel === 1 && (!visiveis || visiveis.has(a.id))).map((a) => ({ id: a.id, nome: a.nome })) },
  };
}

module.exports = { relatorio, urnasDoCandidato };
