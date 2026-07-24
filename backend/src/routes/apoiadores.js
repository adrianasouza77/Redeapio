const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const { limitesDoCandidato } = require('../utils/limites');
const { nivelUsuario } = require('../utils/nivelUsuario');
const { buscarDuplicidade, resolverCandidatoId } = require('../utils/duplicidade');
const asyncHandler = require('../utils/asyncHandler');

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

// Para lideranca/apoiador, SQL_ARVORE_CANDIDATO só pega os indicados DIRETOS
// (cadastrado_por/parent_id = o próprio id) — não desce para nível 3/4 depois
// que a liderança reorganiza a hierarquia (parent_id passa a apontar para
// outro apoiador, não mais para um usuário). Esta resolve a subárvore inteira
// a partir de qualquer nó de "apoiadores", seguindo parent_id em cascata.
const SQL_ARVORE_LIDERANCA = `
  WITH RECURSIVE arvore AS (
    SELECT id FROM apoiadores WHERE id = $1
    UNION ALL
    SELECT ap.id FROM apoiadores ap JOIN arvore a ON ap.parent_id = a.id
  )
  SELECT ap.* FROM apoiadores ap WHERE ap.id IN (SELECT id FROM arvore) AND ap.id <> $1
  ORDER BY ap.created_at
`;

router.get('/', asyncHandler(async (req, res) => {
  const ehArvoreCandidato = req.effectivePerfil === 'candidato' || req.user.perfil === 'admin';
  const { rows } = await pool.query(
    ehArvoreCandidato ? SQL_ARVORE_CANDIDATO : SQL_ARVORE_LIDERANCA,
    [ehArvoreCandidato ? req.effectiveId : req.user.id]
  );
  res.json(rows);
}));

router.get('/duplicados', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { rows: arvore } = await pool.query(SQL_ARVORE_CANDIDATO, [req.effectiveId]);
  const grupos = new Map();
  for (const a of arvore) {
    const chave = a.nome.trim().toLowerCase();
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(a);
  }
  const duplicados = [...grupos.values()].filter((g) => g.length > 1);
  res.json(duplicados);
}));

router.post('/', requireRole('lideranca', 'apoiador'), asyncHandler(async (req, res) => {
  const { nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, zona, secao } = req.body || {};
  if (!nome || !telefone || !nascimento || !regiao) {
    return res.status(400).json({ error: 'Preencha nome, telefone, nascimento e bairro.' });
  }
  const myNivel = await nivelUsuario(req.user);
  const novoNivel = myNivel + 1;
  if (novoNivel > 4) return res.status(400).json({ error: 'Nível máximo atingido.' });

  const { rows: countRows } = await pool.query(
    'SELECT count(*)::int AS c FROM apoiadores WHERE parent_id = $1',
    [req.user.id]
  );
  const limites = await limitesDoCandidato(resolverCandidatoId(req.user));
  const limite = limites[myNivel];
  if (countRows[0].c >= limite) {
    return res.status(400).json({ error: `Limite de ${limite} indicações atingido.` });
  }

  const dup = await buscarDuplicidade({ candidatoId: resolverCandidatoId(req.user), telefone, titulo });
  if (dup) {
    return res.status(409).json({ error: `Já existe um cadastro com esse ${dup.campo} nesta rede (${dup.nome}).` });
  }

  const { rows } = await pool.query(
    `INSERT INTO apoiadores (nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, zona, secao, nivel, parent_id, cadastrado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [nome, telefone, nascimento, regiao, endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, novoNivel, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

// Sub-árvore (nível/parent_id) a partir de um nó qualquer de "apoiadores" — usada
// tanto para permissão (lideranca/apoiador podem gerenciar qualquer descendente,
// não só quem indicaram direto) quanto para validar a reorganização de hierarquia.
const SQL_SUBARVORE = `
  WITH RECURSIVE arvore AS (
    SELECT id, nivel, parent_id FROM apoiadores WHERE id = $1
    UNION ALL
    SELECT ap.id, ap.nivel, ap.parent_id FROM apoiadores ap JOIN arvore a ON ap.parent_id = a.id
  )
  SELECT id, nivel, parent_id FROM arvore
`;

async function podeGerenciar(req, id) {
  if (req.effectivePerfil === 'candidato' || req.user.perfil === 'admin') {
    const { rows } = await pool.query(SQL_ARVORE_CANDIDATO, [req.effectiveId]);
    return rows.some((a) => a.id === id);
  }
  const { rows } = await pool.query(SQL_SUBARVORE, [req.user.id]);
  return rows.some((a) => a.id === id);
}

// IDs de todos os descendentes de um nó (usado pra impedir mover alguém
// "para baixo de si mesmo" ao reorganizar a hierarquia).
function descendentesDe(arvore, id) {
  const filhosPorPai = new Map();
  for (const a of arvore) {
    if (!filhosPorPai.has(a.parent_id)) filhosPorPai.set(a.parent_id, []);
    filhosPorPai.get(a.parent_id).push(a.id);
  }
  const resultado = new Set();
  const pilha = [id];
  while (pilha.length) {
    const atual = pilha.pop();
    for (const filho of filhosPorPai.get(atual) || []) {
      if (!resultado.has(filho)) { resultado.add(filho); pilha.push(filho); }
    }
  }
  return resultado;
}

router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!(await podeGerenciar(req, id))) return res.status(403).json({ error: 'Sem permissão para editar este registro.' });

  const { nome, telefone, nascimento, endereco, regiao, cidade, estado, titulo, zona, secao, nivel, parent_id } = req.body || {};
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });

  // Reorganização de hierarquia (nível + responsável). A liderança mexe só dentro
  // da própria subárvore; o candidato (e o admin dentro do workspace dele) mexe na
  // rede inteira — é assim que ele pendura sob um responsável os cadastros que
  // entraram "sem responsável" pelos links por nível que ele mesmo gerou.
  let novoNivel, novoParentId;
  if (nivel !== undefined || parent_id !== undefined) {
    const ehCandidato = req.effectivePerfil === 'candidato' || req.user.perfil === 'admin';
    if (req.user.perfil !== 'lideranca' && !ehCandidato) {
      return res.status(403).json({ error: 'Só a liderança ou o candidato podem reorganizar a hierarquia da rede.' });
    }
    novoNivel = Number(nivel);
    novoParentId = parent_id;
    if (![2, 3, 4].includes(novoNivel)) {
      return res.status(400).json({ error: 'Nível inválido.' });
    }
    if (!novoParentId) return res.status(400).json({ error: 'Informe quem é o responsável por esse apoiador.' });

    const { rows: arvore } = await pool.query(
      ehCandidato ? SQL_ARVORE_CANDIDATO : SQL_SUBARVORE,
      [ehCandidato ? req.effectiveId : req.user.id]
    );
    const porId = new Map(arvore.map((a) => [a.id, a]));

    if (!porId.has(id)) return res.status(403).json({ error: 'Esse registro não está na sua rede.' });
    const pai = porId.get(novoParentId);
    if (!pai) return res.status(400).json({ error: 'Responsável inválido — precisa estar na sua própria rede.' });
    if (pai.nivel !== novoNivel - 1) {
      return res.status(400).json({ error: 'O responsável escolhido precisa estar exatamente um nível acima.' });
    }
    if (descendentesDe(arvore, id).has(novoParentId)) {
      return res.status(400).json({ error: 'Não é possível mover um apoiador para debaixo de alguém que ele mesmo indicou.' });
    }

    const { rows: countRows } = await pool.query(
      'SELECT count(*)::int AS c FROM apoiadores WHERE parent_id = $1 AND id <> $2',
      [novoParentId, id]
    );
    const limites = await limitesDoCandidato(ehCandidato ? req.effectiveId : resolverCandidatoId(req.user));
    const limite = limites[novoNivel - 1];
    if (countRows[0].c >= limite) {
      return res.status(400).json({ error: `Limite de ${limite} indicações atingido para esse responsável.` });
    }
  }

  const campos = ['nome=$1', 'telefone=$2', 'nascimento=$3', 'endereco=$4', 'regiao=$5', 'cidade=$6', 'estado=$7', 'titulo=$8', 'zona=$9', 'secao=$10'];
  const vals = [nome, telefone || null, nascimento || null, endereco || null, regiao || null, cidade || null, estado || null, titulo || null, zona || null, secao || null];
  if (novoNivel !== undefined) {
    campos.push(`nivel=$${vals.length + 1}`, `parent_id=$${vals.length + 2}`);
    vals.push(novoNivel, novoParentId);
  }
  vals.push(id);

  const { rows } = await pool.query(
    `UPDATE apoiadores SET ${campos.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  res.json(rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!(await podeGerenciar(req, id))) return res.status(403).json({ error: 'Sem permissão para excluir este registro.' });
  await pool.query('DELETE FROM apoiadores WHERE id = $1', [id]);
  res.status(204).end();
}));

module.exports = router;
