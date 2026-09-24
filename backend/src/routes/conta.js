const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const { hash, compare } = require('../utils/password');
const { termoVersaoAtual } = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const resolveWorkspace = require('../middleware/workspace');
const totp = require('../utils/totp');

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

// ─── Segurança da conta ──────────────────────────────────────────────────────

router.get('/seguranca', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT totp_ativo, suporte_admin FROM usuarios WHERE id = $1', [req.user.id]);
  res.json({ totpAtivo: !!rows[0]?.totp_ativo, suporteAdmin: rows[0]?.suporte_admin !== false });
}));

// Ligar a verificação em duas etapas acontece em dois passos: aqui o segredo
// é gerado e guardado ainda DESLIGADO; só vira obrigatório quando a pessoa
// prova que o aplicativo dela está gerando o código certo (/2fa/ativar).
// Sem isso, um erro ao escanear trancaria a pessoa fora da própria conta.
router.post('/2fa/iniciar', asyncHandler(async (req, res) => {
  const { senhaAtual } = req.body || {};
  const { rows } = await pool.query('SELECT login, senha_hash, totp_ativo FROM usuarios WHERE id = $1', [req.user.id]);
  if (!rows[0] || !(await compare(String(senhaAtual || ''), rows[0].senha_hash))) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }
  if (rows[0].totp_ativo) return res.status(400).json({ error: 'A verificação em duas etapas já está ligada.' });
  const segredo = totp.gerarSegredo();
  await pool.query('UPDATE usuarios SET totp_segredo = $1 WHERE id = $2', [segredo, req.user.id]);
  res.json({ segredo, link: totp.linkOtpauth(segredo, rows[0].login) });
}));

router.post('/2fa/ativar', asyncHandler(async (req, res) => {
  const codigo = String(req.body?.codigo || '').replace(/\D/g, '');
  const { rows } = await pool.query('SELECT totp_segredo FROM usuarios WHERE id = $1', [req.user.id]);
  if (!rows[0]?.totp_segredo) return res.status(400).json({ error: 'Comece pelo passo 1.' });
  if (!totp.verificar(rows[0].totp_segredo, codigo)) {
    return res.status(400).json({ error: 'Código incorreto. Confira se o relógio do celular está certo e digite o número que aparece agora.' });
  }
  await pool.query('UPDATE usuarios SET totp_ativo = true WHERE id = $1', [req.user.id]);
  await registrar(req, { acao: 'seguranca.2fa_ligado', alvoTipo: 'usuario', alvoId: req.user.id, alvoNome: req.user.nome });
  res.json({ ok: true });
}));

router.post('/2fa/desativar', asyncHandler(async (req, res) => {
  const { senhaAtual, codigo } = req.body || {};
  const { rows } = await pool.query('SELECT senha_hash, totp_segredo, totp_ativo FROM usuarios WHERE id = $1', [req.user.id]);
  if (!rows[0] || !(await compare(String(senhaAtual || ''), rows[0].senha_hash))) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }
  if (rows[0].totp_ativo && !totp.verificar(rows[0].totp_segredo, String(codigo || '').replace(/\D/g, ''))) {
    return res.status(400).json({ error: 'Código do aplicativo incorreto.' });
  }
  await pool.query('UPDATE usuarios SET totp_ativo = false, totp_segredo = NULL WHERE id = $1', [req.user.id]);
  await registrar(req, { acao: 'seguranca.2fa_desligado', alvoTipo: 'usuario', alvoId: req.user.id, alvoNome: req.user.nome });
  res.json({ ok: true });
}));

// O candidato decide se o suporte da plataforma pode abrir a campanha dele.
router.put('/suporte', asyncHandler(async (req, res) => {
  if (req.user.perfil !== 'candidato') return res.status(403).json({ error: 'Só o candidato decide isso.' });
  const permitir = req.body?.permitir === true;
  await pool.query('UPDATE usuarios SET suporte_admin = $1 WHERE id = $2', [permitir, req.user.id]);
  await registrar(req, { acao: permitir ? 'seguranca.suporte_ligado' : 'seguranca.suporte_desligado', alvoTipo: 'candidato', alvoId: req.user.id, alvoNome: req.user.nome });
  res.json({ suporteAdmin: permitir });
}));

// Registro de acessos da própria campanha: quem entrou, quem exportou, quando
// o suporte abriu. É o que dá ao candidato a prova de que os dados dele estão
// isolados — ele vê cada acesso, inclusive o do administrador.
const ACOES_ACESSO = ['login', 'login.falha', 'workspace.abrir', 'dados.exportar', 'ia.gerar',
  'seguranca.2fa_ligado', 'seguranca.2fa_desligado', 'seguranca.suporte_ligado', 'seguranca.suporte_desligado'];
router.get('/acessos', asyncHandler(async (req, res) => {
  if (req.user.perfil !== 'candidato') return res.status(403).json({ error: 'Só o candidato vê o registro da campanha.' });
  const { rows } = await pool.query(
    `SELECT ocorrido_em, ator_nome, ator_perfil, como_admin, acao, alvo_nome, detalhes, ip
       FROM auditoria WHERE candidato_id = $1 AND acao = ANY($2) ORDER BY id DESC LIMIT 150`,
    [req.user.id, ACOES_ACESSO]
  );
  res.json(rows);
}));

// A exportação (Excel/PDF/CSV) é montada no navegador, então o servidor não
// sabe que ela aconteceu — a tela avisa aqui. Só este tipo de evento entra, e
// os detalhes são reduzidos a três campos conhecidos.
router.post('/evento', resolveWorkspace, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.acao !== 'dados.exportar') return res.status(400).json({ error: 'Evento desconhecido.' });
  const detalhes = {
    formato: String(b.formato || '').slice(0, 10),
    recorte: String(b.recorte || '').slice(0, 80),
    total: Number.isInteger(b.total) ? b.total : null,
  };
  await registrar(req, { acao: 'dados.exportar', alvoTipo: 'config', detalhes });
  res.status(204).end();
}));

module.exports = router;
