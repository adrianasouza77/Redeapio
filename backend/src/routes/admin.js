const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { hash, gerarSenhaTemporaria } = require('../utils/password');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');

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
    await registrar(req, {
      acao: 'candidato.criar', alvoTipo: 'candidato', alvoId: rows[0].id, alvoNome: nome,
      detalhes: { login: rows[0].login, email: rows[0].email }, candidatoId: rows[0].id,
    });
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
  const { rows } = await pool.query(
    "UPDATE usuarios SET senha_hash = $1, senha_temporaria = true WHERE id = $2 AND perfil = 'candidato' RETURNING nome, login",
    [senhaHash, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Candidato não encontrado.' });
  await registrar(req, { acao: 'candidato.senha', alvoTipo: 'candidato', alvoId: id, alvoNome: rows[0].nome, detalhes: { login: rows[0].login }, candidatoId: id });
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
  await registrar(req, {
    acao: 'candidato.plano', alvoTipo: 'candidato', alvoId: id, alvoNome: rows[0].nome, candidatoId: id,
    detalhes: {
      plano: { de: atuais[0].plano, para: novoPlano },
      periodo_contrato: { de: atuais[0].periodo_contrato, para: novoPeriodo },
      data_desativacao: { de: atuais[0].data_desativacao, para: novaData },
    },
  });
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
    const { rows } = await pool.query(
      "UPDATE usuarios SET login = $1 WHERE id = $2 AND perfil = 'candidato' RETURNING nome",
      [login, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Candidato não encontrado.' });
    await registrar(req, { acao: 'candidato.login', alvoTipo: 'candidato', alvoId: id, alvoNome: rows[0].nome, detalhes: { para: login }, candidatoId: id });
    res.json({ login });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este login já existe.' });
    throw err;
  }
}));

router.put('/candidatos/:id/email', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const email = req.body?.email?.trim().toLowerCase() || null;
  const { rows } = await pool.query(
    "UPDATE usuarios SET email = $1 WHERE id = $2 AND perfil = 'candidato' RETURNING nome",
    [email, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Candidato não encontrado.' });
  await registrar(req, { acao: 'candidato.email', alvoTipo: 'candidato', alvoId: id, alvoNome: rows[0].nome, detalhes: { para: email }, candidatoId: id });
  res.json({ email });
}));

// ── Busca global de pessoa (só o Administrador Geral) ─────────────────────
//
// Responde "essa pessoa está em qual campanha?" — a pergunta que aparece
// quando o mesmo nome/telefone/título chega por duas campanhas diferentes.
// Nenhuma outra tela do sistema atravessa workspaces: candidato e liderança
// enxergam apenas a própria rede, de propósito. Esta atravessa, e por isso
// está atrás do requireRole('admin') aplicado no topo do arquivo.
//
// "dono" resolve, de uma vez, o candidato de cada usuário subindo por
// criado_por. Sem isso seria preciso uma consulta por resultado só para
// descobrir de quem é a rede — que é justamente a informação procurada.
const SQL_DONO = `
  WITH RECURSIVE dono AS (
    SELECT id, id AS candidato_id FROM usuarios WHERE perfil = 'candidato'
    UNION ALL
    SELECT u.id, d.candidato_id FROM usuarios u JOIN dono d ON u.criado_por = d.id
  )`;

// A ficha em "apoiadores" cobre quase todo mundo, mas não todos: o próprio
// candidato nunca tem ficha, e uma liderança criada fora do fluxo normal pode
// não ter. A segunda metade da união pega esses — senão procurar pelo login do
// candidato não acharia ninguém.
const SQL_BUSCA_PESSOA = `
  ${SQL_DONO},
  pessoas AS (
    SELECT a.id, a.nome, a.telefone, a.titulo, a.zona, a.secao, a.nivel, a.regiao,
           a.cidade, a.estado, a.nascimento, a.parent_id, a.cadastrado_por, a.created_at,
           u.login, u.email, COALESCE(u.perfil, 'apoiador (sem login)') AS perfil,
           (u.id IS NOT NULL) AS tem_login,
           COALESCE(ds.candidato_id, dc.candidato_id, dp.candidato_id) AS candidato_id
    FROM apoiadores a
    LEFT JOIN usuarios u ON u.id = a.id
    LEFT JOIN dono ds ON ds.id = a.id
    LEFT JOIN dono dc ON dc.id = a.cadastrado_por
    LEFT JOIN dono dp ON dp.id = a.parent_id
    UNION ALL
    SELECT u.id, u.nome, u.telefone, u.titulo, u.zona, u.secao, NULL::int, u.regiao,
           u.cidade, u.estado, NULL::date, NULL::uuid, u.criado_por, u.created_at,
           u.login, u.email, u.perfil, true, d.candidato_id
    FROM usuarios u
    LEFT JOIN dono d ON d.id = u.id
    WHERE u.perfil <> 'admin' AND NOT EXISTS (SELECT 1 FROM apoiadores a WHERE a.id = u.id)
  )
  SELECT p.*, c.nome AS candidato_nome, c.login AS candidato_login
  FROM pessoas p
  LEFT JOIN usuarios c ON c.id = p.candidato_id
  WHERE p.nome ILIKE $1
     OR lower(COALESCE(p.login, '')) LIKE lower($1)
     OR lower(COALESCE(p.email, '')) LIKE lower($1)
     OR ($2 <> '' AND regexp_replace(COALESCE(p.telefone, ''), '[^0-9]', '', 'g') LIKE $2)
     OR ($2 <> '' AND regexp_replace(COALESCE(p.titulo, ''), '[^0-9]', '', 'g') LIKE $2)
  ORDER BY lower(p.nome), p.created_at
  LIMIT 300
`;

router.get('/buscar', asyncHandler(async (req, res) => {
  const termo = String(req.query.q || '').trim();
  if (termo.length < 3) {
    return res.status(400).json({ error: 'Digite pelo menos 3 caracteres (nome, telefone, título de eleitor, login ou e-mail).' });
  }
  // Menos de 4 dígitos não identifica ninguém — "67" acharia meia campanha e
  // a tela ficaria inútil justamente quando mais precisa ser precisa.
  const digitos = termo.replace(/[^0-9]/g, '');
  const padraoDigitos = digitos.length >= 4 ? `%${digitos}%` : '';

  const { rows } = await pool.query(SQL_BUSCA_PESSOA, [`%${termo}%`, padraoDigitos]);

  // Diz por qual campo cada resultado casou: sem isso, procurar por telefone
  // devolve uma lista de nomes que não têm relação óbvia com o que foi digitado.
  const alvo = termo.toLowerCase();
  const resultados = rows.map((p) => {
    const casou = [];
    if ((p.nome || '').toLowerCase().includes(alvo)) casou.push('nome');
    if ((p.login || '').toLowerCase().includes(alvo)) casou.push('login');
    if ((p.email || '').toLowerCase().includes(alvo)) casou.push('e-mail');
    if (padraoDigitos && String(p.telefone || '').replace(/[^0-9]/g, '').includes(digitos)) casou.push('telefone');
    if (padraoDigitos && String(p.titulo || '').replace(/[^0-9]/g, '').includes(digitos)) casou.push('título de eleitor');
    return { ...p, casou };
  });

  res.json({ termo, total: resultados.length, resultados });
}));

// ── Log de auditoria (só o Administrador Geral) ───────────────────────────
const LIMITE_LOG = 200;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

router.get('/logs', asyncHandler(async (req, res) => {
  const { candidato, acao, q } = req.query;
  const filtros = [];
  const vals = [];

  // Filtro que chega torto (link velho, id colado errado) vira "sem filtro"
  // em vez de 500: o Postgres recusa um uuid/inteiro malformado no parâmetro.
  if (candidato && UUID.test(candidato)) { vals.push(candidato); filtros.push(`candidato_id = $${vals.length}`); }
  // Prefixo, não igualdade: 'apoiador' pega criar/editar/mover/excluir de uma vez.
  if (acao) { vals.push(`${acao}%`); filtros.push(`acao LIKE $${vals.length}`); }
  if (q) { vals.push(`%${String(q).trim()}%`); filtros.push(`(alvo_nome ILIKE $${vals.length} OR ator_nome ILIKE $${vals.length})`); }
  // Paginação por id, e não por OFFSET: o log cresce enquanto a tela está
  // aberta, e com OFFSET a segunda página repetiria linhas da primeira.
  if (/^[0-9]+$/.test(String(req.query.antesDeId || ''))) { vals.push(req.query.antesDeId); filtros.push(`id < $${vals.length}`); }

  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT a.*, c.nome AS candidato_nome
     FROM auditoria a
     LEFT JOIN usuarios c ON c.id = a.candidato_id
     ${where}
     ORDER BY a.id DESC
     LIMIT ${LIMITE_LOG + 1}`,
    vals
  );
  const temMais = rows.length > LIMITE_LOG;
  res.json({ eventos: rows.slice(0, LIMITE_LOG), temMais });
}));

// Histórico de UMA pessoa: o que fizeram com ela (alvo) e o que ela fez com o
// login dela (ator), na mesma linha do tempo — é o que o ícone de log na
// frente de cada apoiador abre.
router.get('/logs/pessoa/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID.test(id)) return res.status(400).json({ error: 'Identificador inválido.' });
  const { rows } = await pool.query(
    `SELECT a.*, c.nome AS candidato_nome
     FROM auditoria a
     LEFT JOIN usuarios c ON c.id = a.candidato_id
     WHERE a.alvo_id = $1 OR a.ator_id = $1
     ORDER BY a.id DESC
     LIMIT ${LIMITE_LOG}`,
    [id]
  );

  // O cadastro em si pode ser anterior ao log existir (o sistema já estava em
  // produção). Devolver a data de criação junto evita a tela mentir por
  // omissão, dizendo "nenhum registro" para quem está cadastrado há meses.
  const { rows: ficha } = await pool.query(
    `SELECT COALESCE(a.nome, u.nome) AS nome,
            COALESCE(a.created_at, u.created_at) AS cadastrado_em,
            a.nivel, u.login, u.perfil
     FROM (SELECT $1::uuid AS id) alvo
     LEFT JOIN apoiadores a ON a.id = alvo.id
     LEFT JOIN usuarios u ON u.id = alvo.id`,
    [id]
  );

  // O LEFT JOIN sempre devolve uma linha, mesmo para um id que nao existe
  // mais (excluido depois de aparecer no log) — sem esta checagem a tela
  // mostraria "Cadastrado em —" em vez de admitir que a ficha sumiu.
  res.json({ pessoa: ficha[0]?.nome ? ficha[0] : null, eventos: rows });
}));

module.exports = router;
