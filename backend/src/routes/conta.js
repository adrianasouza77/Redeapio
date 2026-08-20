const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const { hash, compare } = require('../utils/password');
const { termoVersaoAtual } = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');

const router = express.Router();
router.use(authRequired);

// Autoatendimento: qualquer perfil logado (candidato, liderança, apoiador,
// admin) pode ler/aceitar o termo vigente e trocar sua própria senha/login
// a qualquer momento — não só na tela obrigatória de primeiro acesso.

router.post('/aceitar-termo', asyncHandler(async (req, res) => {
  await pool.query('UPDATE usuarios SET termo_versao_aceita = $1 WHERE id = $2', [termoVersaoAtual, req.user.id]);
  await pool.query(
    `INSERT INTO termos_aceite (usuario_id, versao_termo, ip, user_agent) VALUES ($1,$2,$3,$4)`,
    [req.user.id, termoVersaoAtual, req.ip, req.headers['user-agent'] || null]
  );
  await registrar(req, { acao: 'termo.aceite', alvoTipo: 'usuario', alvoId: req.user.id, alvoNome: req.user.nome, detalhes: { versao: termoVersaoAtual } });
  res.json({ ok: true, termoVersaoAtual });
}));

router.put('/senha', asyncHandler(async (req, res) => {
  const { senhaAtual, novaSenha } = req.body || {};
  if (!senhaAtual || !novaSenha || novaSenha.length < 4) {
    return res.status(400).json({ error: 'Informe a senha atual e uma nova senha com pelo menos 4 caracteres.' });
  }
  const { rows } = await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [req.user.id]);
  if (!rows[0] || !(await compare(senhaAtual, rows[0].senha_hash))) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }
  const senhaHash = await hash(novaSenha);
  await pool.query('UPDATE usuarios SET senha_hash = $1, senha_temporaria = false WHERE id = $2', [senhaHash, req.user.id]);
  await registrar(req, { acao: 'senha.propria', alvoTipo: 'usuario', alvoId: req.user.id, alvoNome: req.user.nome });
  res.json({ ok: true });
}));

router.put('/login', asyncHandler(async (req, res) => {
  const { novoLogin, senhaAtual } = req.body || {};
  const login = novoLogin?.trim().toLowerCase();
  if (!login || !senhaAtual) {
    return res.status(400).json({ error: 'Informe o novo login e a senha atual.' });
  }
  if (!/^[a-z0-9._-]+$/.test(login)) {
    return res.status(400).json({ error: 'Login deve conter apenas letras, números, ponto, hífen ou underline — sem espaços.' });
  }
  const { rows } = await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [req.user.id]);
  if (!rows[0] || !(await compare(senhaAtual, rows[0].senha_hash))) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }
  try {
    await pool.query('UPDATE usuarios SET login = $1 WHERE id = $2', [login, req.user.id]);
    await registrar(req, { acao: 'login.alterado', alvoTipo: 'usuario', alvoId: req.user.id, alvoNome: req.user.nome, detalhes: { para: login } });
    res.json({ ok: true, login });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este login já existe.' });
    throw err;
  }
}));

module.exports = router;
