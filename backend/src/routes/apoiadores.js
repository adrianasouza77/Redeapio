const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const { limites } = require('../config');

const router = express.Router();
router.use(authRequired, resolveWorkspace);

// Query recursiva: resolve toda a árvore de usuários (lideranças/apoiadores com login)
// criada em cascata a partir de um candidato, e traz todos os apoiadores ligados a
// qualquer um desses usuários. Tipagem UUID nativa do Postgres elimina de vez o bug
// de comparação UUID vs string que existia no filtro .or() do Supabase.
const SQL_ARVORE_CANDIDATO = `
  WITH RECURSIVE arvore AS (
    SELECT id FROM usuarios WHERE id = $1
    UNION ALL
    SELECT u.id FROM usuarios u JOIN arvore a ON u.criado_por = a.id
  )
  SELECT ap.* FROM apoiadores ap
  WHERE ap.cadastrado_por IN (SELECT id FROM arvore)
     OR ap.parent_id IN (SELECT id FROM arvore)
  ORDER BY ap.created_at
`;

// A mesma CTE recursiva serve para todos os perfis: para um candidato ela resolve
// a árvore inteira; para lideranca/apoiador, a árvore não desce (eles não criam
// usuarios), então o resultado já vem naturalmente restrito à própria sub-rede.
router.get('/', async (req, res) => {
  const { rows } = await pool.query(SQL_ARVORE_CANDIDATO, [req.effectiveId]);
  res.json(rows);
});

router.get('/duplicados', requireRole('candidato', 'admin'), async (req, res) => {
  const { rows: arvore } = await pool.query(SQL_ARVORE_CANDIDATO, [req.effectiveId]);
  const grupos = new Map();
  for (const a of arvore) {
    const chave = a.nome.trim().toLowerCase();
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(a);
  }
  const duplicados = [...grupos.values()].filter((g) => g.length > 1);
  res.json(duplicados);
});

router.post('/', requireRole('lideranca', 'apoiador'), async (req, res) => {
  const { nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, secao } = req.body || {};
  if (!nome || !telefone || !nascimento || !regiao) {
    return res.status(400).json({ error: 'Preencha nome, telefone, nascimento e bairro.' });
  }
  const myNivel = req.user.perfil === 'lideranca' ? 1 : 2;
  const novoNivel = myNivel + 1;
  if (novoNivel > 3) return res.status(400).json({ error: 'Nível máximo atingido.' });

  const { rows: countRows } = await pool.query(
    'SELECT count(*)::int AS c FROM apoiadores WHERE parent_id = $1',
    [req.user.id]
  );
  const limite = limites[myNivel];
  if (countRows[0].c >= limite) {
    return res.status(400).json({ error: `Limite de ${limite} indicações atingido.` });
  }

  const { rows } = await pool.query(
    `INSERT INTO apoiadores (nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, secao, nivel, parent_id, cadastrado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
    [nome, telefone, nascimento, regiao, endereco || null, cidade || null, estado || null, titulo || null, secao || null, novoNivel, req.user.id]
  );
  res.status(201).json(rows[0]);
});

async function podeGerenciar(req, id) {
  if (req.effectivePerfil === 'candidato' || req.user.perfil === 'admin') {
    const { rows } = await pool.query(SQL_ARVORE_CANDIDATO, [req.effectiveId]);
    return rows.some((a) => a.id === id);
  }
  const { rows } = await pool.query(
    'SELECT id FROM apoiadores WHERE id = $1 AND (parent_id = $2 OR cadastrado_por = $2)',
    [id, req.user.id]
  );
  return !!rows[0];
}

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  if (!(await podeGerenciar(req, id))) return res.status(403).json({ error: 'Sem permissão para editar este registro.' });

  const { nome, telefone, nascimento, endereco, regiao, cidade, estado, titulo, secao } = req.body || {};
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });

  const { rows } = await pool.query(
    `UPDATE apoiadores SET nome=$1, telefone=$2, nascimento=$3, endereco=$4, regiao=$5, cidade=$6, estado=$7, titulo=$8, secao=$9
     WHERE id = $10 RETURNING *`,
    [nome, telefone || null, nascimento || null, endereco || null, regiao || null, cidade || null, estado || null, titulo || null, secao || null, id]
  );
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!(await podeGerenciar(req, id))) return res.status(403).json({ error: 'Sem permissão para excluir este registro.' });
  await pool.query('DELETE FROM apoiadores WHERE id = $1', [id]);
  res.status(204).end();
});

module.exports = router;
