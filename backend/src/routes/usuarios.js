const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const { hash, gerarSenhaTemporaria } = require('../utils/password');
const { publicUrl } = require('../config');
const { buscarDuplicidade } = require('../utils/duplicidade');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired, resolveWorkspace);

const PERFIS_CRIAVEIS = ['lideranca', 'apoiador'];

function linkAutocadastro(liderancaId, candidatoId) {
  return `${publicUrl}/?autocadastro=1&lideranca=${liderancaId}&candidato=${candidatoId}`;
}

// Candidato: lista as próprias lideranças/apoiadores criados por ele.
// Admin com ?as=<candidatoId>: lista as do workspace daquele candidato.
router.get('/', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nome, login, email, perfil, telefone, endereco, regiao, cidade, estado, titulo, zona, secao, created_at FROM usuarios WHERE criado_por = $1 ORDER BY created_at',
    [req.effectiveId]
  );
  res.json(rows);
}));

// Checagem em tempo real usada pelo formulário de cadastro (feedback verde/vermelho
// no campo de login). Login é único em toda a tabela usuarios, independente de perfil.
router.get('/verificar-login', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const login = req.query.login?.trim().toLowerCase();
  if (!login) return res.status(400).json({ error: 'Informe um login.' });
  const { rows } = await pool.query('SELECT 1 FROM usuarios WHERE login = $1', [login]);
  res.json({ disponivel: rows.length === 0 });
}));

router.post('/', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { nome, login, senha, perfil, telefone, email, endereco, regiao, cidade, estado, titulo, zona, secao } = req.body || {};
  if (!nome || !login || !senha || !perfil) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }
  if (!PERFIS_CRIAVEIS.includes(perfil)) {
    return res.status(400).json({ error: 'Perfil inválido.' });
  }
  if (senha.length < 4) return res.status(400).json({ error: 'Senha muito curta.' });

  const dup = await buscarDuplicidade({ candidatoId: req.effectiveId, email, telefone, titulo });
  if (dup) {
    return res.status(409).json({ error: `Já existe um cadastro com esse ${dup.campo} nesta rede (${dup.nome}).` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const senhaHash = await hash(senha);
    const { rows } = await client.query(
      `INSERT INTO usuarios (nome, login, senha_hash, perfil, criado_por, telefone, email, regiao, endereco, cidade, titulo, zona, secao, senha_temporaria)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true) RETURNING id, nome, login, perfil, email`,
      [nome, login.trim().toLowerCase(), senhaHash, perfil, req.effectiveId, telefone || null, email?.trim().toLowerCase() || null, regiao || null, endereco || null, cidade || null, titulo || null, zona || null, secao || null]
    );
    const novoUsuario = rows[0];

    // Cria a "ficha" espelho em apoiadores para lideranças/apoiadores-com-login
    // aparecerem na pirâmide de Rede de Apoio. O id da ficha precisa ser IGUAL
    // ao id do próprio usuário — é esse id que os indicados dela usam como
    // parent_id. Se fossem ids diferentes (como um gen_random_uuid() default),
    // a pirâmide nunca conseguiria achar os indicados de ninguém.
    if (perfil === 'lideranca' || perfil === 'apoiador') {
      const nivelFicha = perfil === 'lideranca' ? 1 : 2;
      await client.query(
        `INSERT INTO apoiadores (id, nome, telefone, regiao, endereco, cidade, estado, titulo, zona, secao, nivel, parent_id, cadastrado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12)`,
        [novoUsuario.id, nome, telefone || '—', regiao || '—', endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, nivelFicha, req.effectiveId]
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
}));

router.put('/:id/senha', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { senha } = req.body || {};
  const owned = await pool.query('SELECT id FROM usuarios WHERE id = $1 AND (criado_por = $2 OR $3 = true)', [
    id, req.effectiveId, req.user.perfil === 'admin',
  ]);
  if (!owned.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const novaSenha = senha && senha.length >= 4 ? senha : gerarSenhaTemporaria();
  const senhaHash = await hash(novaSenha);
  // Marca como temporária de novo: quem recebe uma senha escolhida por outra
  // pessoa precisa passar pela tela obrigatória de primeiro acesso e trocá-la.
  await pool.query('UPDATE usuarios SET senha_hash = $1, senha_temporaria = true WHERE id = $2', [senhaHash, id]);
  res.json({ senha: novaSenha });
}));

router.put('/:id', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const owned = await pool.query('SELECT id FROM usuarios WHERE id = $1 AND (criado_por = $2 OR $3 = true)', [
    id, req.effectiveId, req.user.perfil === 'admin',
  ]);
  if (!owned.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const { nome, telefone, endereco, regiao, cidade, estado } = req.body || {};
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });

  const vals = [nome.trim(), telefone || null, endereco || null, regiao || null, cidade || null, estado || null, id];
  const { rows } = await pool.query(
    'UPDATE usuarios SET nome = $1, telefone = $2, endereco = $3, regiao = $4, cidade = $5, estado = $6 WHERE id = $7 RETURNING id, nome, login, email, perfil, telefone, regiao, endereco, cidade, estado',
    vals
  );
  // Mantém a ficha-espelho em apoiadores (pirâmide/Todos os Apoiadores) sincronizada.
  await pool.query(
    'UPDATE apoiadores SET nome = $1, telefone = $2, endereco = $3, regiao = $4, cidade = $5, estado = $6 WHERE id = $7',
    vals
  );
  res.json(rows[0]);
}));

router.put('/:id/email', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { email } = req.body || {};
  const owned = await pool.query('SELECT id FROM usuarios WHERE id = $1 AND (criado_por = $2 OR $3 = true)', [
    id, req.effectiveId, req.user.perfil === 'admin',
  ]);
  if (!owned.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });

  await pool.query('UPDATE usuarios SET email = $1 WHERE id = $2', [email?.trim().toLowerCase() || null, id]);
  res.json({ email: email?.trim().toLowerCase() || null });
}));

router.put('/:id/eleitorais', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { titulo, zona, secao } = req.body || {};
  const owned = await pool.query('SELECT id FROM usuarios WHERE id = $1 AND (criado_por = $2 OR $3 = true)', [
    id, req.effectiveId, req.user.perfil === 'admin',
  ]);
  if (!owned.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const vals = [titulo?.trim() || null, zona?.trim() || null, secao?.trim() || null, id];
  await pool.query('UPDATE usuarios SET titulo = $1, zona = $2, secao = $3 WHERE id = $4', vals);
  // Mantém a ficha-espelho em apoiadores (pirâmide/Todos os Apoiadores) sincronizada.
  await pool.query('UPDATE apoiadores SET titulo = $1, zona = $2, secao = $3 WHERE id = $4', vals);
  res.json({ titulo: vals[0], zona: vals[1], secao: vals[2] });
}));

router.delete('/:id', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rowCount } = await pool.query('DELETE FROM usuarios WHERE id = $1 AND criado_por = $2', [id, req.effectiveId]);
  if (!rowCount) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.status(204).end();
}));

module.exports = router;
