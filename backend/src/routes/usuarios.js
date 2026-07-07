const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const { hash, gerarSenhaTemporaria } = require('../utils/password');
const { publicUrl } = require('../config');

const router = express.Router();
router.use(authRequired, resolveWorkspace);

const PERFIS_CRIAVEIS = ['lideranca', 'apoiador'];

function linkAutocadastro(liderancaId, candidatoId) {
  return `${publicUrl}/?autocadastro=1&lideranca=${liderancaId}&candidato=${candidatoId}`;
}

// Candidato: lista as próprias lideranças/apoiadores criados por ele.
// Admin com ?as=<candidatoId>: lista as do workspace daquele candidato.
router.get('/', requireRole('candidato', 'admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nome, login, perfil, telefone, regiao, cidade, created_at FROM usuarios WHERE criado_por = $1 ORDER BY created_at',
    [req.effectiveId]
  );
  res.json(rows);
});

router.post('/', requireRole('candidato', 'admin'), async (req, res) => {
  const { nome, login, senha, perfil, telefone, endereco, regiao, cidade } = req.body || {};
  if (!nome || !login || !senha || !perfil) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }
  if (!PERFIS_CRIAVEIS.includes(perfil)) {
    return res.status(400).json({ error: 'Perfil inválido.' });
  }
  if (senha.length < 4) return res.status(400).json({ error: 'Senha muito curta.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const senhaHash = await hash(senha);
    const { rows } = await client.query(
      `INSERT INTO usuarios (nome, login, senha_hash, perfil, criado_por, telefone, regiao, endereco, cidade)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, nome, login, perfil`,
      [nome, login.trim().toLowerCase(), senhaHash, perfil, req.effectiveId, telefone || null, regiao || null, endereco || null, cidade || null]
    );
    const novoUsuario = rows[0];

    if (perfil === 'lideranca') {
      await client.query(
        `INSERT INTO apoiadores (nome, telefone, regiao, endereco, cidade, nivel, parent_id, cadastrado_por)
         VALUES ($1,$2,$3,$4,$5,1,NULL,$6)`,
        [nome, telefone || '—', regiao || '—', endereco || null, cidade || null, req.effectiveId]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      usuario: novoUsuario,
      autocadastroLink: perfil === 'lideranca' ? linkAutocadastro(novoUsuario.id, req.effectiveId) : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Este login já existe.' });
    throw err;
  } finally {
    client.release();
  }
});

router.put('/:id/senha', requireRole('candidato', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { senha } = req.body || {};
  const owned = await pool.query('SELECT id FROM usuarios WHERE id = $1 AND (criado_por = $2 OR $3 = true)', [
    id, req.effectiveId, req.user.perfil === 'admin',
  ]);
  if (!owned.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const novaSenha = senha && senha.length >= 4 ? senha : gerarSenhaTemporaria();
  const senhaHash = await hash(novaSenha);
  await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [senhaHash, id]);
  res.json({ senha: novaSenha });
});

router.delete('/:id', requireRole('candidato', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { rowCount } = await pool.query('DELETE FROM usuarios WHERE id = $1 AND criado_por = $2', [id, req.effectiveId]);
  if (!rowCount) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.status(204).end();
});

module.exports = router;
