const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { jwtSecret, tokenExpiresIn, cookieMaxAgeMs, publicUrl } = require('../config');
const { authRequired } = require('../middleware/auth');
const { hash, compare } = require('../utils/password');
const { avaliarStatusTermo } = require('../utils/termoStatus');
const { nivelUsuario } = require('../utils/nivelUsuario');
const mail = require('../services/mail');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');

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
  // Tentativa com login inexistente também vira log: é assim que o admin
  // enxerga alguém tentando adivinhar o acesso de outra pessoa. Sem ator_id
  // (não há usuário), só o que foi digitado e o IP de origem.
  if (!user) {
    await registrar(req, { acao: 'login.falha', alvoTipo: 'sessao', alvoNome: identificador, detalhes: { motivo: 'login não encontrado', perfil_tentado: perfil }, ator: {}, candidatoId: null });
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }

  const ok = await compare(senha, user.senha_hash);
  if (!ok) {
    await registrar(req, {
      acao: 'login.falha',
      alvoTipo: 'sessao',
      alvoId: user.id,
      alvoNome: user.nome,
      detalhes: { motivo: 'senha incorreta', login: user.login },
      ator: { id: user.id, nome: user.nome, perfil: user.perfil },
      candidatoId: user.perfil === 'candidato' ? user.id : user.criado_por || null,
    });
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }

  // Contrato encerrado: bloqueia o candidato E toda a rede criada por ele
  // (lideranças/apoiadores) a partir da data de desativação configurada pelo admin.
  const candidatoId = user.perfil === 'candidato' ? user.id : user.criado_por;
  if (candidatoId) {
    const { rows: cRows } = await pool.query(
      "SELECT data_desativacao FROM usuarios WHERE id = $1 AND perfil = 'candidato'",
      [candidatoId]
    );
    const dataDesativacao = cRows[0]?.data_desativacao;
    if (dataDesativacao && new Date(dataDesativacao) <= new Date()) {
      await registrar(req, {
        acao: 'login.bloqueado', alvoTipo: 'sessao', alvoId: user.id, alvoNome: user.nome,
        detalhes: { motivo: 'contrato encerrado', login: user.login },
        ator: { id: user.id, nome: user.nome, perfil: user.perfil }, candidatoId,
      });
      return res.status(403).json({ error: 'Acesso encerrado. Entre em contato com o suporte.' });
    }
  }

  const token = jwt.sign(
    { id: user.id, nome: user.nome, perfil: user.perfil, criado_por: user.criado_por },
    jwtSecret,
    { expiresIn: tokenExpiresIn }
  );

  // Cookie httpOnly: o JS do navegador não consegue ler o token, o que reduz o
  // impacto de um eventual XSS (só cookies acessíveis por JS podem ser roubados).
  res.cookie('token', token, COOKIE_OPTS);
  await registrar(req, {
    acao: 'login',
    alvoTipo: 'sessao',
    alvoId: user.id,
    alvoNome: user.nome,
    detalhes: { login: user.login, perfil: user.perfil },
    ator: { id: user.id, nome: user.nome, perfil: user.perfil },
    candidatoId,
  });
  res.json({
    user: { id: user.id, nome: user.nome, login: user.login, perfil: user.perfil, criado_por: user.criado_por, nivel: await nivelUsuario(user), ...avaliarStatusTermo(user) },
  });
}));

router.get('/me', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, nome, login, perfil, criado_por, senha_temporaria, termo_versao_aceita FROM usuarios WHERE id = $1 AND ativo = true', [req.user.id]);
  if (!rows[0]) return res.status(401).json({ error: 'Sessão inválida.' });
  const { senha_temporaria, termo_versao_aceita, ...user } = rows[0];
  res.json({ user: { ...user, nivel: await nivelUsuario(user), ...avaliarStatusTermo(rows[0]) } });
}));

// Não usa authRequired: sair tem que funcionar mesmo com a sessão já expirada.
// Por isso o ator é lido do token quando ele ainda é válido, e o logout de
// sessão vencida simplesmente não gera linha no log (não há quem registrar).
router.post('/logout', asyncHandler(async (req, res) => {
  const token = req.cookies?.token;
  if (token) {
    try {
      const dados = jwt.verify(token, jwtSecret);
      await registrar(req, {
        acao: 'logout', alvoTipo: 'sessao', alvoId: dados.id, alvoNome: dados.nome,
        ator: { id: dados.id, nome: dados.nome, perfil: dados.perfil },
        candidatoId: dados.perfil === 'candidato' ? dados.id : dados.criado_por || null,
      });
    } catch { /* token expirado: não há sessão para registrar */ }
  }
  res.clearCookie('token', COOKIE_OPTS);
  res.json({ ok: true });
}));

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

  await registrar(req, {
    acao: 'senha.recuperacao_pedida', alvoTipo: 'usuario', alvoId: user.id, alvoNome: user.nome,
    detalhes: { email: user.email }, ator: { id: user.id, nome: user.nome },
    candidatoId: null,
  });

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
    'SELECT id, nome FROM usuarios WHERE reset_password_token = $1 AND reset_password_expires > now()',
    [hashToken]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Link inválido ou expirado. Solicite uma nova recuperação.' });

  const senhaHash = await hash(novaSenha);
  // Escolher a própria senha por um link de e-mail verificado já conta como
  // "primeiro acesso resolvido" — sem isso, a pessoa cairia de novo na tela
  // obrigatória de trocar senha logo depois de acabar de trocá-la.
  await pool.query(
    'UPDATE usuarios SET senha_hash = $1, reset_password_token = NULL, reset_password_expires = NULL, senha_temporaria = false WHERE id = $2',
    [senhaHash, rows[0].id]
  );
  await registrar(req, {
    acao: 'senha.redefinida_por_link', alvoTipo: 'usuario', alvoId: rows[0].id,
    alvoNome: rows[0].nome, ator: { id: rows[0].id, nome: rows[0].nome }, candidatoId: null,
  });
  res.json({ ok: true });
}));

module.exports = router;
