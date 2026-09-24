const pool = require('../db');
const tse = require('./tse');
const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');
const { anexarNichos, nichosDoCandidato } = require('../utils/nichos');

// Desempenho eleitoral histórico (Tela 5 da especificação): cruza o resultado
// oficial de uma eleição passada, município a município, com a rede que o
// candidato tem hoje em cada um. Responde "onde eu fui bem, onde fui mal, e
// onde a minha rede é pequena para o voto que eu já tive (ou vice-versa)".

// Eleições com resultado por município no portal do TSE, conferidas uma a
// uma em set/2026. Anos anteriores a 2022 usam outro formato de arquivo.
const ELEICOES = [
  { ciclo: 'ele2024', eleicao: '619', nome: '2024 · 1º turno (prefeito e vereador)', cargos: ['11', '13'] },
  { ciclo: 'ele2024', eleicao: '620', nome: '2024 · 2º turno (prefeito)', cargos: ['11'] },
  { ciclo: 'ele2022', eleicao: '546', nome: '2022 · 1º turno (governador, senador, deputados)', cargos: ['3', '5', '6', '7', '8'] },
  { ciclo: 'ele2022', eleicao: '547', nome: '2022 · 2º turno (governador)', cargos: ['3'] },
  { ciclo: 'ele2022', eleicao: '544', nome: '2022 · 1º turno (presidente)', cargos: ['1'] },
  { ciclo: 'ele2022', eleicao: '545', nome: '2022 · 2º turno (presidente)', cargos: ['1'] },
];
const CARGOS = { 1: 'Presidente', 3: 'Governador', 5: 'Senador', 6: 'Deputado Federal', 7: 'Deputado Estadual', 8: 'Deputado Distrital', 11: 'Prefeito', 13: 'Vereador' };

// Quantos municípios a visão geral carrega de uma vez. Cada um é um arquivo
// do TSE na primeira vez (depois fica no banco); rede espalhada por 300
// cidades não pode travar a tela esperando 300 downloads.
const MAX_MUNICIPIOS = 60;

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();

async function carregarConfig(candidatoId) {
  const { rows } = await pool.query('SELECT * FROM historico_config WHERE candidato_id = $1', [candidatoId]);
  return rows[0] || null;
}

// Resultado de um município: do banco se já foi baixado (dado de eleição
// encerrada não muda), senão do TSE, gravando para a próxima vez.
async function resultadoDoMunicipio(cfg, municipio) {
  const chave = [cfg.ciclo, cfg.eleicao, municipio, cfg.cargo];
  const { rows } = await pool.query(
    `SELECT numero, nome, partido, votos, posicao, eleito FROM resultado_urna
      WHERE ciclo = $1 AND eleicao = $2 AND municipio = $3 AND cargo = $4 ORDER BY posicao NULLS LAST, votos DESC`,
    chave
  );
  if (rows.length) {
    const { rows: tot } = await pool.query(
      'SELECT aptos FROM resultado_urna_municipio WHERE ciclo = $1 AND eleicao = $2 AND municipio = $3 AND cargo = $4',
      chave
    );
    return { candidatos: rows, aptos: tot[0]?.aptos ?? null };
  }
  const r = await tse.resultadoMunicipio({ ciclo: cfg.ciclo, eleicao: cfg.eleicao, uf: cfg.uf, municipio, cargo: cfg.cargo });
  if (!r) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of r.candidatos) {
      await client.query(
        `INSERT INTO resultado_urna (ciclo, eleicao, municipio, cargo, numero, nome, partido, votos, posicao, eleito)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [...chave, c.numero, c.nome, c.partido, c.votos, c.posicao, c.eleito]
      );
    }
    await client.query(
      `INSERT INTO resultado_urna_municipio (ciclo, eleicao, municipio, cargo, aptos)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [...chave, r.aptos]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  r.candidatos.sort((a, b) => (a.posicao ?? 1e9) - (b.posicao ?? 1e9) || b.votos - a.votos);
  return r;
}

// A rede de hoje, agrupada pelo código TSE do município. O cadastro guarda a
// cidade como texto digitado; casa pelo nome sem acento, dentro do estado.
async function redePorMunicipio(cfg) {
  const { rows } = await pool.query(
    `SELECT id, nome, nivel, cidade, estado, regiao, zona FROM (${SQL_ARVORE_CANDIDATO}) r`, [cfg.candidato_id]
  );
  await anexarNichos(rows);
  const municipios = await tse.municipiosEleicao(cfg.ciclo, cfg.eleicao, cfg.uf);
  const porNome = new Map(municipios.map((m) => [semAcento(m.nome), m]));
  const grupos = new Map();
  let semMunicipio = 0;
  for (const a of rows) {
    const uf = String(a.estado || '').trim().toLowerCase();
    const m = (!uf || uf === cfg.uf) ? porNome.get(semAcento(a.cidade)) : null;
    if (!m) { semMunicipio++; continue; }
    if (!grupos.has(m.codigo)) grupos.set(m.codigo, { municipio: m, pessoas: [] });
    grupos.get(m.codigo).pessoas.push(a);
  }
  return { grupos, municipios, semMunicipio };
}

// Liderança formal = Líder ou Coordenador (níveis 1 e 2), como pede a
// especificação ("zona sem Coordenador ou Liderança").
const ehLideranca = (a) => a.nivel === 1 || a.nivel === 2;

function resumoCandidato(cfg, r) {
  if (!r) return null;
  const eu = r.candidatos.find((c) => c.numero === cfg.numero);
  const primeiro = r.candidatos[0] || null;
  const proximo = eu && eu.posicao ? r.candidatos.find((c) => c.posicao === eu.posicao - 1) : null;
  return {
    votos: eu ? eu.votos : 0,
    posicao: eu ? eu.posicao : null,
    eleito: eu ? eu.eleito : false,
    totalCandidatos: r.candidatos.length,
    primeiro: primeiro && primeiro.numero !== cfg.numero ? { numero: primeiro.numero, nome: primeiro.nome, votos: primeiro.votos } : null,
    acima: proximo ? { numero: proximo.numero, nome: proximo.nome, votos: proximo.votos } : null,
    aptos: r.aptos,
  };
}

async function visaoGeral(candidatoId) {
  const cfg = await carregarConfig(candidatoId);
  if (!cfg) return { config: null };
  const { grupos, semMunicipio } = await redePorMunicipio(cfg);
  const lista = [...grupos.values()].sort((a, b) => b.pessoas.length - a.pessoas.length);
  const alvo = lista.slice(0, MAX_MUNICIPIOS);
  const linhas = [];
  let erro = null;
  // Poucos downloads em paralelo: o TSE aguenta, mas não precisa de rajada.
  for (let i = 0; i < alvo.length; i += 4) {
    const lote = alvo.slice(i, i + 4);
    const res = await Promise.all(lote.map((g) => resultadoDoMunicipio(cfg, g.municipio.codigo).catch((e) => { erro = e.message; return null; })));
    lote.forEach((g, k) => {
      linhas.push({
        codigo: g.municipio.codigo, nome: g.municipio.nome,
        cadastrados: g.pessoas.length, liderancas: g.pessoas.filter(ehLideranca).length,
        resultado: resumoCandidato(cfg, res[k]),
      });
    });
  }
  return { config: publicarConfig(cfg), municipios: linhas, semMunicipio, foraDoLimite: Math.max(0, lista.length - alvo.length), erro };
}

async function detalhe(candidatoId, codigo) {
  const cfg = await carregarConfig(candidatoId);
  if (!cfg) return null;
  const [{ grupos, municipios }, r, nichos] = await Promise.all([
    redePorMunicipio(cfg), resultadoDoMunicipio(cfg, codigo), nichosDoCandidato(candidatoId),
  ]);
  const municipio = municipios.find((m) => m.codigo === codigo) || { codigo, nome: codigo };
  const pessoas = grupos.get(codigo)?.pessoas || [];
  const nomeNicho = new Map(nichos.map((n) => [n.id, n.nome]));

  const contar = (fn) => {
    const m = new Map();
    for (const p of pessoas) for (const k of [].concat(fn(p))) m.set(k, (m.get(k) || 0) + 1);
    return [...m.entries()].map(([nome, qtd]) => ({ nome, qtd })).sort((a, b) => b.qtd - a.qtd);
  };
  // Território sem liderança formal: tem gente da rede, mas ninguém de nível 1 ou 2.
  const territorios = (campo) => {
    const m = new Map();
    for (const p of pessoas) {
      const k = String(p[campo] || '').trim();
      if (!k) continue;
      if (!m.has(k)) m.set(k, { nome: k, cadastrados: 0, liderancas: 0 });
      const t = m.get(k);
      t.cadastrados++;
      if (ehLideranca(p)) t.liderancas++;
    }
    return [...m.values()].sort((a, b) => b.cadastrados - a.cadastrados);
  };

  // Concorrentes: os 10 primeiros e, se o candidato ficou mais abaixo, os
  // vizinhos dele no ranking — é com esses que ele disputa de verdade.
  let concorrentes = [];
  if (r) {
    const eu = r.candidatos.find((c) => c.numero === cfg.numero);
    const topo = r.candidatos.slice(0, 10);
    const vizinhos = eu && eu.posicao > 10 ? r.candidatos.filter((c) => Math.abs((c.posicao || 0) - eu.posicao) <= 2) : [];
    const vistos = new Set();
    concorrentes = [...topo, ...vizinhos].filter((c) => !vistos.has(c.numero) && vistos.add(c.numero))
      .map((c) => ({ ...c, eu: c.numero === cfg.numero }));
  }

  return {
    config: publicarConfig(cfg),
    municipio,
    resultado: resumoCandidato(cfg, r),
    concorrentes,
    semResultado: !r,
    rede: {
      cadastrados: pessoas.length,
      porNivel: [1, 2, 3, 4].map((n) => ({ nivel: n, qtd: pessoas.filter((p) => p.nivel === n).length })),
      porNicho: contar((p) => (p.nichos.length ? p.nichos.map((id) => nomeNicho.get(id) || '—') : ['Sem nicho'])),
      bairros: territorios('regiao'),
      zonas: territorios('zona'),
    },
  };
}

function publicarConfig(cfg) {
  const el = ELEICOES.find((e) => e.ciclo === cfg.ciclo && e.eleicao === cfg.eleicao);
  return {
    ciclo: cfg.ciclo, eleicao: cfg.eleicao, uf: cfg.uf, cargo: cfg.cargo, numero: cfg.numero,
    nomeEleicao: el ? el.nome : `${cfg.ciclo} (${cfg.eleicao})`, nomeCargo: CARGOS[cfg.cargo] || cfg.cargo,
  };
}

module.exports = { ELEICOES, CARGOS, carregarConfig, visaoGeral, detalhe, resultadoDoMunicipio, redePorMunicipio };