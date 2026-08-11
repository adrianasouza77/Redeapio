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
//
// A busca é em DOIS passos, e a ordem importa. A primeira versão procurava o
// bairro no Brasil inteiro e pegava o primeiro resultado: numa campanha de
// Dourados-MS, "Centro" casou com Uraí-PR e o mapa espalhou bolhas por três
// estados — errado com cara de certo, que é o pior tipo de erro num relatório.
// Agora a CIDADE é localizada primeiro, e o bairro só é procurado dentro do
// retângulo dela. O que cair fora é descartado.
const VERSAO_GEO = 2; // linha gravada por versão anterior é reprocessada

// Lista os bairros da rede de quem está pedindo, cada um com a coordenada que
// já estiver no cache. Nunca chama serviço externo — é o que abre o mapa
// rápido. Quem ainda não tem coordenada volta com pendente=true e é resolvido
// pela rota de baixo, sob comando do usuário.
router.get('/geo', asyncHandler(async (req, res) => {
  const bairros = await bairrosDaRede(req);
  if (!bairros.length) return res.json({ bairros: [], cidades: [] });

  const cidades = cidadesDosBairros(bairros);
  const [cacheBairros, cacheCidades] = await Promise.all([
    buscarCacheBairros(bairros),
    buscarCacheCidades(cidades),
  ]);

  res.json({
    bairros: bairros.map((b) => {
      const c = cacheBairros.get(chaveGeo(b.cidade, b.estado, b.bairro));
      const atual = c && c.versao_geo >= VERSAO_GEO;
      return {
        bairro: b.bairro,
        cidade: b.cidade,
        estado: b.estado,
        lat: atual && c.encontrado ? c.lat : null,
        lng: atual && c.encontrado ? c.lng : null,
        // Só é pendente quem nunca foi consultado (ou foi por uma versão antiga
        // da busca). Bairro já procurado e não encontrado fica com
        // pendente=false para não entrar em fila eterna.
        pendente: !atual,
        naoEncontrado: !!atual && !c.encontrado,
        semCidade: !b.cidade,
      };
    }),
    // O frontend usa isto para juntar num único ponto, no centro da cidade, os
    // bairros que o OpenStreetMap não conhece — assim eles continuam contando
    // no mapa em vez de sumir.
    cidades: cidades.map((c) => {
      const g = cacheCidades.get(chaveCidade(c.cidade, c.estado));
      return {
        cidade: c.cidade,
        estado: c.estado,
        lat: g && g.encontrado ? g.lat : null,
        lng: g && g.encontrado ? g.lng : null,
        pendente: !g,
      };
    }),
  });
}));

// Descobre as coordenadas que faltam. É chamada em lotes pequenos porque o
// serviço externo (Nominatim/OpenStreetMap) exige no máximo 1 consulta por
// segundo — um lote de 8 já leva 8 segundos, e lote grande estouraria o tempo
// limite do Traefik. O frontend chama de novo enquanto sobrar pendente.
router.post('/geo/resolver', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const LOTE = 8;
  const bairros = await bairrosDaRede(req);
  const cidades = cidadesDosBairros(bairros);
  const cacheCidades = await buscarCacheCidades(cidades);

  let orcamento = LOTE;      // consultas externas que este lote ainda pode gastar
  let consultas = 0;         // consultas externas já feitas (para o 1 por segundo)
  let resolvidos = 0;        // quantos ganharam coordenada
  let cidadesFeitas = 0;     // itens que saíram da fila de pendentes...
  let processadosBairros = 0; // ...contados em itens, não em consultas

  // 1º as cidades: sem o retângulo da cidade não dá para procurar bairro nenhum.
  const cidadesPendentes = cidades.filter((c) => c.cidade && !cacheCidades.has(chaveCidade(c.cidade, c.estado)));
  for (const c of cidadesPendentes) {
    if (orcamento <= 0) break;
    if (consultas > 0) await esperar(1100);
    const achada = await geocodificarCidade(c);
    consultas++; orcamento--;
    await pool.query(
      `INSERT INTO geo_cidades (cidade, estado, lat, lng, bbox_sul, bbox_norte, bbox_oeste, bbox_leste, encontrado, tentativas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
       ON CONFLICT (lower(cidade), lower(estado)) DO UPDATE
         SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, bbox_sul=EXCLUDED.bbox_sul, bbox_norte=EXCLUDED.bbox_norte,
             bbox_oeste=EXCLUDED.bbox_oeste, bbox_leste=EXCLUDED.bbox_leste, encontrado=EXCLUDED.encontrado,
             tentativas=geo_cidades.tentativas+1, atualizado_em=now()`,
      [c.cidade, c.estado, achada ? achada.lat : null, achada ? achada.lng : null,
        achada ? achada.bbox.sul : null, achada ? achada.bbox.norte : null,
        achada ? achada.bbox.oeste : null, achada ? achada.bbox.leste : null, !!achada]
    );
    cidadesFeitas++;
    if (achada) { cacheCidades.set(chaveCidade(c.cidade, c.estado), { ...achada, encontrado: true }); resolvidos++; }
  }

  // 2º os bairros, cada um limitado ao retângulo da própria cidade.
  const cacheBairros = await buscarCacheBairros(bairros);
  const pendentes = bairros.filter((b) => {
    const c = cacheBairros.get(chaveGeo(b.cidade, b.estado, b.bairro));
    return !c || c.versao_geo < VERSAO_GEO;
  });

  for (const b of pendentes) {
    if (orcamento <= 0) break;
    const cidade = b.cidade ? cacheCidades.get(chaveCidade(b.cidade, b.estado)) : null;
    // Bairro sem cidade preenchida no cadastro, ou de cidade que o mapa não
    // conhece, é gravado como não encontrado SEM gastar consulta: procurar só
    // pelo nome do bairro é exatamente o que trazia a cidade errada.
    const podeProcurar = !!(cidade && cidade.encontrado && cidade.bbox);
    let ponto = null;
    let bairrosProcurados = 0;
    if (podeProcurar) {
      if (consultas > 0) await esperar(1100);
      // Pode gastar mais de uma consulta: se o Nominatim não achar, ainda tenta
      // o Photon. O orçamento é contado em consultas, e não em bairros, para o
      // lote não estourar o tempo limite do Traefik quando quase tudo falha.
      const busca = await geocodificarBairro(b, cidade.bbox);
      ponto = busca.ponto;
      consultas += busca.chamadas;
      orcamento -= busca.chamadas;
      bairrosProcurados = 1;
      if (ponto) resolvidos++;
    }
    processadosBairros += bairrosProcurados;
    await pool.query(
      `INSERT INTO geo_bairros (cidade, estado, bairro, lat, lng, encontrado, tentativas, versao_geo)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
       ON CONFLICT (lower(cidade), lower(estado), lower(bairro)) DO UPDATE
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, encontrado = EXCLUDED.encontrado,
             tentativas = geo_bairros.tentativas + 1, versao_geo = EXCLUDED.versao_geo,
             atualizado_em = now()`,
      [b.cidade, b.estado, b.bairro, ponto ? ponto.lat : null, ponto ? ponto.lng : null, !!ponto, VERSAO_GEO]
    );
  }

  // A conta é em ITENS que saíram da fila, não em consultas: bairro sem cidade
  // no cadastro é gravado sem gastar consulta nenhuma, e contá-lo como consulta
  // deixaria "restantes" travado num número que nunca chegava a zero.
  const restantes = (cidadesPendentes.length - cidadesFeitas) + (pendentes.length - processadosBairros);
  res.json({ processados: cidadesFeitas + processadosBairros, consultas, resolvidos, restantes: Math.max(0, restantes) });
}));

function chaveGeo(cidade, estado, bairro) {
  return `${(cidade || '').trim().toLowerCase()}|${(estado || '').trim().toLowerCase()}|${(bairro || '').trim().toLowerCase()}`;
}
function chaveCidade(cidade, estado) {
  return `${(cidade || '').trim().toLowerCase()}|${(estado || '').trim().toLowerCase()}`;
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function buscarCacheBairros(bairros) {
  const { rows } = await pool.query(
    `SELECT cidade, estado, bairro, lat, lng, encontrado, versao_geo FROM geo_bairros
     WHERE (lower(cidade), lower(estado), lower(bairro)) IN
           (SELECT lower(c), lower(e), lower(b) FROM unnest($1::text[], $2::text[], $3::text[]) AS t(c, e, b))`,
    [bairros.map((b) => b.cidade), bairros.map((b) => b.estado), bairros.map((b) => b.bairro)]
  );
  return new Map(rows.map((r) => [chaveGeo(r.cidade, r.estado, r.bairro), r]));
}

async function buscarCacheCidades(cidades) {
  if (!cidades.length) return new Map();
  const { rows } = await pool.query(
    `SELECT cidade, estado, lat, lng, bbox_sul, bbox_norte, bbox_oeste, bbox_leste, encontrado FROM geo_cidades
     WHERE (lower(cidade), lower(estado)) IN
           (SELECT lower(c), lower(e) FROM unnest($1::text[], $2::text[]) AS t(c, e))`,
    [cidades.map((c) => c.cidade), cidades.map((c) => c.estado)]
  );
  return new Map(rows.map((r) => [chaveCidade(r.cidade, r.estado), {
    lat: r.lat, lng: r.lng, encontrado: r.encontrado,
    bbox: r.bbox_sul == null ? null : { sul: r.bbox_sul, norte: r.bbox_norte, oeste: r.bbox_oeste, leste: r.bbox_leste },
  }]));
}

function cidadesDosBairros(bairros) {
  const mapa = new Map();
  for (const b of bairros) {
    if (!b.cidade) continue;
    mapa.set(chaveCidade(b.cidade, b.estado), { cidade: b.cidade, estado: b.estado });
  }
  return [...mapa.values()];
}

// Bairros distintos da rede de quem está logado, respeitando exatamente a mesma
// visibilidade da listagem de apoiadores (candidato vê a rede toda; liderança vê
// só a subárvore dela) — o mapa não pode mostrar bairro que a pessoa não veria.
//
// O agrupamento é por bairro+cidade, e a UF é preenchida a partir de qualquer
// cadastro do mesmo bairro que a tenha. Cada pessoa digita o endereço de um
// jeito: o mesmo "Jardim Paulista" aparecia como três bairros diferentes
// (com UF, sem UF, cidade em maiúscula) e cada um consumia uma consulta,
// enchendo a lista de "não reconhecidos" com duplicatas do mesmo lugar.
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
    const cidade = (a.cidade || '').trim();
    const estado = (a.estado || '').trim().toUpperCase();
    const chave = `${bairro.toLowerCase()}|${cidade.toLowerCase()}`;
    const item = mapa.get(chave);
    if (!item) { mapa.set(chave, { bairro, cidade, estado }); continue; }
    if (!item.estado && estado) item.estado = estado;
  }
  return [...mapa.values()];
}

// Brasil inteiro em caixa retangular — última rede de segurança, usada só na
// busca da cidade (a do bairro já é limitada ao retângulo da cidade).
const BBOX_BRASIL = { latMin: -34.0, latMax: 5.3, lngMin: -74.1, lngMax: -34.7 };
const dentroDoBrasil = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= BBOX_BRASIL.latMin && lat <= BBOX_BRASIL.latMax &&
  lng >= BBOX_BRASIL.lngMin && lng <= BBOX_BRASIL.lngMax;

async function consultarNominatim(parametros) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&' + parametros;
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
    return Array.isArray(dados) && dados[0] ? dados[0] : null;
  } catch {
    return null; // rede fora do ar não pode derrubar a requisição inteira
  } finally {
    clearTimeout(relogio);
  }
}

async function geocodificarCidade({ cidade, estado }) {
  const achado = await consultarNominatim(
    'featuretype=settlement&q=' + encodeURIComponent([cidade, estado, 'Brasil'].filter(Boolean).join(', '))
  );
  if (!achado) return null;
  const lat = parseFloat(achado.lat);
  const lng = parseFloat(achado.lon);
  if (!dentroDoBrasil(lat, lng)) return null;

  // boundingbox vem como [sul, norte, oeste, leste] em texto. Quando não vem
  // (resultado que é só um ponto), monta-se uma caixa de ~25km de lado ao redor
  // — grande o bastante para conter os bairros e pequena o bastante para não
  // deixar o bairro casar com a cidade vizinha.
  const bb = (achado.boundingbox || []).map(parseFloat);
  const bbox = bb.length === 4 && bb.every(Number.isFinite)
    ? { sul: bb[0], norte: bb[1], oeste: bb[2], leste: bb[3] }
    : { sul: lat - 0.22, norte: lat + 0.22, oeste: lng - 0.22, leste: lng + 0.22 };
  return { lat, lng, bbox };
}

// Compara nome de bairro ignorando acento, caixa e as palavras genéricas que
// metade dos cadastros escreve e a outra metade não ("Jardim América" x
// "América", "Vl. Cachoeirinha" x "Vila Cachoeirinha").
const GENERICOS = /\b(jardim|jd|vila|vl|parque|pq|residencial|resid|conjunto|habitacional|loteamento|lot|chacara|distrito|bairro|nucleo|setor)\b/g;
function nomeComparavel(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(GENERICOS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Duas fontes, nesta ordem, porque elas erram de formas diferentes:
//
//  1. Nominatim limitado ao retângulo da cidade. Quando encontra, é o resultado
//     mais confiável — é o bairro como lugar, não um ponto dentro dele. Mas a
//     maioria dos bairros brasileiros não está no índice de busca dele: numa
//     amostra de 8 bairros de Dourados, só 3 foram encontrados.
//
//  2. Photon (outro índice do mesmo OpenStreetMap), que devolve em qual bairro
//     cada resultado fica. Aqui o resultado NÃO é aceito de cara: só vale se o
//     bairro informado por ele bater com o que estamos procurando. Sem essa
//     conferência, "Jardim Paulista" voltaria como uma pizzaria no Jardim
//     América e "Jardim Guanabara" como uma rua no Jardim Carisma — erro
//     pequeno no mapa e grande no relatório, porque parece certo.
//
// O que as duas recusarem fica sem posição e o mapa agrupa no centro da cidade,
// declarando que é posição aproximada. Chutar uma coordenada seria pior.
async function geocodificarBairro({ bairro, cidade, estado }, bbox) {
  const dentroDaCidade = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= bbox.sul && lat <= bbox.norte && lng >= bbox.oeste && lng <= bbox.leste;

  const viewbox = [bbox.oeste, bbox.norte, bbox.leste, bbox.sul].join(',');
  const achado = await consultarNominatim(
    `bounded=1&viewbox=${encodeURIComponent(viewbox)}&q=`
    + encodeURIComponent([bairro, cidade, estado, 'Brasil'].filter(Boolean).join(', '))
  );
  let chamadas = 1;
  if (achado) {
    const lat = parseFloat(achado.lat);
    const lng = parseFloat(achado.lon);
    // Confere de novo em vez de confiar no bounded=1: o Nominatim devolve
    // resultado fora da viewbox quando não acha nada dentro dela.
    if (dentroDaCidade(lat, lng)) return { ponto: { lat, lng }, chamadas };
  }

  const candidatos = await consultarPhoton(bairro, cidade, bbox);
  chamadas++;
  const alvo = nomeComparavel(bairro);
  for (const c of candidatos) {
    if (!dentroDaCidade(c.lat, c.lng)) continue;
    if (cidade && c.cidade && nomeComparavel(c.cidade) !== nomeComparavel(cidade)) continue;
    if (nomeComparavel(c.nome) === alvo || nomeComparavel(c.distrito) === alvo) {
      return { ponto: { lat: c.lat, lng: c.lng }, chamadas };
    }
  }
  return { ponto: null, chamadas };
}

async function consultarPhoton(bairro, cidade, bbox) {
  const centroLat = (bbox.sul + bbox.norte) / 2;
  const centroLng = (bbox.oeste + bbox.leste) / 2;
  const url = 'https://photon.komoot.io/api/?limit=5'
    + `&lat=${centroLat}&lon=${centroLng}`
    + '&q=' + encodeURIComponent([bairro, cidade].filter(Boolean).join(', '));
  const cancelar = new AbortController();
  const relogio = setTimeout(() => cancelar.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: cancelar.signal,
      headers: { 'User-Agent': 'RedeApoio/1.0 (mapa de rede politica)', 'Accept-Language': 'pt-BR' },
    });
    if (!resp.ok) return [];
    const dados = await resp.json();
    return (dados.features || []).map((f) => ({
      nome: f.properties?.name,
      distrito: f.properties?.district,
      cidade: f.properties?.city,
      lat: f.geometry?.coordinates?.[1],
      lng: f.geometry?.coordinates?.[0],
    }));
  } catch {
    return []; // serviço fora do ar não pode derrubar a requisição inteira
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
