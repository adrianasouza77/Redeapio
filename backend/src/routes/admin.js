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
           c.plano, c.periodo_contrato, c.data_desativacao,
           EXISTS (SELECT 1 FROM usuarios u WHERE u.criado_por = c.id) AS em_uso
    FROM usuarios c
    WHERE c.perfil = 'candidato'
    ORDER BY c.created_at
  `);
  res.json(rows);
}));

router.post('/candidatos', asyncHandler(async (req, res) => {
  const loginCustom = req.body?.login?.trim().toLowerCase();
  if (loginCustom && !/^[a-z0-9._-]+$/.test(loginCustom)) {
    return res.status(400).json({ error: 'Login deve conter apenas letras, números, ponto, hífen ou underline.' });
  }

  let login = loginCustom;
  let proximoNumero;
  if (!login) {
    const { rows: existentes } = await pool.query(
      "SELECT login FROM usuarios WHERE perfil = 'candidato' AND login ~ '^candidato[0-9]+$'"
    );
    proximoNumero =
      existentes
        .map((r) => parseInt(r.login.replace('candidato', ''), 10))
        .reduce((max, n) => Math.max(max, n), 0) + 1;
    login = `candidato${proximoNumero}`;
  }

  const senha = gerarSenhaTemporaria();
  const senhaHash = await hash(senha);
  const nome = req.body?.nome || (proximoNumero ? `Candidato ${proximoNumero}` : login);
  const email = req.body?.email?.trim().toLowerCase() || null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, login, senha_hash, perfil, email, senha_temporaria) VALUES ($1,$2,$3,'candidato',$4,true)
       RETURNING id, nome, login, email`,
      [nome, login, senhaHash, email]
    );
    res.status(201).json({ ...rows[0], senha });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este login já existe.' });
    throw err;
  }
}));

router.put('/candidatos/:id/senha', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const novaSenha = req.body?.senha && req.body.senha.length >= 4 ? req.body.senha : gerarSenhaTemporaria();
  const senhaHash = await hash(novaSenha);
  const { rowCount } = await pool.query(
    "UPDATE usuarios SET senha_hash = $1, senha_temporaria = true WHERE id = $2 AND perfil = 'candidato'",
    [senhaHash, id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Candidato não encontrado.' });
  res.json({ senha: novaSenha });
}));

const PLANOS_VALIDOS = ['teste', 'vereador', 'prefeito_dep_estadual', 'deputado_federal_senador'];
const PERIODOS_VALIDOS = ['mensal', 'trimestral', 'semestral'];

// Plano contratado, período e data de desativação — só o admin mexe aqui.
// Ao passar da data_desativacao, toda a rede daquele candidato (ele mesmo,
// lideranças e apoiadores criados sob ele) fica impedida de logar (ver auth.js).
router.put('/candidatos/:id/plano', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { plano, periodoContrato, dataDesativacao } = req.body || {};

  if (plano !== undefined && !PLANOS_VALIDOS.includes(plano)) {
    return res.status(400).json({ error: 'Plano inválido.' });
  }
  if (periodoContrato !== undefined && periodoContrato !== null && !PERIODOS_VALIDOS.includes(periodoContrato)) {
    return res.status(400).json({ error: 'Período de contrato inválido.' });
  }

  const { rows: atuais } = await pool.query(
    "SELECT plano, periodo_contrato, data_desativacao FROM usuarios WHERE id = $1 AND perfil = 'candidato'",
    [id]
  );
  if (!atuais[0]) return res.status(404).json({ error: 'Candidato não encontrado.' });

  const novoPlano = plano !== undefined ? plano : atuais[0].plano;
  const novoPeriodo = periodoContrato !== undefined ? periodoContrato : atuais[0].periodo_contrato;
  const novaData = dataDesativacao !== undefined ? (dataDesativacao || null) : atuais[0].data_desativacao;

  const { rows } = await pool.query(
    `UPDATE usuarios SET plano = $1, periodo_contrato = $2, data_desativacao = $3
     WHERE id = $4 AND perfil = 'candidato' RETURNING id, nome, plano, periodo_contrato, data_desativacao`,
    [novoPlano, novoPeriodo, novaData, id]
  );
  res.json(rows[0]);
}));

// Corrige o login do candidato quando ele mesmo troca para algo inválido/
// difícil de repetir no login (ex: com espaços) — só o admin faz isso, já que
// o autoatendimento (PUT /conta/login) exige a senha atual pra confirmar.
router.put('/candidatos/:id/login', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const login = req.body?.login?.trim().toLowerCase();
  if (!login) return res.status(400).json({ error: 'Informe o novo login.' });
  if (!/^[a-z0-9._-]+$/.test(login)) {
    return res.status(400).json({ error: 'Login deve conter apenas letras, números, ponto, hífen ou underline — sem espaços.' });
  }
  try {
    const { rowCount } = await pool.query(
      "UPDATE usuarios SET login = $1 WHERE id = $2 AND perfil = 'candidato'",
      [login, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Candidato não encontrado.' });
    res.json({ login });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este login já existe.' });
    throw err;
  }
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
