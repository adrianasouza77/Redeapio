const express = require('express');
const pool = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { validarTituloEleitoral } = require('../utils/tituloEleitoral');
const { termoVersaoAtual } = require('../config');

const router = express.Router();

router.get('/lideranca/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT nome, perfil FROM usuarios WHERE id = $1 AND perfil IN ('lideranca','apoiador')",
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Link inválido.' });
  res.json({ nome: rows[0].nome, versaoTermo: termoVersaoAtual });
}));

router.post('/autocadastro', asyncHandler(async (req, res) => {
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
  if (!validarTituloEleitoral(titulo)) {
    return res.status(400).json({ error: 'Título de eleitor inválido. Confira os 12 números do seu título.' });
  }
  if (!lideranca_id) return res.status(400).json({ error: 'Link de cadastro inválido.' });

  const { rows: parentRows } = await pool.query(
    "SELECT id, perfil FROM usuarios WHERE id = $1 AND perfil IN ('lideranca','apoiador')",
    [lideranca_id]
  );
  const parent = parentRows[0];
  if (!parent) return res.status(400).json({ error: 'Link de cadastro inválido.' });

  const nivel = parent.perfil === 'lideranca' ? 2 : 3;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO apoiadores (nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, zona, secao, nivel, parent_id, cadastrado_por, lgpd_aceite, lgpd_aceite_em, lgpd_versao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,true,now(),$13) RETURNING id`,
      [nome, telefone, nascimento, regiao, endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, nivel, parent.id, termoVersaoAtual]
    );
    // Trilha de auditoria do consentimento (art. 8º, §2º LGPD): versão do termo,
    // data/hora, IP e dispositivo — prova de que a pessoa leu e aceitou.
    await client.query(
      `INSERT INTO termos_aceite (apoiador_id, versao_termo, ip, user_agent) VALUES ($1,$2,$3,$4)`,
      [rows[0].id, termoVersaoAtual, req.ip, req.headers['user-agent'] || null]
    );
    await client.query('COMMIT');
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
