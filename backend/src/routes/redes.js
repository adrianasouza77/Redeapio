const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const { hash, gerarSenhaTemporaria } = require('../utils/password');
const { SQL_ARVORE_CANDIDATO } = require('./apoiadores');
const campanha = require('../services/campanha');
const importacao = require('../services/importacao');
const entrega = require('../services/entrega');

// Rede com vários candidatos sob um Coordenador Geral (briefing "Votos por
// seção" v2, seção 7). Hierarquia: Coordenador Geral (rede) → Candidatos →
// Líder → Coordenador → Mobilizador → Apoiador Orgânico. Cada pessoa é
// cadastrada uma vez e pode apoiar mais de um candidato (apoiador_candidatos).
//
// Permissões: o Coordenador Geral vê a rede inteira; cada candidato vê só a
// própria rede e os próprios votos — os outros candidatos só se o Coordenador
// Geral liberar (usuarios.rede_ver_outros).
const router = express.Router();
router.use(authRequired, resolveWorkspace);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rede de quem está pedindo e se ele pode ver todos os candidatos dela.
async function redeDoPedido(req) {
  if (req.user.perfil === 'coordenador_geral') {
    const { rows } = await pool.query('SELECT * FROM redes WHERE coordenador_geral_id = $1 ORDER BY created_at LIMIT 1', [req.user.id]);
    return rows[0] ? { rede: rows[0], verTodos: true, gestor: true } : null;
  }
  if (req.effectivePerfil === 'candidato') {
    const { rows } = await pool.query(
      `SELECT r.*, u.rede_ver_outros FROM usuarios u JOIN redes r ON r.id = u.rede_id WHERE u.id = $1`, [req.effectiveId]
    );
    if (!rows[0]) return null;
    // O admin, dentro do workspace, enxerga como o dono da rede.
    return { rede: rows[0], verTodos: rows[0].rede_ver_outros || req.user.perfil === 'admin', gestor: false };
  }
  return null;
}

async function candidatosDaRede(redeId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.nome, u.login, u.email, u.rede_ver_outros, d.cargo, d.numero, d.partido, d.ano, d.uf, d.nome_urna, d.abrangencia
       FROM usuarios u LEFT JOIN candidato_dados d ON d.candidato_id = u.id
      WHERE u.rede_id = $1 AND u.perfil = 'candidato' ORDER BY u.created_at`, [redeId]
  );
  return rows.map((c) => ({ ...c, cargo_nome: c.cargo ? campanha.CARGOS[c.cargo] : null }));
}

// Pessoas ligadas a dois candidatos do MESMO cargo: o eleitor vota uma vez por
// cargo, então as duas metas competem entre si. Federal + estadual
// ("dobradinha") é permitido e não entra aqui.
async function alertasMesmoCargo(redeId, apoiadorId = null) {
  const cands = await candidatosDaRede(redeId);
  const cargoDe = new Map(cands.map((c) => [c.id, c]));
  const pessoas = new Map(); // apoiador → [candidato ids]
  for (const c of cands) {
    const { rows } = await pool.query(`SELECT id, nome FROM (${SQL_ARVORE_CANDIDATO}) r`, [c.id]);
    for (const a of rows) {
      if (apoiadorId && a.id !== apoiadorId) continue;
      if (!pessoas.has(a.id)) pessoas.set(a.id, { nome: a.nome, candidatos: [] });
      pessoas.get(a.id).candidatos.push(c.id);
    }
  }
  const alertas = [];
  for (const [id, p] of pessoas) {
    const porCargo = new Map();
    for (const cid of p.candidatos) {
      const c = cargoDe.get(cid);
      if (!c || !c.cargo) continue;
      if (!porCargo.has(c.cargo)) porCargo.set(c.cargo, []);
      porCargo.get(c.cargo).push(c.nome_urna || c.nome);
    }
    for (const [cargo, nomes] of porCargo) {
      if (nomes.length > 1) alertas.push({ apoiador_id: id, nome: p.nome, cargo: campanha.CARGOS[cargo], candidatos: nomes });
    }
  }
  return alertas;
}

router.get('/', asyncHandler(async (req, res) => {
  const r = await redeDoPedido(req);
  if (!r) return res.json({ rede: null });
  const cands = await candidatosDaRede(r.rede.id);
  const visiveis = r.verTodos ? cands : cands.filter((c) => c.id === req.effectiveId);
  const out = [];
  for (const c of visiveis) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM (${SQL_ARVORE_CANDIDATO}) r`, [c.id]);
    out.push({ ...c, redeCadastrada: rows[0].n, importacao: await importacao.ultima(c.id) });
  }
  const { rows: cg } = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [r.rede.coordenador_geral_id]);
  res.json({
    rede: { id: r.rede.id, nome: r.rede.nome, coordenadorGeral: cg[0]?.nome || null },
    gestor: r.gestor, verTodos: r.verTodos, candidatos: out,
    alertas: r.verTodos ? await alertasMesmoCargo(r.rede.id) : [],
  });
}));

router.put('/', requireRole('coordenador_geral'), asyncHandler(async (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  if (nome.length < 3) return res.status(400).json({ error: 'Dê um nome à rede (ex.: "Grupo Dourados 2026").' });
  const r = await redeDoPedido(req);
  if (r) {
    await pool.query('UPDATE redes SET nome = $1 WHERE id = $2', [nome, r.rede.id]);
  } else {
    await pool.query('INSERT INTO redes (nome, coordenador_geral_id) VALUES ($1, $2)', [nome, req.user.id]);
  }
  await registrar(req, { acao: 'rede.salvar', alvoTipo: 'config', alvoNome: nome, candidatoId: null });
  res.json({ ok: true });
}));

// O Coordenador Geral cadastra os candidatos da rede (manual do cliente,
// passo 2). Mesma senha temporária do cadastro feito pelo admin.
router.post('/candidatos', requireRole('coordenador_geral'), asyncHandler(async (req, res) => {
  const r = await redeDoPedido(req);
  if (!r) return res.status(400).json({ error: 'Crie a rede primeiro.' });
  const nome = String(req.body?.nome || '').trim();
  const login = String(req.body?.login || '').trim().toLowerCase();
  const email = String(req.body?.email || '').trim().toLowerCase() || null;
  if (!nome) return res.status(400).json({ error: 'Informe o nome do candidato.' });
  if (!/^[a-z0-9._-]{3,}$/.test(login)) return res.status(400).json({ error: 'Login: só letras minúsculas, números, ponto, hífen ou underline (mínimo 3).' });
  const senha = gerarSenhaTemporaria();
  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, login, senha_hash, perfil, email, senha_temporaria, rede_id, criado_por)
       VALUES ($1,$2,$3,'candidato',$4,true,$5,NULL) RETURNING id, nome, login, email`,
      [nome, login, await hash(senha), email, r.rede.id]
    );
    await registrar(req, { acao: 'candidato.criar', alvoTipo: 'candidato', alvoId: rows[0].id, alvoNome: nome, detalhes: { login, rede: r.rede.nome, por: 'coordenador geral' }, candidatoId: rows[0].id });
    res.status(201).json({ ...rows[0], senha });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este login já existe.' });
    throw err;
  }
}));

// Liberar (ou não) um candidato para ver os outros candidatos da rede.
router.put('/candidatos/:id', requireRole('coordenador_geral'), asyncHandler(async (req, res) => {
  const r = await redeDoPedido(req);
  if (!r || !UUID.test(req.params.id)) return res.status(404).json({ error: 'Candidato não encontrado.' });
  const { rows } = await pool.query(
    `UPDATE usuarios SET rede_ver_outros = $1 WHERE id = $2 AND rede_id = $3 AND perfil = 'candidato' RETURNING nome`,
    [req.body?.ver_outros === true, req.params.id, r.rede.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Candidato não encontrado na sua rede.' });
  await registrar(req, { acao: 'rede.liberar', alvoTipo: 'candidato', alvoId: req.params.id, alvoNome: rows[0].nome, detalhes: { ver_outros: req.body?.ver_outros === true }, candidatoId: req.params.id });
  res.json({ ok: true });
}));

// "Importar todos": a importação de cada candidato da rede.
router.post('/importar-todos', requireRole('coordenador_geral'), asyncHandler(async (req, res) => {
  const r = await redeDoPedido(req);
  if (!r) return res.status(400).json({ error: 'Rede não encontrada.' });
  const out = [];
  for (const c of await candidatosDaRede(r.rede.id)) {
    try {
      const x = await importacao.iniciar(c.id, req.user);
      out.push({ candidato: c.nome_urna || c.nome, status: x.status, mensagem: x.mensagem || x.erro || null });
    } catch (e) {
      out.push({ candidato: c.nome_urna || c.nome, status: 'erro', mensagem: e.message });
    }
  }
  await registrar(req, { acao: 'rede.importar_todos', alvoTipo: 'config', alvoNome: r.rede.nome, detalhes: { resultado: out }, candidatoId: null });
  res.json({ resultado: out });
}));

// ─── Painel do Coordenador Geral ────────────────────────────────────────────

function filtroMunicipio(q) {
  return q.municipio && /^\d{5}$/.test(q.municipio) ? { municipio: q.municipio } : {};
}

// Candidatos lado a lado: votos, % de entrega e rede cadastrada, com filtro
// por município.
router.get('/painel', asyncHandler(async (req, res) => {
  const r = await redeDoPedido(req);
  if (!r || !r.verTodos) return res.status(403).json({ error: 'Só o Coordenador Geral (ou quem ele liberar) vê os candidatos lado a lado.' });
  const filtros = filtroMunicipio(req.query);
  const out = []; const municipios = new Map();
  for (const c of await candidatosDaRede(r.rede.id)) {
    const rel = await entrega.relatorio(c.id, { filtros });
    const base = { id: c.id, nome: c.nome_urna || c.nome, cargo: c.cargo_nome, numero: c.numero, partido: c.partido };
    if (rel.semDados || rel.indisponivel) { out.push({ ...base, semDados: !!rel.semDados, indisponivel: !!rel.indisponivel }); continue; }
    rel.filtrosDisponiveis.municipios.forEach((m) => municipios.set(m.codigo, m.nome));
    const lideres = rel.liderancas.filter((l) => l.nivel === 1);
    const metaTotal = lideres.reduce((s, l) => s + (l.meta || 0), 0);
    const daRede = new Set(rel.liderancas.flatMap((l) => l.secoes));
    const votosNaRede = rel.secoes.filter((s) => daRede.has(s.chave)).reduce((s, x) => s + x.votos, 0);
    out.push({
      ...base, votos: rel.totais.votos, totalOficial: rel.totalOficial, redeCadastrada: rel.rede.total, comSecao: rel.rede.comSecao,
      metaTotal, votosNaRede, entrega: metaTotal ? Math.round((votosNaRede / metaTotal) * 1000) / 10 : null,
      pctBrancosNulos: rel.totais.pctBrancosNulos,
      sinal: { verde: lideres.filter((l) => l.sinal === 'verde').length, amarelo: lideres.filter((l) => l.sinal === 'amarelo').length, vermelho: lideres.filter((l) => l.sinal === 'vermelho').length },
    });
  }
  res.json({
    rede: r.rede.nome, candidatos: out,
    municipios: [...municipios.entries()].map(([codigo, nome]) => ({ codigo, nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
  });
}));

// Relatório por liderança com uma coluna por candidato: mostra, por exemplo,
// quem entregou para o federal e não para o estadual.
router.get('/liderancas', asyncHandler(async (req, res) => {
  const r = await redeDoPedido(req);
  if (!r || !r.verTodos) return res.status(403).json({ error: 'Só o Coordenador Geral (ou quem ele liberar) vê esta comparação.' });
  const filtros = filtroMunicipio(req.query);
  const cands = await candidatosDaRede(r.rede.id);
  const pessoas = new Map();
  const colunas = [];
  for (const c of cands) {
    const rel = await entrega.relatorio(c.id, { filtros });
    colunas.push({ id: c.id, nome: c.nome_urna || c.nome, cargo: c.cargo_nome, semDados: !!(rel.semDados || rel.indisponivel) });
    for (const l of rel.liderancas || []) {
      if (!pessoas.has(l.id)) pessoas.set(l.id, { id: l.id, nome: l.nome, porCandidato: {} });
      pessoas.get(l.id).porCandidato[c.id] = { nivel: l.nivel, meta: l.meta, votos: l.votos, entrega: l.entrega, sinal: l.sinal, secoes: l.secoesCobertas };
    }
  }
  const linhas = [...pessoas.values()].sort((a, b) => Object.keys(b.porCandidato).length - Object.keys(a.porCandidato).length || a.nome.localeCompare(b.nome, 'pt-BR'));
  res.json({ colunas, linhas });
}));

// Visão de dobradinha: seções onde um candidato da rede foi bem e o parceiro
// de outro cargo não. "Bem" e "não" são relativos ao próprio candidato: % dos
// válidos da seção comparado à média dele nas seções do escopo.
router.get('/dobradinha', asyncHandler(async (req, res) => {
  const r = await redeDoPedido(req);
  if (!r || !r.verTodos) return res.status(403).json({ error: 'Só o Coordenador Geral (ou quem ele liberar) vê a dobradinha.' });
  const cands = await candidatosDaRede(r.rede.id);
  const a = cands.find((c) => c.id === req.query.a); const b = cands.find((c) => c.id === req.query.b);
  if (!a || !b) return res.status(400).json({ error: 'Escolha os dois candidatos da dobradinha.' });
  const [da, db] = await Promise.all([campanha.carregarDados(a.id), campanha.carregarDados(b.id)]);
  if (!da?.ciclo || !db?.ciclo) return res.status(400).json({ error: 'Os dois candidatos precisam ter os dados do TSE e a importação feita.' });
  if (da.uf !== db.uf || da.ciclo !== db.ciclo) return res.status(400).json({ error: 'A dobradinha compara candidatos da mesma eleição e do mesmo estado.' });
  const [ua, ub] = await Promise.all([entrega.urnasDoCandidato(da), entrega.urnasDoCandidato(db)]);
  const mun = filtroMunicipio(req.query).municipio;
  const comuns = [...ua.urnas.keys()].filter((k) => ub.urnas.has(k) && (!mun || ua.urnas.get(k).municipio === mun));
  const share = (u) => (u.vv ? u.votos / u.vv : 0);
  const media = (m) => { let v = 0, t = 0; for (const k of comuns) { const u = m.urnas.get(k); v += u.votos; t += u.vv; } return t ? v / t : 0; };
  const ma = media(ua); const mb = media(ub);
  const linhas = comuns.map((k) => {
    const x = ua.urnas.get(k); const y = ub.urnas.get(k);
    const ia = ma ? share(x) / ma : 0; const ib = mb ? share(y) / mb : 0;
    return { chave: k, municipio: x.municipioNome, zona: x.zona, secao: x.secao, local: x.local, bairro: x.bairro,
      votosA: x.votos, pctA: Math.round(share(x) * 1000) / 10, votosB: y.votos, pctB: Math.round(share(y) * 1000) / 10,
      indiceA: Math.round(ia * 100) / 100, indiceB: Math.round(ib * 100) / 100 };
  });
  // A acima da média dele e B abaixo de 60% da média dele (e o contrário).
  const aSemB = linhas.filter((l) => l.indiceA >= 1 && l.indiceB < 0.6).sort((x, y) => (y.indiceA - y.indiceB) - (x.indiceA - x.indiceB));
  const bSemA = linhas.filter((l) => l.indiceB >= 1 && l.indiceA < 0.6).sort((x, y) => (y.indiceB - y.indiceA) - (x.indiceB - x.indiceA));
  res.json({
    a: { id: a.id, nome: a.nome_urna || a.nome, cargo: a.cargo_nome, media: Math.round(ma * 1000) / 10 },
    b: { id: b.id, nome: b.nome_urna || b.nome, cargo: b.cargo_nome, media: Math.round(mb * 1000) / 10 },
    secoes: comuns.length, aSemB: aSemB.slice(0, 300), bSemA: bSemA.slice(0, 300),
  });
}));

// ─── Vínculos: a mesma pessoa em outro candidato da rede ────────────────────

async function candidatoNaMinhaRede(req, candidatoId) {
  const r = await redeDoPedido(req);
  if (!r) return null;
  const { rows } = await pool.query("SELECT id, nome FROM usuarios WHERE id = $1 AND rede_id = $2 AND perfil = 'candidato'", [candidatoId, r.rede.id]);
  return rows[0] ? { rede: r.rede, candidato: rows[0] } : null;
}

// Pessoas da rede (de outros candidatos) para vincular a este — busca por
// nome ou telefone. Só candidato da rede (ou o Coordenador Geral dentro dele).
router.get('/pessoas', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  const ctx = await candidatoNaMinhaRede(req, req.effectiveId);
  if (!ctx) return res.json([]);
  const meus = new Set((await pool.query(`SELECT id FROM (${SQL_ARVORE_CANDIDATO}) r`, [req.effectiveId])).rows.map((x) => x.id));
  const digitos = q.replace(/\D/g, '');
  const out = [];
  for (const c of await candidatosDaRede(ctx.rede.id)) {
    if (c.id === req.effectiveId) continue;
    const { rows } = await pool.query(
      `SELECT id, nome, telefone, nivel, zona, secao FROM (${SQL_ARVORE_CANDIDATO}) r
        WHERE lower(nome) LIKE '%' || lower($2) || '%' OR ($3 <> '' AND regexp_replace(coalesce(telefone,''), '\\D', '', 'g') LIKE '%' || $3 || '%')
        LIMIT 20`, [c.id, q, digitos.length >= 4 ? digitos : '']
    );
    for (const p of rows) if (!meus.has(p.id) && !out.some((o) => o.id === p.id)) out.push({ ...p, candidato: c.nome_urna || c.nome });
  }
  res.json(out.slice(0, 30));
}));

function validarNivel(nivel) {
  const n = Number(nivel);
  return [1, 2, 3, 4].includes(n) ? n : null;
}

async function validarSuperior(candidatoId, nivel, superiorId, apoiadorId) {
  if (nivel === 1) return { superior: null };
  // Sem superior: fica "sem responsável" neste candidato, como quem entra pelo
  // link por nível — o candidato pendura depois, na pirâmide.
  if (!superiorId) return { superior: null };
  if (!UUID.test(superiorId)) return { erro: 'Superior inválido.' };
  const { rows } = await pool.query(`SELECT id, nivel FROM (${SQL_ARVORE_CANDIDATO}) r WHERE id = $2`, [candidatoId, superiorId]);
  if (!rows[0] || superiorId === apoiadorId) return { erro: 'O superior precisa estar na rede deste candidato.' };
  if (rows[0].nivel !== nivel - 1) return { erro: 'O superior precisa estar exatamente um nível acima.' };
  return { superior: superiorId };
}

// Vincula ao candidato do workspace uma pessoa já cadastrada em outro
// candidato da rede — sem duplicar o cadastro. Devolve o alerta de mesmo cargo.
router.post('/vincular', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!UUID.test(b.apoiador_id || '')) return res.status(400).json({ error: 'Pessoa inválida.' });
  const ctx = await candidatoNaMinhaRede(req, req.effectiveId);
  if (!ctx) return res.status(400).json({ error: 'Este candidato não está numa rede.' });
  const dono = await campanha.candidatoDaPessoa(b.apoiador_id);
  const { rows: mesmaRede } = await pool.query('SELECT 1 FROM usuarios WHERE id = $1 AND rede_id = $2', [dono, ctx.rede.id]);
  if (!mesmaRede[0]) return res.status(403).json({ error: 'Essa pessoa não está na sua rede.' });
  if (dono === req.effectiveId) return res.status(409).json({ error: 'Essa pessoa já está na rede deste candidato.' });
  const nivel = validarNivel(b.nivel);
  if (!nivel) return res.status(400).json({ error: 'Escolha o papel dela neste candidato.' });
  const sup = await validarSuperior(req.effectiveId, nivel, b.superior_id, b.apoiador_id);
  if (sup.erro) return res.status(400).json({ error: sup.erro });
  const meta = nivel <= 3 && b.meta_votos !== '' && b.meta_votos != null ? Number(b.meta_votos) : null;
  if (meta != null && (!Number.isInteger(meta) || meta < 0)) return res.status(400).json({ error: 'Meta de votos inválida.' });
  await pool.query(
    `INSERT INTO apoiador_candidatos (apoiador_id, candidato_id, nivel, superior_id, meta_votos, ativo, criado_por)
     VALUES ($1,$2,$3,$4,$5,true,$6)
     ON CONFLICT (apoiador_id, candidato_id) DO UPDATE SET nivel = EXCLUDED.nivel, superior_id = EXCLUDED.superior_id,
       meta_votos = EXCLUDED.meta_votos, ativo = true`,
    [b.apoiador_id, req.effectiveId, nivel, sup.superior, meta, req.user.id]
  );
  const { rows: p } = await pool.query('SELECT nome FROM apoiadores WHERE id = $1', [b.apoiador_id]);
  await registrar(req, { acao: 'rede.vincular', alvoTipo: 'apoiador', alvoId: b.apoiador_id, alvoNome: p[0]?.nome, detalhes: { candidato: ctx.candidato.nome, nivel, meta } });
  const alertas = await alertasMesmoCargo(ctx.rede.id, b.apoiador_id);
  res.json({ ok: true, alertas });
}));

// Muda papel, superior ou meta da pessoa NESTE candidato (os dados pessoais
// são os mesmos para todos e se editam na ficha).
router.put('/vinculos/:apoiadorId', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { apoiadorId } = req.params;
  if (!UUID.test(apoiadorId)) return res.status(400).json({ error: 'Pessoa inválida.' });
  const { rows: v } = await pool.query('SELECT * FROM apoiador_candidatos WHERE apoiador_id = $1 AND candidato_id = $2', [apoiadorId, req.effectiveId]);
  if (!v[0]) return res.status(404).json({ error: 'Vínculo não encontrado.' });
  const nivel = validarNivel(req.body?.nivel ?? v[0].nivel);
  if (!nivel) return res.status(400).json({ error: 'Papel inválido.' });
  const sup = await validarSuperior(req.effectiveId, nivel, req.body?.superior_id ?? v[0].superior_id, apoiadorId);
  if (sup.erro) return res.status(400).json({ error: sup.erro });
  const metaIn = req.body?.meta_votos;
  const meta = nivel === 4 ? null : (metaIn === undefined ? v[0].meta_votos : (metaIn === '' || metaIn == null ? null : Number(metaIn)));
  if (meta != null && (!Number.isInteger(meta) || meta < 0)) return res.status(400).json({ error: 'Meta de votos inválida.' });
  await pool.query(
    'UPDATE apoiador_candidatos SET nivel = $3, superior_id = $4, meta_votos = $5 WHERE apoiador_id = $1 AND candidato_id = $2',
    [apoiadorId, req.effectiveId, nivel, sup.superior, meta]
  );
  await registrar(req, { acao: 'rede.vinculo_editar', alvoTipo: 'apoiador', alvoId: apoiadorId, detalhes: { nivel, meta } });
  res.json({ ok: true });
}));

router.delete('/vinculos/:apoiadorId', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { apoiadorId } = req.params;
  if (!UUID.test(apoiadorId)) return res.status(400).json({ error: 'Pessoa inválida.' });
  // Quem estava pendurado nela neste candidato sobe para "sem superior" — o
  // mesmo cuidado das exclusões da pirâmide (sem isso somem sem aviso).
  await pool.query('UPDATE apoiador_candidatos SET superior_id = NULL WHERE candidato_id = $1 AND superior_id = $2', [req.effectiveId, apoiadorId]);
  const { rowCount } = await pool.query('DELETE FROM apoiador_candidatos WHERE apoiador_id = $1 AND candidato_id = $2', [apoiadorId, req.effectiveId]);
  if (!rowCount) return res.status(404).json({ error: 'Vínculo não encontrado.' });
  await registrar(req, { acao: 'rede.desvincular', alvoTipo: 'apoiador', alvoId: apoiadorId });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.alertasMesmoCargo = alertasMesmoCargo;
module.exports.candidatosDaRede = candidatosDaRede;
