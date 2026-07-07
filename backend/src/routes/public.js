const express = require('express');
const pool = require('../db');

const router = express.Router();

router.get('/lideranca/:id', async (req, res) => {
  const { rows } = await pool.query(
    "SELECT nome, perfil FROM usuarios WHERE id = $1 AND perfil IN ('lideranca','apoiador')",
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Link inválido.' });
  res.json({ nome: rows[0].nome });
});

router.post('/autocadastro', async (req, res) => {
  const { lideranca_id, nome, telefone, nascimento, endereco, regiao, cidade, estado, titulo, zona, secao, lgpd_aceite } = req.body || {};

  if (!lgpd_aceite) {
    return res.status(400).json({ error: 'É necessário aceitar o termo de consentimento LGPD.' });
  }
  if (!nome || !telefone || !nascimento || !regiao) {
    return res.status(400).json({ error: 'Preencha nome, telefone, nascimento e bairro.' });
  }
  if (!titulo || !zona || !secao) {
    return res.status(400).json({ error: 'Título, zona e seção eleitoral são obrigatórios.' });
  }
  if (!lideranca_id) return res.status(400).json({ error: 'Link de cadastro inválido.' });

  const { rows: parentRows } = await pool.query(
    "SELECT id, perfil FROM usuarios WHERE id = $1 AND perfil IN ('lideranca','apoiador')",
    [lideranca_id]
  );
  const parent = parentRows[0];
  if (!parent) return res.status(400).json({ error: 'Link de cadastro inválido.' });

  const nivel = parent.perfil === 'lideranca' ? 2 : 3;

  const { rows } = await pool.query(
    `INSERT INTO apoiadores (nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, zona, secao, nivel, parent_id, cadastrado_por, lgpd_aceite, lgpd_aceite_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,true,now()) RETURNING id`,
    [nome, telefone, nascimento, regiao, endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, nivel, parent.id]
  );
  res.status(201).json({ id: rows[0].id });
});

module.exports = router;
