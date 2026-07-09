const pool = require('../db');

// Um usuário com login (lideranca/apoiador) é sempre criado diretamente pelo
// candidato (ver usuarios.js) — então criado_por já É o id do candidato,
// sem precisar subir a árvore recursivamente.
function resolverCandidatoId(user) {
  return user.perfil === 'candidato' ? user.id : user.criado_por;
}

const NULO = '00000000-0000-0000-0000-000000000000';

// Verifica duplicidade de e-mail, telefone e título de eleitor dentro da
// MESMA rede do candidato, antes do cadastro ser efetivado — evita a mesma
// pessoa entrar duas vezes na rede (por engano ou por má-fé). Telefone/título
// são checados em "apoiadores" porque essa tabela já cobre todo mundo: as
// fichas-espelho de lideranças/apoiadores com login E os apoiadores sem login
// de qualquer nível. Retorna { campo, nome } do primeiro conflito, ou null.
async function buscarDuplicidade({ candidatoId, email, telefone, titulo, excluirUsuarioId, excluirApoiadorId }) {
  if (!candidatoId) return null;

  if (email) {
    const { rows } = await pool.query(
      `SELECT nome FROM usuarios WHERE lower(email) = lower($1) AND criado_por = $2 AND id <> $3`,
      [email, candidatoId, excluirUsuarioId || NULO]
    );
    if (rows[0]) return { campo: 'e-mail', nome: rows[0].nome };
  }

  if (telefone) {
    const { rows } = await pool.query(
      `WITH RECURSIVE arvore AS (
         SELECT id FROM usuarios WHERE id = $1
         UNION ALL
         SELECT u.id FROM usuarios u JOIN arvore a ON u.criado_por = a.id
       )
       SELECT nome FROM apoiadores
       WHERE telefone = $2
         AND (cadastrado_por IN (SELECT id FROM arvore) OR parent_id IN (SELECT id FROM arvore))
         AND id <> $3
       LIMIT 1`,
      [candidatoId, telefone, excluirApoiadorId || NULO]
    );
    if (rows[0]) return { campo: 'telefone', nome: rows[0].nome };
  }

  if (titulo) {
    const { rows } = await pool.query(
      `WITH RECURSIVE arvore AS (
         SELECT id FROM usuarios WHERE id = $1
         UNION ALL
         SELECT u.id FROM usuarios u JOIN arvore a ON u.criado_por = a.id
       )
       SELECT nome FROM apoiadores
       WHERE titulo = $2
         AND (cadastrado_por IN (SELECT id FROM arvore) OR parent_id IN (SELECT id FROM arvore))
         AND id <> $3
       LIMIT 1`,
      [candidatoId, titulo, excluirApoiadorId || NULO]
    );
    if (rows[0]) return { campo: 'título de eleitor', nome: rows[0].nome };
  }

  return null;
}

module.exports = { buscarDuplicidade, resolverCandidatoId };
