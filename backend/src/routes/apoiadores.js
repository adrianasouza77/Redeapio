const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const { limitesDoCandidato } = require('../utils/limites');
const { nivelUsuario } = require('../utils/nivelUsuario');
const { buscarDuplicidade, resolverCandidatoId } = require('../utils/duplicidade');
const { hash, gerarSenhaTemporaria } = require('../utils/password');
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
  SELECT ap.*, (u.id IS NOT NULL) AS tem_login, u.login, u.email FROM apoiadores ap
  LEFT JOIN usuarios u ON u.id = ap.id
  WHERE ap.cadastrado_por IN (SELECT id FROM arvore)
     OR ap.parent_id IN (SELECT id FROM arvore)
  ORDER BY ap.created_at
`;

// Para lideranca/apoiador, SQL_ARVORE_CANDIDATO só pega os indicados DIRETOS
// (cadastrado_por/parent_id = o próprio id) — não desce para nível 3/4 depois
// que a liderança reorganiza a hierarquia (parent_id passa a apontar para
// outro apoiador, não mais para um usuário). Esta resolve a subárvore inteira
// a partir de qualquer nó de "apoiadores", seguindo parent_id em cascata.
//
// Dois detalhes faziam a corrente quebrar e o nível 3/4 só aparecer no login do
// candidato (que usa a outra query, baseada em cadastrado_por):
//   1) a raiz vinha de "SELECT id FROM apoiadores WHERE id = $1" — quem não
//      tinha a ficha-espelho (usuário criado antes dessa regra) recebia uma
//      lista VAZIA e não via nem os próprios indicados diretos. A raiz agora é
//      o próprio id, então a busca funciona mesmo sem ficha.
//   2) quem entra pelos links por nível do candidato fica com parent_id NULL:
//      a descida parava nesse nó e ninguém abaixo dele aparecia. O cadastro
//      órfão passa a ser puxado por quem o cadastrou — só quando parent_id é
//      NULL, para não desfazer a reorganização de hierarquia (se o candidato
//      moveu alguém para outro responsável, quem cadastrou perde o acesso).
const RECURSAO_SUBARVORE = `
  WITH RECURSIVE arvore AS (
    SELECT $1::uuid AS id
    UNION
    SELECT ap.id FROM apoiadores ap JOIN arvore a
      ON ap.parent_id = a.id
      OR (ap.parent_id IS NULL AND ap.cadastrado_por = a.id)
  )
`;

const SQL_ARVORE_LIDERANCA = `
  ${RECURSAO_SUBARVORE}
  SELECT ap.*, (u.id IS NOT NULL) AS tem_login, u.login, u.email FROM apoiadores ap
  LEFT JOIN usuarios u ON u.id = ap.id
  WHERE ap.id IN (SELECT id FROM arvore) AND ap.id <> $1::uuid
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

// ── Mapa da rede ──────────────────────────────────────────────────────────
// Estas duas rotas ficam ANTES de qualquer rota com ':id' de propósito: o
// Express casa na ordem de declaração, e '/geo' seria engolido por '/:id'.

// Lista os bairros da rede de quem está pedindo, cada um com a coordenada que
// já estiver no cache. Nunca chama serviço externo — é o que abre o mapa
// rápido. Quem ainda não tem coordenada volta com pendente=true e é resolvido
// pela rota de baixo, sob comando do usuário.
router.get('/geo', asyncHandler(async (req, res) => {
  const bairros = await bairrosDaRede(req);
  if (!bairros.length) return res.json([]);

  const { rows: cache } = await pool.query(
    `SELECT cidade, estado, bairro, lat, lng, encontrado FROM geo_bairros
     WHERE (lower(cidade), lower(estado), lower(bairro)) IN
           (SELECT lower(c), lower(e), lower(b) FROM unnest($1::text[], $2::text[], $3::text[]) AS t(c, e, b))`,
    [bairros.map((b) => b.cidade), bairros.map((b) => b.estado), bairros.map((b) => b.bairro)]
  );
  const porChave = new Map(cache.map((c) => [chaveGeo(c.cidade, c.estado, c.bairro), c]));

  res.json(bairros.map((b) => {
    const c = porChave.get(chaveGeo(b.cidade, b.estado, b.bairro));
    return {
      bairro: b.bairro,
      cidade: b.cidade,
      estado: b.estado,
      lat: c && c.encontrado ? c.lat : null,
      lng: c && c.encontrado ? c.lng : null,
      // Só é pendente quem nunca foi consultado. Bairro já procurado e não
      // encontrado fica com pendente=false para não entrar em fila eterna.
      pendente: !c,
      naoEncontrado: !!c && !c.encontrado,
    };
  }));
}));

// Descobre a coordenada dos bairros pendentes. É chamada em lotes pequenos
// porque o serviço externo (Nominatim/OpenStreetMap) exige no máximo 1 consulta
// por segundo — um lote de 8 já leva 8 segundos, e lote grande estouraria o
// tempo limite do Traefik. O frontend chama de novo enquanto sobrar pendente.
router.post('/geo/resolver', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const LOTE = 8;
  const bairros = await bairrosDaRede(req);
  const { rows: jaTem } = await pool.query(
    `SELECT lower(cidade) c, lower(estado) e, lower(bairro) b FROM geo_bairros`
  );
  const conhecidos = new Set(jaTem.map((r) => chaveGeo(r.c, r.e, r.b)));
  const pendentes = bairros.filter((b) => !conhecidos.has(chaveGeo(b.cidade, b.estado, b.bairro))).slice(0, LOTE);

  let resolvidos = 0;
  for (let i = 0; i < pendentes.length; i++) {
    const b = pendentes[i];
    if (i > 0) await esperar(1100); // limite de uso do serviço: 1 consulta/segundo
    const ponto = await geocodificar(b);
    if (ponto) resolvidos++;
    await pool.query(
      `INSERT INTO geo_bairros (cidade, estado, bairro, lat, lng, encontrado, tentativas)
       VALUES ($1, $2, $3, $4, $5, $6, 1)
       ON CONFLICT (lower(cidade), lower(estado), lower(bairro)) DO UPDATE
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, encontrado = EXCLUDED.encontrado,
             tentativas = geo_bairros.tentativas + 1, atualizado_em = now()`,
      [b.cidade, b.estado, b.bairro, ponto ? ponto.lat : null, ponto ? ponto.lng : null, !!ponto]
    );
  }

  const totalPendentes = bairros.filter((b) => !conhecidos.has(chaveGeo(b.cidade, b.estado, b.bairro))).length;
  res.json({ processados: pendentes.length, resolvidos, restantes: Math.max(0, totalPendentes - pendentes.length) });
}));

function chaveGeo(cidade, estado, bairro) {
  return `${(cidade || '').trim().toLowerCase()}|${(estado || '').trim().toLowerCase()}|${(bairro || '').trim().toLowerCase()}`;
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Bairros distintos da rede de quem está logado, respeitando exatamente a mesma
// visibilidade da listagem de apoiadores (candidato vê a rede toda; liderança vê
// só a subárvore dela) — o mapa não pode mostrar bairro que a pessoa não veria.
async function bairrosDaRede(req) {
  const ehArvoreCandidato = req.effectivePerfil === 'candidato' || req.user.perfil === 'admin';
  const { rows } = await pool.query(
    ehArvoreCandidato ? SQL_ARVORE_CANDIDATO : SQL_ARVORE_LIDERANCA,
    [ehArvoreCandidato ? req.effectiveId : req.user.id]
  );
  const mapa = new Map();
  for (const a of rows) {
    const bairro = (a.regiao || '').trim();
    if (!bairro) continue;
    const item = { bairro, cidade: (a.cidade || '').trim(), estado: (a.estado || '').trim() };
    mapa.set(chaveGeo(item.cidade, item.estado, item.bairro), item);
  }
  return [...mapa.values()];
}

// Brasil inteiro em caixa retangular. Serve de rede de segurança: "Centro" sem
// cidade preenchida casa com meio mundo, e um ponto em Portugal no meio do mapa
// da campanha destrói a leitura do gráfico.
const BBOX_BRASIL = { latMin: -34.0, latMax: 5.3, lngMin: -74.1, lngMax: -34.7 };

async function geocodificar({ bairro, cidade, estado }) {
  const partes = [bairro, cidade, estado, 'Brasil'].filter(Boolean);
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q='
    + encodeURIComponent(partes.join(', '));
  const cancelar = new AbortController();
  const relogio = setTimeout(() => cancelar.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: cancelar.signal,
      // O Nominatim bloqueia quem não se identifica. Sem isto o mapa para de
      // funcionar sem nenhum erro visível — só volta lista vazia.
      headers: { 'User-Agent': 'RedeApoio/1.0 (mapa de rede politica)', 'Accept-Language': 'pt-BR' },
    });
    if (!resp.ok) return null;
    const dados = await resp.json();
    if (!Array.isArray(dados) || !dados[0]) return null;
    const lat = parseFloat(dados[0].lat);
    const lng = parseFloat(dados[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < BBOX_BRASIL.latMin || lat > BBOX_BRASIL.latMax) return null;
    if (lng < BBOX_BRASIL.lngMin || lng > BBOX_BRASIL.lngMax) return null;
    return { lat, lng };
  } catch {
    return null; // rede fora do ar não pode derrubar a requisição inteira
  } finally {
    clearTimeout(relogio);
  }
}

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
// Mesma recursão da listagem (raiz = o próprio id, órfão puxado por quem
// cadastrou): permissão e listagem precisam enxergar exatamente a mesma rede,
// senão a pessoa vê um nome na tela e leva 403 ao tentar editá-lo.
const SQL_SUBARVORE = `
  ${RECURSAO_SUBARVORE}
  SELECT ap.id, ap.nivel, ap.parent_id FROM apoiadores ap
  WHERE ap.id IN (SELECT id FROM arvore)
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

  const { nome, telefone, nascimento, endereco, regiao, cidade, estado, titulo, zona, secao, nivel, parent_id, login, email } = req.body || {};
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
  const atualizado = rows[0];

  // Se este cadastro também tem login (usuário nível 1..3), mantém o "usuarios"
  // em sincronia e permite ajustar login/e-mail do acesso a partir daqui — tanto
  // para o candidato quanto para a liderança (a permissão já foi validada acima
  // por podeGerenciar). Só entra quando o modal enviou esses campos, então nunca
  // apaga o e-mail de quem não os edita.
  if (login !== undefined || email !== undefined) {
    const { rows: uRows } = await pool.query('SELECT id FROM usuarios WHERE id = $1', [id]);
    if (uRows[0]) {
      const loginNovo = login != null && String(login).trim() ? String(login).trim().toLowerCase() : null;
      if (loginNovo && !/^[a-z0-9._-]+$/.test(loginNovo)) {
        return res.status(400).json({ error: 'Login deve conter apenas letras minúsculas, números, ponto, hífen ou underline — sem espaços.' });
      }
      const emailLimpo = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
      const candId = (req.effectivePerfil === 'candidato' || req.user.perfil === 'admin')
        ? req.effectiveId
        : resolverCandidatoId(req.user);
      const dup = await buscarDuplicidade({ candidatoId: candId, email: emailLimpo, excluirUsuarioId: id });
      if (dup) return res.status(409).json({ error: `Já existe um cadastro com esse ${dup.campo} nesta rede (${dup.nome}).` });
      try {
        if (loginNovo) {
          await pool.query('UPDATE usuarios SET nome = $1, email = $2, login = $3 WHERE id = $4', [nome, emailLimpo, loginNovo, id]);
        } else {
          await pool.query('UPDATE usuarios SET nome = $1, email = $2 WHERE id = $3', [nome, emailLimpo, id]);
        }
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Esse login já está em uso. Escolha outro.' });
        throw err;
      }
    }
  }

  res.json(atualizado);
}));

// Redefinir a senha de um usuário-com-login da rede. Usa a mesma regra de
// permissão da pirâmide (podeGerenciar): o candidato/admin redefine de qualquer
// um da rede; a liderança redefine apenas os apoiadores-com-login da própria
// subárvore (níveis 2 e 3). O alvo precisa existir em "usuarios" (ter login). A
// nova senha entra como temporária — a pessoa é obrigada a trocá-la no 1º acesso.
router.put('/:id/senha', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Para trocar a sua própria senha use "Minha Conta".' });
  }
  if (!(await podeGerenciar(req, id))) {
    return res.status(403).json({ error: 'Sem permissão para redefinir a senha deste cadastro.' });
  }
  const { rows } = await pool.query(
    "SELECT id, nome, login FROM usuarios WHERE id = $1 AND perfil IN ('lideranca','apoiador')",
    [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Esse cadastro não tem login — não há senha para redefinir.' });

  const { senha } = req.body || {};
  const novaSenha = senha && senha.length >= 4 ? senha : gerarSenhaTemporaria();
  const senhaHash = await hash(novaSenha);
  await pool.query('UPDATE usuarios SET senha_hash = $1, senha_temporaria = true WHERE id = $2', [senhaHash, id]);
  res.json({ senha: novaSenha, login: rows[0].login, nome: rows[0].nome });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!(await podeGerenciar(req, id))) return res.status(403).json({ error: 'Sem permissão para excluir este registro.' });
  await pool.query('DELETE FROM apoiadores WHERE id = $1', [id]);
  res.status(204).end();
}));

module.exports = router;
