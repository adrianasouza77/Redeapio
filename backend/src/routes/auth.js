const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { jwtSecret, tokenExpiresIn } = require('../config');
const { gerarSenhaTemporaria, hash, compare } = require('../utils/password');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { login, senha, perfil } = req.body || {};
  if (!login || !senha || !perfil) {
    return res.status(400).json({ error: 'Preencha usuário, senha e perfil.' });
  }
  const { rows } = await pool.query(
    'SELECT * FROM usuarios WHERE login = $1 AND perfil = $2 AND ativo = true',
    [login.trim().toLowerCase(), perfil]
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

  res.json({
    token,
    user: { id: user.id, nome: user.nome, perfil: user.perfil, criado_por: user.criado_por },
  });
});

router.post('/recuperar-senha', async (req, res) => {
  const { login } = req.body || {};
  if (!login) return res.status(400).json({ error: 'Digite seu login.' });

  const { rows } = await pool.query('SELECT id FROM usuarios WHERE login = $1', [login.trim().toLowerCase()]);
  if (!rows[0]) return res.status(404).json({ error: 'Login não encontrado. Verifique e tente novamente.' });

  const novaSenha = gerarSenhaTemporaria();
  const senhaHash = await hash(novaSenha);
  await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [senhaHash, rows[0].id]);

  res.json({ senha: novaSenha });
});

module.exports = router;
