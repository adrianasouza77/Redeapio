const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const { resolverCandidatoId } = require('../utils/duplicidade');
const { CORES_NICHO, nichosDoCandidato } = require('../utils/nichos');

// Nichos temáticos da campanha. Arquivo próprio pelo mesmo motivo do mapas.js:
// não mexe na pirâmide. Qualquer pessoa logada da rede LÊ a lista (a liderança
// precisa dela para cadastrar); só o candidato cria, renomeia e apaga.
const router = express.Router();
router.use(authRequired, resolveWorkspace);

const MAX_NICHOS = 50;
const MAX_NOME = 40;

function candidatoDe(req) {
  return (req.effectivePerfil === 'candidato' || req.user.perfil === 'admin')
    ? req.effectiveId
    : resolverCandidatoId(req.user);
}

function limparNicho(body) {
  const nome = String(body?.nome || '').trim().replace(/\s+/g, ' ');
  if (!nome) return { erro: 'Dê um nome ao nicho.' };
  if (nome.length > MAX_NOME) return { erro: `Nome muito longo (máximo ${MAX_NOME} letras).` };
  const cor = CORES_NICHO.includes(body?.cor) ? body.cor : null;
  return { nome, cor };
}

router.get('/', asyncHandler(async (req, res) => {
  res.json(await nichosDoCandidato(candidatoDe(req)));
}));

router.post('/', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const n = limparNicho(req.body);
  if (n.erro) return res.status(400).json({ error: n.erro });
  const { rows: c } = await pool.query('SELECT count(*)::int AS c FROM nichos WHERE candidato_id = $1', [req.effectiveId]);
  if (c[0].c >= MAX_NICHOS) return res.status(400).json({ error: `Máximo de ${MAX_NICHOS} nichos por campanha.` });
  const cor = n.cor || CORES_NICHO[c[0].c % CORES_NICHO.length];
  try {
    const { rows } = await pool.query(
      'INSERT INTO nichos (candidato_id, nome, cor) VALUES ($1,$2,$3) RETURNING id, nome, cor',
      [req.effectiveId, n.nome, cor]
    );
    await registrar(req, { acao: 'nicho.criar', alvoTipo: 'nicho', alvoId: rows[0].id, alvoNome: n.nome });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um nicho com esse nome.' });
    throw err;
  }
}));

router.put('/:id', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const n = limparNicho(req.body);
  if (n.erro) return res.status(400).json({ error: n.erro });
  try {
    const { rows } = await pool.query(
      'UPDATE nichos SET nome = $1, cor = COALESCE($2, cor) WHERE id = $3 AND candidato_id = $4 RETURNING id, nome, cor',
      [n.nome, n.cor, req.params.id, req.effectiveId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Nicho não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um nicho com esse nome.' });
    throw err;
  }
}));

// Apagar o nicho tira a marcação de quem estava nele (a pessoa continua na rede).
router.delete('/:id', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM nichos WHERE id = $1 AND candidato_id = $2 RETURNING nome',
    [req.params.id, req.effectiveId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Nicho não encontrado.' });
  await registrar(req, { acao: 'nicho.excluir', alvoTipo: 'nicho', alvoId: req.params.id, alvoNome: rows[0].nome });
  res.status(204).end();
}));

module.exports = router;