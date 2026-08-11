const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');

// Mapa mental — ferramenta de gestão do candidato (estrutura política, grupos,
// compromissos). NÃO tem relação com a pirâmide de apoiadores: é rascunho
// livre, sem regra de nível, limite ou LGPD.
//
// Arquivo separado, e não mais uma rota dentro de apoiadores.js, apesar da
// convenção do projeto de concentrar rotas: apoiadores.js já é o arquivo mais
// delicado do sistema (árvore recursiva, permissões, limites) e não tem nada a
// ver com isto. Misturar aumentaria o risco de mexer na pirâmide sem querer.
const router = express.Router();
router.use(authRequired, resolveWorkspace, requireRole('candidato', 'admin'));

// Tetos de tamanho. O mapa chega como JSON de um navegador e vai inteiro para
// uma coluna JSONB: sem limite, um laço no frontend (ou alguém curioso com o
// console aberto) enche o banco com um mapa de milhões de nós.
const MAX_NOS = 2000;
const MAX_PROFUNDIDADE = 20;
const MAX_TEXTO = 300;
const MAX_MAPAS = 30;
const CORES = ['#0f1f3d', '#c8a84b', '#276749', '#c53030', '#6b8ed6', '#8b5cf6', '#ea580c', '#0891b2'];

// Só o candidato dono (ou o admin dentro do workspace dele) enxerga os mapas.
function donoDoMapa(req) {
  return req.effectiveId;
}

// Reconstrói a árvore campo a campo em vez de aceitar o que veio. Assim um
// objeto com propriedades a mais (ou um "filhos" que na verdade é um número)
// nunca chega ao banco, e o formato salvo é sempre o mesmo que a tela espera.
function limparArvore(entrada, contador, profundidade) {
  if (!entrada || typeof entrada !== 'object') return null;
  if (contador.total >= MAX_NOS) return null;
  contador.total++;

  const texto = String(entrada.texto == null ? '' : entrada.texto)
    // Quebra de linha e caractere de controle viram espaço: o nó é uma caixinha
    // de uma linha só, e caractere invisível atrapalha a medida da largura.
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .slice(0, MAX_TEXTO);

  const no = {
    id: String(entrada.id || '').slice(0, 40) || `n${contador.total}`,
    texto,
    cor: CORES.includes(entrada.cor) ? entrada.cor : CORES[0],
    fechado: entrada.fechado === true,
    filhos: [],
  };

  // Nó de estado no mapa por localização. É o que liga o galho ao mapa do
  // Brasil: a UF pinta o estado e leva o clique até a árvore certa. Guardado
  // só quando é uma UF de verdade, para não sobrar "XX" pintando nada.
  const uf = String(entrada.uf || '').trim().toUpperCase();
  if (UFS.includes(uf)) no.uf = uf;

  if (Array.isArray(entrada.filhos) && profundidade < MAX_PROFUNDIDADE) {
    for (const filho of entrada.filhos) {
      const limpo = limparArvore(filho, contador, profundidade + 1);
      if (limpo) no.filhos.push(limpo);
    }
  }
  return no;
}

function limparDados(dados) {
  const contador = { total: 0 };
  const raiz = limparArvore(dados && dados.raiz, contador, 0);
  if (!raiz) return null;
  return { dados: { raiz }, nos: contador.total };
}

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

// O candidato escolhe LIVREMENTE o alcance do mapa: só o estado ("MS"), a
// cidade ("Dourados") ou o bairro ("Dourados — Centro"). Nada é obrigatório:
// mapa de tema ("Diretório estadual", "Campanha 2026") não tem lugar.
//
// O que vale é a cascata — cidade só existe dentro de um estado, e bairro só
// dentro de uma cidade. Sem isso sobra dado que não identifica lugar nenhum:
// "Centro" existe em toda cidade do Brasil, e foi exatamente esse tipo de
// registro solto que fez o mapa geográfico posicionar bairro no estado errado.
// Aqui a parte de baixo é descartada em vez de recusada, porque o formulário
// já impede a combinação — isto é a rede de segurança de quem chama a API direto.
function limparLugar(corpo) {
  const uf = String(corpo.estado || '').trim().toUpperCase().slice(0, 2);
  const estado = UFS.includes(uf) ? uf : null;
  const cidade = estado ? (String(corpo.cidade || '').trim().slice(0, 120) || null) : null;
  const bairro = cidade ? (String(corpo.bairro || '').trim().slice(0, 120) || null) : null;
  return { estado, cidade, bairro };
}

function mapaPadrao(titulo, tipo) {
  // No mapa por localização os galhos são os estados, e eles nascem quando o
  // candidato clica no mapa do Brasil — começar com galhos de exemplo aqui só
  // atrapalharia, porque teriam de ser apagados um a um.
  const filhos = tipo === 'geo' ? [] : [
    { id: 'n1', texto: 'Lideranças', cor: CORES[1], fechado: false, filhos: [] },
    { id: 'n2', texto: 'Grupos e entidades', cor: CORES[2], fechado: false, filhos: [] },
    { id: 'n3', texto: 'Compromissos', cor: CORES[4], fechado: false, filhos: [] },
  ];
  return {
    raiz: { id: 'raiz', texto: titulo || 'Minha campanha', cor: CORES[0], fechado: false, filhos },
  };
}

// A lista não devolve o campo "dados": com 30 mapas grandes seriam megabytes
// trafegados só para desenhar um seletor de nomes.
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, titulo, tipo, estado, cidade, bairro, atualizado_em,
            jsonb_array_length(COALESCE(dados->'raiz'->'filhos', '[]'::jsonb)) AS ramos
     FROM mapas_mentais WHERE candidato_id = $1
     ORDER BY COALESCE(estado,'zz'), COALESCE(cidade,'zz'), COALESCE(bairro,'zz'), titulo`,
    [donoDoMapa(req)]
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { rows: contagem } = await pool.query(
    'SELECT count(*)::int AS c FROM mapas_mentais WHERE candidato_id = $1',
    [donoDoMapa(req)]
  );
  if (contagem[0].c >= MAX_MAPAS) {
    return res.status(400).json({ error: `Limite de ${MAX_MAPAS} mapas atingido. Exclua algum antes de criar outro.` });
  }

  const titulo = String(req.body?.titulo || '').trim().slice(0, 120) || 'Novo mapa';
  const tipo = req.body?.tipo === 'geo' ? 'geo' : 'livre';
  // No mapa por localizacao o alcance e o Brasil inteiro; guardar um lugar fixo
  // aqui brigaria com os estados que viram galhos da arvore.
  const lugar = tipo === 'geo' ? { estado: null, cidade: null, bairro: null } : limparLugar(req.body || {});
  const { rows } = await pool.query(
    `INSERT INTO mapas_mentais (candidato_id, titulo, dados, tipo, estado, cidade, bairro)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, titulo, dados, tipo, estado, cidade, bairro, atualizado_em`,
    [donoDoMapa(req), titulo, mapaPadrao(lugar.bairro || lugar.cidade || titulo, tipo), tipo, lugar.estado, lugar.cidade, lugar.bairro]
  );
  res.status(201).json(rows[0]);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, dados, tipo, estado, cidade, bairro, atualizado_em FROM mapas_mentais WHERE id = $1 AND candidato_id = $2',
    [req.params.id, donoDoMapa(req)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Mapa não encontrado.' });
  res.json(rows[0]);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { rows: existe } = await pool.query(
    'SELECT id FROM mapas_mentais WHERE id = $1 AND candidato_id = $2',
    [req.params.id, donoDoMapa(req)]
  );
  if (!existe[0]) return res.status(404).json({ error: 'Mapa não encontrado.' });

  const campos = [];
  const vals = [];

  if (req.body?.titulo !== undefined) {
    const titulo = String(req.body.titulo).trim().slice(0, 120);
    if (!titulo) return res.status(400).json({ error: 'O mapa precisa de um nome.' });
    vals.push(titulo);
    campos.push(`titulo = $${vals.length}`);
  }

  if (req.body?.dados !== undefined) {
    const limpo = limparDados(req.body.dados);
    if (!limpo) return res.status(400).json({ error: 'Mapa inválido — falta o nó principal.' });
    if (limpo.nos >= MAX_NOS) {
      return res.status(400).json({ error: `O mapa passou de ${MAX_NOS} itens. Divida em mais de um mapa.` });
    }
    vals.push(limpo.dados);
    campos.push(`dados = $${vals.length}`);
  }

  // Os tres campos de lugar andam juntos: mandar "estado" sozinho apagaria a
  // cidade sem querer, entao o frontend envia os tres ou nenhum.
  if (req.body?.estado !== undefined || req.body?.cidade !== undefined || req.body?.bairro !== undefined) {
    const lugar = limparLugar(req.body);
    vals.push(lugar.estado); campos.push(`estado = $${vals.length}`);
    vals.push(lugar.cidade); campos.push(`cidade = $${vals.length}`);
    vals.push(lugar.bairro); campos.push(`bairro = $${vals.length}`);
  }

  if (!campos.length) return res.status(400).json({ error: 'Nada para salvar.' });

  vals.push(req.params.id, donoDoMapa(req));
  const { rows } = await pool.query(
    `UPDATE mapas_mentais SET ${campos.join(', ')}, atualizado_em = now()
     WHERE id = $${vals.length - 1} AND candidato_id = $${vals.length}
     RETURNING id, titulo, tipo, estado, cidade, bairro, atualizado_em`,
    vals
  );
  res.json(rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM mapas_mentais WHERE id = $1 AND candidato_id = $2',
    [req.params.id, donoDoMapa(req)]
  );
  if (!rowCount) return res.status(404).json({ error: 'Mapa não encontrado.' });
  res.status(204).end();
}));

module.exports = router;
module.exports.limparDados = limparDados; // usado pelos testes
