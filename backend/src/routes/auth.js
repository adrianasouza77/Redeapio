const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { jwtSecret, tokenExpiresIn, cookieMaxAgeMs, publicUrl } = require('../config');
const { authRequired } = require('../middleware/auth');
const { hash, compare } = require('../utils/password');
const mail = require('../services/mail');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: cookieMaxAgeMs,
};

router.post('/login', asyncHandler(async (req, res) => {
  const { login, senha, perfil } = req.body || {};
  if (!login || !senha || !perfil) {
    return res.status(400).json({ error: 'Preencha usuário, senha e perfil.' });
  }
  // Aceita tanto o login quanto o e-mail cadastrado — quem esquece o usuário
  // geralmente lembra do e-mail. Continua exigindo o perfil correto (aba
  // selecionada) pra não misturar contas de perfis diferentes com mesmo e-mail.
  const identificador = login.trim().toLowerCase();
  const { rows } = await pool.query(
    'SELECT * FROM usuarios WHERE (login = $1 OR email = $1) AND perfil = $2 AND ativo = true',
    [identificador, perfil]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });

  const ok = await compare(senha, user.senha_hash);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });

  const token = jwt.sign(
    { id: user.id, nome: user.nome, perfil: user.perfil, criado_por: user.criado_por },
    jwtSecret,
    { expiresIn: tokenExpiresIn }
  );

  // Cookie httpOnly: o JS do navegador não consegue ler o token, o que reduz o
  // impacto de um eventual XSS (só cookies acessíveis por JS podem ser roubados).
  res.cookie('token', token, COOKIE_OPTS);
  res.json({
    user: { id: user.id, nome: user.nome, perfil: user.perfil, criado_por: user.criado_por },
  });
}));

router.get('/me', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, nome, perfil, criado_por FROM usuarios WHERE id = $1 AND ativo = true', [req.user.id]);
  if (!rows[0]) return res.status(401).json({ error: 'Sessão inválida.' });
  res.json({ user: rows[0] });
}));

router.post('/logout', (req, res) => {
  res.clearCookie('token', COOKIE_OPTS);
  res.json({ ok: true });
});

// Autoatendimento: só funciona se o usuário tiver e-mail cadastrado (canal
// verificado). Sem e-mail, precisa falar com o candidato/admin — que pode
// gerar uma senha temporária diretamente (tela de Usuários / Central de Vagas).
router.post('/esqueci-senha', asyncHandler(async (req, res) => {
  const { login } = req.body || {};
  if (!login) return res.status(400).json({ error: 'Digite seu login.' });

  const identificador = login.trim().toLowerCase();
  const { rows } = await pool.query(
    'SELECT id, nome, email FROM usuarios WHERE (login = $1 OR email = $1) AND ativo = true LIMIT 1',
    [identificador]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'Login não encontrado. Verifique e tente novamente.' });
  if (!user.email) {
    return res.status(400).json({ error: 'Este usuário não tem e-mail cadastrado. Entre em contato com o administrador para redefinir sua senha.' });
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
  await pool.query(
    'UPDATE usuarios SET reset_password_token = $1, reset_password_expires = $2 WHERE id = $3',
    [hashToken, expira, user.id]
  );

  const link = `${publicUrl}/?reset=1&token=${rawToken}`;
  await mail.sendMailSilent({
    to: user.email,
    subject: 'Recuperação de senha — RedeApoio',
    html: mail.tplResetSenha({ nome: user.nome, link }),
  });

  res.json({ ok: true, mensagem: 'Enviamos um link de recuperação para o e-mail cadastrado.' });
}));

router.post('/redefinir-senha', asyncHandler(async (req, res) => {
  const { token, novaSenha } = req.body || {};
  if (!token || !novaSenha || novaSenha.length < 4) {
    return res.status(400).json({ error: 'Preencha uma senha com pelo menos 4 caracteres.' });
  }

  const hashToken = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await pool.query(
    'SELECT id FROM usuarios WHERE reset_password_token = $1 AND reset_password_expires > now()',
    [hashToken]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Link inválido ou expirado. Solicite uma nova recuperação.' });

  const senhaHash = await hash(novaSenha);
  await pool.query(
    'UPDATE usuarios SET senha_hash = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2',
    [senhaHash, rows[0].id]
  );
  res.json({ ok: true });
}));

module.exports = router;
