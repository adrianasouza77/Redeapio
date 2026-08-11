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
// Estas rotas ficam ANTES de qualquer rota com ':id' de propósito: o Express
// casa na ordem de declaração, e '/geo' seria engolido por '/:id'.
//
// Descobrir onde fica um bairro brasileiro é mais difícil do que parece. A
// primeira versão procurava o nome do bairro no Brasil inteiro e aceitava o
// primeiro resultado: numa campanha de Dourados-MS, "Centro" casou com Uraí-PR
// e o mapa espalhou bolhas por três estados — errado, mas com cara de certo,
// que é o pior defeito possível num relatório de campanha.
//
// Hoje são quatro tentativas, da mais confiável para a menos, e o que nenhuma
// resolver fica declaradamente sem posição (em vez de receber um chute):
//
//   1. LISTA DA CIDADE  — a lista de lugares do município é baixada de uma vez
//      (Overpass) e guardada. Casar o bairro contra ela não gasta consulta
//      nenhuma e é o caminho que resolve mais gente.
//   2. NOMINATIM        — busca por texto, limitada ao retângulo da cidade.
//   3. PHOTON           — outro índice do mesmo OpenStreetMap, que informa em
//      qual bairro cada resultado fica; só aceito se esse bairro bater com o
//      procurado. Sem a conferência, "Jardim Paulista" voltaria como uma
//      pizzaria no Jardim América.
//   4. PELAS RUAS       — para o bairro que ninguém conhece pelo nome, usa os
//      endereços dos próprios apoiadores. Só vale se duas ruas diferentes
//      caírem perto uma da outra; a posição é a média delas, e fica marcada
//      como aproximada.
//
// Medido com os bairros reais de uma campanha de Dourados: cerca de um terço
// deles não existe no OpenStreetMap sob nome nenhum (Guanabara, Pelicano,
// Maracanã, Vila Rosa...). Para esses não há automação possível — por isso
// existe a rota de posição manual, em que o candidato aponta no mapa uma vez e
// fica valendo para sempre.
const VERSAO_GEO = 3;        // linha gravada por versão anterior é reprocessada
const RAIO_CONCORDANCIA_KM = 3;  // duas ruas do mesmo bairro têm que cair perto

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
      // Posição marcada à mão nunca vira pendente, mesmo quando a versão da
      // busca automática sobe — senão o trabalho manual seria refeito do zero.
      const atual = c && (c.origem === 'manual' || c.versao_geo >= VERSAO_GEO);
      return {
        bairro: b.bairro,
        cidade: b.cidade,
        estado: b.estado,
        lat: atual && c.encontrado ? c.lat : null,
        lng: atual && c.encontrado ? c.lng : null,
        origem: atual && c.encontrado ? c.origem : null,
        pendente: !atual,
        naoEncontrado: !!atual && !c.encontrado,
        semCidade: !b.cidade,
      };
    }),
    // O frontend usa isto para juntar num único ponto, no centro da cidade, os
    // bairros que ninguém conhece — assim eles continuam contando no mapa.
    cidades: cidades.map((c) => {
      const g = cacheCidades.get(chaveCidade(c.cidade, c.estado));
      return {
        cidade: c.cidade,
        estado: c.estado,
        lat: g && g.encontrado ? g.lat : null,
        lng: g && g.encontrado ? g.lng : null,
        temLista: !!(g && g.lugaresEm),
        pendente: !g,
      };
    }),
  });
}));

// Lista oficial de lugares da cidade, para o candidato escolher o nome certo
// quando o que foi digitado não bate com nada ("PRQ ALVORADA" → Parque Alvorada).
router.get('/geo/lugares', asyncHandler(async (req, res) => {
  const cidade = String(req.query.cidade || '').trim();
  const estado = String(req.query.estado || '').trim().toUpperCase();
  if (!cidade) return res.json([]);
  const { rows } = await pool.query(
    `SELECT nome, tipo, lat, lng FROM geo_lugares
     WHERE lower(cidade) = lower($1) AND lower(estado) = lower($2)
     ORDER BY nome`,
    [cidade, estado]
  );
  res.json(rows);
}));

// Posição definida à mão: o candidato apontou no mapa (lat/lng) ou escolheu um
// nome da lista da cidade (nomeOficial). É a última palavra — nenhuma busca
// automática sobrescreve isso depois.
router.put('/geo/bairro', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const { bairro, cidade, estado, lat, lng, nomeOficial } = req.body || {};
  if (!bairro) return res.status(400).json({ error: 'Informe o bairro.' });

  let ponto = null;
  if (nomeOficial) {
    const { rows } = await pool.query(
      `SELECT lat, lng FROM geo_lugares
       WHERE lower(cidade) = lower($1) AND lower(estado) = lower($2) AND lower(nome) = lower($3)`,
      [cidade || '', estado || '', nomeOficial]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Esse lugar não está na lista da cidade.' });
    ponto = { lat: rows[0].lat, lng: rows[0].lng };
  } else {
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (!dentroDoBrasil(latNum, lngNum)) {
      return res.status(400).json({ error: 'Posição inválida — o ponto precisa estar no Brasil.' });
    }
    ponto = { lat: latNum, lng: lngNum };
  }

  await pool.query(
    `INSERT INTO geo_bairros (cidade, estado, bairro, lat, lng, encontrado, tentativas, versao_geo, origem)
     VALUES ($1,$2,$3,$4,$5,true,1,$6,'manual')
     ON CONFLICT (lower(cidade), lower(estado), lower(bairro)) DO UPDATE
       SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, encontrado = true,
           versao_geo = EXCLUDED.versao_geo, origem = 'manual', atualizado_em = now()`,
    [cidade || '', (estado || '').toUpperCase(), bairro, ponto.lat, ponto.lng, VERSAO_GEO]
  );
  res.json({ bairro, cidade, estado, ...ponto, origem: 'manual' });
}));

// Descobre as coordenadas que faltam. É chamada em lotes pequenos porque os
// serviços externos limitam a 1 consulta por segundo — um lote de 8 já leva 8
// segundos, e lote grande estouraria o tempo limite do Traefik. O frontend
// chama de novo enquanto sobrar pendente.
router.post('/geo/resolver', requireRole('candidato', 'admin'), asyncHandler(async (req, res) => {
  const LOTE = 8;
  const bairros = await bairrosDaRede(req);
  const cidades = cidadesDosBairros(bairros);
  const cacheCidades = await buscarCacheCidades(cidades);

  let orcamento = LOTE;      // consultas externas que este lote ainda pode gastar
  let consultas = 0;         // já feitas (controla a espera de 1 por segundo)
  let resolvidos = 0;
  let itensFeitos = 0;       // a fila anda em ITENS, não em consultas

  const gastar = async () => {
    if (consultas > 0) await esperar(1100);
    consultas++; orcamento--;
  };

  // 1º as cidades: sem o retângulo da cidade não dá para procurar bairro nenhum.
  const cidadesPendentes = cidades.filter((c) => c.cidade && !cacheCidades.has(chaveCidade(c.cidade, c.estado)));
  for (const c of cidadesPendentes) {
    if (orcamento <= 0) break;
    await gastar();
    const achada = await geocodificarCidade(c);
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
    itensFeitos++;
    if (achada) { cacheCidades.set(chaveCidade(c.cidade, c.estado), { ...achada, encontrado: true, lugaresEm: null }); resolvidos++; }
  }

  // 2º a lista de lugares de cada cidade: UMA consulta traz as centenas de
  // bairros do município de uma vez. É o melhor negócio da rotina inteira.
  const semLista = cidades.filter((c) => {
    const g = cacheCidades.get(chaveCidade(c.cidade, c.estado));
    return g && g.encontrado && !g.lugaresEm;
  });
  for (const c of semLista) {
    if (orcamento <= 0) break;
    await gastar();
    const lugares = await baixarLugaresDaCidade(c);
    if (lugares && lugares.length) {
      for (const l of lugares) {
        await pool.query(
          `INSERT INTO geo_lugares (cidade, estado, nome, tipo, lat, lng)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (lower(cidade), lower(estado), lower(nome)) DO UPDATE
             SET tipo=EXCLUDED.tipo, lat=EXCLUDED.lat, lng=EXCLUDED.lng, atualizado_em=now()`,
          [c.cidade, c.estado, l.nome, l.tipo, l.lat, l.lng]
        );
      }
    }
    // Marca como baixada mesmo quando volta vazia: o Overpass bloqueia quem
    // insiste, e cidade sem bairro mapeado não vai passar a ter na próxima.
    await pool.query(
      `UPDATE geo_cidades SET lugares_em = now() WHERE lower(cidade)=lower($1) AND lower(estado)=lower($2)`,
      [c.cidade, c.estado]
    );
    const g = cacheCidades.get(chaveCidade(c.cidade, c.estado));
    if (g) g.lugaresEm = new Date();
    itensFeitos++;
  }

  // 3º os bairros.
  const cacheBairros = await buscarCacheBairros(bairros);
  const pendentes = bairros.filter((b) => {
    const c = cacheBairros.get(chaveGeo(b.cidade, b.estado, b.bairro));
    return !c || (c.origem !== 'manual' && c.versao_geo < VERSAO_GEO);
  });

  for (const b of pendentes) {
    if (orcamento <= 0) break;
    const cidade = b.cidade ? cacheCidades.get(chaveCidade(b.cidade, b.estado)) : null;
    // Bairro sem cidade no cadastro é gravado como não encontrado SEM gastar
    // consulta: procurar só pelo nome do bairro é exatamente o que trazia a
    // cidade errada.
    const podeProcurar = !!(cidade && cidade.encontrado && cidade.bbox);
    let achado = null;
    if (podeProcurar) {
      achado = await localizarBairro(b, cidade, gastar, () => orcamento);
    }
    await pool.query(
      `INSERT INTO geo_bairros (cidade, estado, bairro, lat, lng, encontrado, tentativas, versao_geo, origem)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
       ON CONFLICT (lower(cidade), lower(estado), lower(bairro)) DO UPDATE
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, encontrado = EXCLUDED.encontrado,
             tentativas = geo_bairros.tentativas + 1, versao_geo = EXCLUDED.versao_geo,
             origem = EXCLUDED.origem, atualizado_em = now()`,
      [b.cidade, b.estado, b.bairro, achado ? achado.lat : null, achado ? achado.lng : null,
        !!achado, VERSAO_GEO, achado ? achado.origem : 'busca']
    );
    itensFeitos++;
    if (achado) resolvidos++;
  }

  const restantes = Math.max(0,
    (cidadesPendentes.length + semLista.length + pendentes.length) - itensFeitos);
  res.json({ processados: itensFeitos, consultas, resolvidos, restantes });
}));

// As quatro tentativas, em ordem. `gastar` cuida da espera de 1 por segundo e
// do orçamento do lote; `saldo` diz quanto ainda dá para gastar.
async function localizarBairro(b, cidade, gastar, saldo) {
  // 1. lista da cidade — de graça, já está no banco
  const daLista = await acharNaListaDaCidade(b);
  if (daLista) return { ...daLista, origem: 'busca' };

  const dentroDaCidade = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= cidade.bbox.sul && lat <= cidade.bbox.norte &&
    lng >= cidade.bbox.oeste && lng <= cidade.bbox.leste;

  // 2. Nominatim preso ao retângulo da cidade
  if (saldo() > 0) {
    await gastar();
    const viewbox = [cidade.bbox.oeste, cidade.bbox.norte, cidade.bbox.leste, cidade.bbox.sul].join(',');
    const achado = await consultarNominatim(
      `bounded=1&viewbox=${encodeURIComponent(viewbox)}&q=`
      + encodeURIComponent([b.bairro, b.cidade, b.estado, 'Brasil'].filter(Boolean).join(', '))
    );
    if (achado) {
      const lat = parseFloat(achado.lat);
      const lng = parseFloat(achado.lon);
      // Confere de novo em vez de confiar no bounded=1: o Nominatim devolve
      // resultado fora da viewbox quando não acha nada dentro dela.
      if (dentroDaCidade(lat, lng)) return { lat, lng, origem: 'busca' };
    }
  }

  // 3. Photon, aceitando só o resultado cujo bairro bate com o procurado
  if (saldo() > 0) {
    await gastar();
    const candidatos = await consultarPhoton(b.bairro, b.cidade, cidade.bbox);
    for (const c of candidatos) {
      if (!dentroDaCidade(c.lat, c.lng)) continue;
      if (b.cidade && c.cidade && !mesmoNome(c.cidade, b.cidade)) continue;
      if (mesmoNome(c.nome, b.bairro) || mesmoNome(c.distrito, b.bairro)) {
        return { lat: c.lat, lng: c.lng, origem: 'busca' };
      }
    }
  }

  // 4. pelas ruas dos próprios apoiadores do bairro
  return localizarPelasRuas(b, cidade, dentroDaCidade, gastar, saldo);
}

// Bairro que o mapa não conhece pelo nome ainda pode ser localizado pelas ruas
// de quem mora nele — a cobertura de RUAS no OpenStreetMap é muito melhor que a
// de bairros. O risco é a rua repetir nome em outra parte da cidade, então uma
// rua sozinha não vale: são necessárias duas caindo a menos de 3 km uma da
// outra. Se discordarem, é sinal de que o nome é ambíguo e nada é aceito.
async function localizarPelasRuas(b, cidade, dentroDaCidade, gastar, saldo) {
  const ruas = (b.ruas || []).slice(0, 3);
  if (ruas.length < 2) return null;

  const pontos = [];
  for (const rua of ruas) {
    if (saldo() <= 0) break;
    await gastar();
    const candidatos = await consultarPhoton(rua, b.cidade, cidade.bbox);
    const bom = candidatos.find((c) => dentroDaCidade(c.lat, c.lng) && mesmoNome(c.nome, rua));
    if (bom) pontos.push({ lat: bom.lat, lng: bom.lng });
    if (pontos.length >= 2) break;
  }
  if (pontos.length < 2) return null;

  const perto = distanciaKm(pontos[0], pontos[1]) <= RAIO_CONCORDANCIA_KM;
  if (!perto) return null;
  return {
    lat: (pontos[0].lat + pontos[1].lat) / 2,
    lng: (pontos[0].lng + pontos[1].lng) / 2,
    origem: 'rua',
  };
}

function distanciaKm(a, b) {
  const dLat = (a.lat - b.lat) * 111;
  const dLng = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

async function acharNaListaDaCidade(b) {
  if (!b.cidade) return null;
  const { rows } = await pool.query(
    `SELECT nome, lat, lng FROM geo_lugares WHERE lower(cidade)=lower($1) AND lower(estado)=lower($2)`,
    [b.cidade, b.estado]
  );
  for (const l of rows) if (mesmoNome(l.nome, b.bairro)) return { lat: l.lat, lng: l.lng };
  return null;
}

// A lista de lugares do município inteiro numa consulta só. Pega tanto o bairro
// mapeado como ponto (place=suburb) quanto o mapeado como área residencial
// nomeada, que é como boa parte dos loteamentos aparece.
async function baixarLugaresDaCidade({ cidade, estado }) {
  const consulta = `[out:json][timeout:60];
area["name"="${cidade.replace(/"/g, '')}"]["admin_level"="8"]["boundary"="administrative"]->.c;
(
  node(area.c)["place"~"^(suburb|neighbourhood|quarter|city_block|village|hamlet)$"];
  way(area.c)["place"~"^(suburb|neighbourhood|quarter|city_block)$"];
  relation(area.c)["place"~"^(suburb|neighbourhood|quarter|city_block)$"];
  way(area.c)["landuse"="residential"]["name"];
);
out center tags;`;
  const cancelar = new AbortController();
  const relogio = setTimeout(() => cancelar.abort(), 60000);
  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      signal: cancelar.signal,
      headers: { 'User-Agent': 'RedeApoio/1.0 (mapa de rede politica)', 'Content-Type': 'text/plain' },
      body: consulta,
    });
    if (!resp.ok) return null;
    const texto = await resp.text();
    // Quando está sobrecarregado, o Overpass responde XML de erro com status
    // 200 — sem esta checagem o JSON.parse derruba a requisição inteira.
    if (!texto.trim().startsWith('{')) return null;
    const dados = JSON.parse(texto);
    const vistos = new Set();
    const saida = [];
    for (const e of (dados.elements || [])) {
      const nome = e.tags && e.tags.name;
      const lat = e.lat != null ? e.lat : e.center && e.center.lat;
      const lng = e.lon != null ? e.lon : e.center && e.center.lon;
      if (!nome || lat == null || lng == null) continue;
      const chave = nome.toLowerCase();
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      saida.push({ nome, tipo: e.tags.place || (e.tags.landuse ? 'landuse=' + e.tags.landuse : null), lat, lng });
    }
    return saida;
  } catch {
    return null;
  } finally {
    clearTimeout(relogio);
  }
}

function chaveGeo(cidade, estado, bairro) {
  return `${(cidade || '').trim().toLowerCase()}|${(estado || '').trim().toLowerCase()}|${(bairro || '').trim().toLowerCase()}`;
}
function chaveCidade(cidade, estado) {
  return `${(cidade || '').trim().toLowerCase()}|${(estado || '').trim().toLowerCase()}`;
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function buscarCacheBairros(bairros) {
  const { rows } = await pool.query(
    `SELECT cidade, estado, bairro, lat, lng, encontrado, versao_geo, origem FROM geo_bairros
     WHERE (lower(cidade), lower(estado), lower(bairro)) IN
           (SELECT lower(c), lower(e), lower(b) FROM unnest($1::text[], $2::text[], $3::text[]) AS t(c, e, b))`,
    [bairros.map((b) => b.cidade), bairros.map((b) => b.estado), bairros.map((b) => b.bairro)]
  );
  return new Map(rows.map((r) => [chaveGeo(r.cidade, r.estado, r.bairro), r]));
}

async function buscarCacheCidades(cidades) {
  if (!cidades.length) return new Map();
  const { rows } = await pool.query(
    `SELECT cidade, estado, lat, lng, bbox_sul, bbox_norte, bbox_oeste, bbox_leste, encontrado, lugares_em
     FROM geo_cidades
     WHERE (lower(cidade), lower(estado)) IN
           (SELECT lower(c), lower(e) FROM unnest($1::text[], $2::text[]) AS t(c, e))`,
    [cidades.map((c) => c.cidade), cidades.map((c) => c.estado)]
  );
  return new Map(rows.map((r) => [chaveCidade(r.cidade, r.estado), {
    lat: r.lat, lng: r.lng, encontrado: r.encontrado, lugaresEm: r.lugares_em,
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
// jeito: o mesmo "Jardim Paulista" aparecia como três bairros diferentes (com
// UF, sem UF, cidade em maiúscula) e cada um consumia uma consulta, enchendo a
// lista de "não reconhecidos" com duplicatas do mesmo lugar.
//
// As ruas mais repetidas de cada bairro vêm junto: são a última chance de
// localizar quem não é encontrado pelo nome.
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
    let item = mapa.get(chave);
    if (!item) { item = { bairro, cidade, estado, contagemRuas: new Map() }; mapa.set(chave, item); }
    if (!item.estado && estado) item.estado = estado;
    const rua = nomeDaRua(a.endereco);
    if (rua) item.contagemRuas.set(rua, (item.contagemRuas.get(rua) || 0) + 1);
  }
  return [...mapa.values()].map((item) => ({
    bairro: item.bairro,
    cidade: item.cidade,
    estado: item.estado,
    ruas: [...item.contagemRuas.entries()].sort((x, y) => y[1] - x[1]).map(([r]) => r).slice(0, 3),
  }));
}

// "Rua Cuiabá, 574" e "R. Cuiabá n 574" viram "Rua Cuiabá": o número da casa
// atrapalha a busca e nunca ajuda a achar a rua.
function nomeDaRua(endereco) {
  const limpo = String(endereco || '')
    .split(',')[0]
    .replace(/\b(n|no|nº|num|numero)\.?\s*\d+.*$/i, '')
    .replace(/\s+\d+\s*$/, '')
    .trim();
  return limpo.length >= 5 ? limpo : null;
}

// Brasil inteiro em caixa retangular — última rede de segurança, usada na busca
// da cidade e na validação do ponto marcado à mão.
const BBOX_BRASIL = { latMin: -34.0, latMax: 5.3, lngMin: -74.1, lngMax: -34.7 };
const dentroDoBrasil = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= BBOX_BRASIL.latMin && lat <= BBOX_BRASIL.latMax &&
  lng >= BBOX_BRASIL.lngMin && lng <= BBOX_BRASIL.lngMax;

// Compara nome de bairro ignorando acento, caixa e as palavras genéricas que
// metade dos cadastros escreve e a outra metade não ("Jardim América" x
// "América", "PRQ ALVORADA" x "Parque Alvorada").
const GENERICOS = /\b(jardim|jardins|jd|vila|vl|parque|pq|prq|residencial|resid|res|conjunto|cj|cjto|habitacional|loteamento|lot|chacara|chacaras|condominio|cond|distrito|bairro|nucleo|setor|aldeia|area|rua|r|avenida|av)\b/g;
function nomeComparavel(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(GENERICOS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Só variações que são o MESMO nome escrito diferente: espaço a mais, plural,
// numeral romano x arábico, número de casa colado no fim. Nada de "distância de
// edição": "Vila Rosa" e "Vila Roma" diferem por uma letra e são bairros
// diferentes — casar por semelhança recria o erro que essa rotina existe para
// evitar.
function variacoesDoNome(s) {
  const base = nomeComparavel(s)
    .replace(/\biii\b/g, '3').replace(/\bii\b/g, '2').replace(/\bi\b/g, '1')
    .replace(/\s+\d{3,}$/, '')
    .trim();
  const semEspaco = base.replace(/\s+/g, '');
  return new Set([base, semEspaco, base.replace(/s\b/g, '').trim(), semEspaco.replace(/s$/, '')]
    .filter(Boolean));
}
function mesmoNome(a, b) {
  if (!a || !b) return false;
  const va = variacoesDoNome(a);
  for (const x of variacoesDoNome(b)) if (va.has(x)) return true;
  return false;
}

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

async function consultarPhoton(termo, cidade, bbox) {
  const centroLat = (bbox.sul + bbox.norte) / 2;
  const centroLng = (bbox.oeste + bbox.leste) / 2;
  const url = 'https://photon.komoot.io/api/?limit=5'
    + `&lat=${centroLat}&lon=${centroLng}`
    + '&q=' + encodeURIComponent([termo, cidade].filter(Boolean).join(', '));
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
      nome: f.properties && f.properties.name,
      distrito: f.properties && f.properties.district,
      cidade: f.properties && f.properties.city,
      lat: f.geometry && f.geometry.coordinates && f.geometry.coordinates[1],
      lng: f.geometry && f.geometry.coordinates && f.geometry.coordinates[0],
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
