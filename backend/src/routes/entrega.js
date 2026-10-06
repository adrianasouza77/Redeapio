const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const jsonComprimido = require('../utils/jsonComprimido');
const { nivelUsuario } = require('../utils/nivelUsuario');
const entrega = require('../services/entrega');
const apuracao = require('../services/apuracao');
const campanha = require('../services/campanha');
const { SQL_ARVORE_CANDIDATO } = require('./apoiadores');

// Relatório "Prometido × Entregue". Quem vê o quê (briefing "Votos por
// seção" v2, item 6, e seção 7):
//  - candidato (e o admin no workspace dele): a rede inteira;
//  - Coordenador Geral: a rede inteira de qualquer candidato da rede dele;
//  - Líder e Coordenador (níveis 1 e 2): só a própria rede, abaixo deles, em
//    cada candidato a que estão ligados;
//  - Mobilizador e Apoiador: não acessam.
const router = express.Router();
router.use(authRequired, resolveWorkspace);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Candidatos que quem está logado pode abrir no relatório, cada um com a
// "raiz" (null = rede inteira; id da pessoa = só a rede abaixo dela).
async function candidatosVisiveis(req) {
  if (req.effectivePerfil === 'candidato') {
    const { rows } = await pool.query('SELECT id, nome FROM usuarios WHERE id = $1', [req.effectiveId]);
    return rows.map((c) => ({ ...c, raiz: null }));
  }
  if (req.user.perfil === 'coordenador_geral') {
    const { rows } = await pool.query(
      `SELECT u.id, u.nome FROM usuarios u JOIN redes r ON r.id = u.rede_id
        WHERE r.coordenador_geral_id = $1 AND u.perfil = 'candidato' ORDER BY u.nome`, [req.user.id]
    );
    return rows.map((c) => ({ ...c, raiz: null }));
  }
  if (req.user.perfil === 'lideranca' || req.user.perfil === 'apoiador') {
    const out = [];
    const nivel = await nivelUsuario(req.user);
    if (nivel === 1 || nivel === 2) {
      const { rows } = await pool.query('SELECT id, nome FROM usuarios WHERE id = $1', [req.user.criado_por]);
      if (rows[0]) out.push({ ...rows[0], raiz: req.user.id, nivel });
    }
    // Outros candidatos da rede em que a pessoa tem vínculo como Líder ou Coordenador.
    const { rows: v } = await pool.query(
      `SELECT u.id, u.nome, v.nivel FROM apoiador_candidatos v JOIN usuarios u ON u.id = v.candidato_id
        WHERE v.apoiador_id = $1 AND v.ativo AND v.nivel IN (1, 2) ORDER BY u.nome`, [req.user.id]
    );
    for (const c of v) if (!out.some((o) => o.id === c.id)) out.push({ id: c.id, nome: c.nome, raiz: req.user.id, nivel: c.nivel });
    return out;
  }
  return [];
}

async function escolher(req, res) {
  const lista = await candidatosVisiveis(req);
  if (!lista.length) {
    res.status(403).json({ error: 'O relatório Prometido × Entregue é do candidato, do Coordenador Geral e de Líderes e Coordenadores.' });
    return null;
  }
  const pedido = req.query.candidato && UUID.test(req.query.candidato) ? req.query.candidato : null;
  const c = pedido ? lista.find((x) => x.id === pedido) : lista[0];
  if (!c) { res.status(404).json({ error: 'Candidato fora do seu alcance.' }); return null; }
  return { c, lista };
}

function filtrosDe(q) {
  const f = {};
  if (q.municipio && /^\d{5}$/.test(q.municipio)) f.municipio = q.municipio;
  if (q.zona && /^\d{1,4}$/.test(q.zona)) f.zona = q.zona;
  if (q.bairro) f.bairro = String(q.bairro).slice(0, 120);
  if (q.nivel && /^[1-3]$/.test(q.nivel)) f.nivel = Number(q.nivel);
  if (q.nicho && UUID.test(q.nicho)) f.nicho = q.nicho;
  if (q.lideranca && UUID.test(q.lideranca)) f.lideranca = q.lideranca;
  return f;
}

router.get('/', asyncHandler(async (req, res) => {
  const e = await escolher(req, res);
  if (!e) return;
  const r = await entrega.relatorio(e.c.id, { filtros: filtrosDe(req.query), raiz: e.c.raiz, locais: req.query.locais === '1' });
  res.json({ ...r, candidato: { id: e.c.id, nome: e.c.nome }, candidatos: e.lista.map(({ id, nome }) => ({ id, nome })), restrito: !!e.c.raiz });
}));

// Ficha de uma pessoa: o que prometeu × o que entregou, seção por seção, em
// cada candidato da rede a que ela está ligada (quem pode ver mais de um vê
// todos de uma vez, sem trocar de candidato).
router.get('/pessoa/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID.test(id)) return res.status(400).json({ error: 'Pessoa inválida.' });
  const lista = await candidatosVisiveis(req);
  if (!lista.length) return res.status(403).json({ error: 'Sem acesso ao relatório.' });

  // Candidatos em que a pessoa está: o "de casa" e os vínculos.
  const { rows: ligados } = await pool.query(
    `SELECT candidato_id FROM apoiador_candidatos WHERE apoiador_id = $1 AND ativo`, [id]
  );
  const ids = new Set(ligados.map((r) => r.candidato_id));
  const fichas = [];
  for (const c of lista) {
    const r = await entrega.relatorio(c.id, { raiz: c.raiz, detalhe: id });
    if (r.semDados || r.indisponivel) {
      if (ids.has(c.id) || lista.length === 1) fichas.push({ candidato: { id: c.id, nome: c.nome }, semDados: !!r.semDados, indisponivel: !!r.indisponivel });
      continue;
    }
    const linha = r.liderancas.find((x) => x.id === id);
    if (linha) fichas.push({ candidato: { id: c.id, nome: c.nome }, dados: r.dados, linha });
  }
  if (!fichas.length) return res.status(404).json({ error: 'Essa pessoa não tem meta nesta rede (só Líder, Coordenador e Mobilizador têm).' });
  res.json({ aviso: 'Indica a entrega da área de influência, não o voto individual.', fichas });
}));

// Entrega de cada pessoa com os votos da APURAÇÃO AO VIVO — é o que aparece no
// cartão da pirâmide (pedido da dona do sistema, 05/10/2026: "no mesmo lugar
// onde aparece o nome da pessoa, com a equipe, apareça a zona, a seção,
// quantos cadastros, quanto teve de resultado e o que bateu"). A apuração ao
// vivo só busca as seções das zonas onde a rede tem gente: nada de baixar o
// estado inteiro. Candidato vê todos; Líder e Coordenador, a própria rede;
// Mobilizador e Apoiador, nada (mesma regra do relatório).
// Linhas da apuração ao vivo que quem pediu pode ver (null = sem acesso).
async function linhasAoVivo(req) {
  const candidatoId = campanha.candidatoDoPedido(req);
  if (!candidatoId) return { ativo: false };
  let raiz = null;
  if (req.effectivePerfil !== 'candidato') {
    const nivel = await nivelUsuario(req.user);
    if (nivel !== 1 && nivel !== 2) return { ativo: false };
    raiz = req.user.id;
  }
  const p = await apuracao.painel(candidatoId);
  if (!p.config || !p.metas) return { ativo: false, configurado: !!p.config, erro: p.erro || null };
  let linhas = p.metas.porResponsavel;
  if (raiz) {
    const { rows: rede } = await pool.query(`SELECT id, parent_id, cadastrado_por FROM (${SQL_ARVORE_CANDIDATO}) r`, [candidatoId]);
    const filhos = new Map();
    for (const a of rede) {
      const pai = a.parent_id || a.cadastrado_por;
      if (!pai || pai === a.id) continue;
      if (!filhos.has(pai)) filhos.set(pai, []);
      filhos.get(pai).push(a.id);
    }
    const vistos = new Set([raiz]); const pilha = [raiz];
    while (pilha.length) for (const f of filhos.get(pilha.pop()) || []) if (!vistos.has(f)) { vistos.add(f); pilha.push(f); }
    linhas = linhas.filter((l) => vistos.has(l.id));
  }
  const d = await campanha.carregarDados(candidatoId);
  return {
    ativo: true,
    aviso: 'Indica a entrega da área de influência, não o voto individual.',
    faixas: { verde: d?.faixa_verde ?? 80, amarela: d?.faixa_amarela ?? 50 },
    candidato: { cargo: p.config.cargo, numero: p.config.numero, ultimaBusca: p.config.ultimaBusca },
    linhas,
  };
}

// Os cartões da pirâmide só usam os totais de cada pessoa. Até 06/10/2026 esta
// rota mandava também, para cada Líder/Coordenador/Mobilizador, a lista seção
// por seção com o nome de cada pessoa da equipe — quem está na base aparecia
// na lista de cada superior. Numa rede de 4 mil pessoas eram ~1,6 MB a cada
// abertura da pirâmide, e no 4G chegava cortado ("Load failed"). Agora vão só
// os totais (~5 KB comprimido); a lista vem em /ao-vivo/pessoa/:id, ao clicar.
router.get('/ao-vivo', asyncHandler(async (req, res) => {
  const r = await linhasAoVivo(req);
  if (!r.ativo) return res.json(r);
  const { linhas, ...resto } = r;
  jsonComprimido(req, res, { ...resto, pessoas: linhas.map(({ secoesDetalhe, secoes, ...l }) => l) });
}));

// Ficha de uma pessoa (o clique no cartão): a lista seção por seção, com os
// nomes de quem da equipe vota em cada uma. Mesma regra de acesso da lista.
router.get('/ao-vivo/pessoa/:id', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Pessoa inválida.' });
  const r = await linhasAoVivo(req);
  if (!r.ativo) return res.status(404).json({ error: 'Configure a Apuração ao Vivo para ver a entrega de cada pessoa.' });
  const linha = r.linhas.find((l) => l.id === req.params.id);
  if (!linha) return res.status(404).json({ error: 'Essa pessoa não tem meta (só Líder, Coordenador e Mobilizador) ou está fora da sua rede.' });
  jsonComprimido(req, res, { aviso: r.aviso, faixas: r.faixas, pessoa: linha });
}));

module.exports = router;
