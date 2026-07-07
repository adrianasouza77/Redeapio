const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { hash, gerarSenhaTemporaria } = require('../utils/password');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

router.get('/candidatos', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.nome, c.login, c.email, c.ativo, c.created_at,
           EXISTS (SELECT 1 FROM usuarios u WHERE u.criado_por = c.id) AS em_uso
    FROM usuarios c
    WHERE c.perfil = 'candidato'
    ORDER BY c.created_at
  `);
  res.json(rows);
}));

router.post('/candidatos', asyncHandler(async (req, res) => {
  const { rows: existentes } = await pool.query(
    "SELECT login FROM usuarios WHERE perfil = 'candidato' AND login ~ '^candidato[0-9]+$'"
  );
  const proximoNumero =
    existentes
      .map((r) => parseInt(r.login.replace('candidato', ''), 10))
      .reduce((max, n) => Math.max(max, n), 0) + 1;

  const login = `candidato${proximoNumero}`;
  const senha = gerarSenhaTemporaria();
  const senhaHash = await hash(senha);
  const nome = req.body?.nome || `Candidato ${proximoNumero}`;
  const email = req.body?.email?.trim().toLowerCase() || null;

  const { rows } = await pool.query(
    `INSERT INTO usuarios (nome, login, senha_hash, perfil, email) VALUES ($1,$2,$3,'candidato',$4)
     RETURNING id, nome, login, email`,
    [nome, login, senhaHash, email]
  );
  res.status(201).json({ ...rows[0], senha });
}));

router.put('/candidatos/:id/senha', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const novaSenha = req.body?.senha && req.body.senha.length >= 4 ? req.body.senha : gerarSenhaTemporaria();
  const senhaHash = await hash(novaSenha);
  const { rowCount } = await pool.query(
    "UPDATE usuarios SET senha_hash = $1 WHERE id = $2 AND perfil = 'candidato'",
    [senhaHash, id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Candidato não encontrado.' });
  res.json({ senha: novaSenha });
}));

router.put('/candidatos/:id/email', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const email = req.body?.email?.trim().toLowerCase() || null;
  const { rowCount } = await pool.query(
    "UPDATE usuarios SET email = $1 WHERE id = $2 AND perfil = 'candidato'",
    [email, id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Candidato não encontrado.' });
  res.json({ email });
}));

module.exports = router;
