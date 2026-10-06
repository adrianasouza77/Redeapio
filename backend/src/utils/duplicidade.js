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

// A mesma pessoa em OUTRO candidato da mesma rede (briefing "Votos por
// seção", seção 7: "cadastro único por rede, sem duplicar CPF/telefone").
// Quem acha não bloqueia: devolve a pessoa para o cadastro virar um vínculo.
// O sistema não guarda CPF; o telefone (só os dígitos) é o identificador.
async function buscarNaRede({ candidatoId, telefone }) {
  const dig = String(telefone || '').replace(/\D/g, '');
  if (!candidatoId || dig.length < 8) return null;
  // Exigido aqui dentro: routes/apoiadores.js também usa este arquivo.
  const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');
  const { rows: outros } = await pool.query(
    `SELECT o.id, o.nome FROM usuarios c JOIN usuarios o ON o.rede_id = c.rede_id AND o.perfil = 'candidato' AND o.id <> c.id
      WHERE c.id = $1 AND c.rede_id IS NOT NULL`, [candidatoId]
  );
  for (const o of outros) {
    const { rows } = await pool.query(
      `SELECT id, nome, nivel FROM (${SQL_ARVORE_CANDIDATO}) r WHERE regexp_replace(coalesce(telefone, ''), '\D', '', 'g') = $2 LIMIT 1`,
      [o.id, dig]
    );
    if (rows[0]) return { apoiador_id: rows[0].id, nome: rows[0].nome, nivel: rows[0].nivel, candidato_id: o.id, candidato_nome: o.nome };
  }
  return null;
}

module.exports.buscarNaRede = buscarNaRede;
