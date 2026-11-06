const express = require('express');
const QRCode = require('qrcode');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const { registrar, diferencas } = require('../utils/auditoria');
const { publicUrl } = require('../config');
const M = require('../utils/mandato');
const painel = require('../services/mandatoPainel');
const modelos = require('../services/mandatoModelos');
const ia = require('../services/mandatoIa');
const { SQL_ARVORE_CANDIDATO, RECURSAO_SUBARVORE } = require('./apoiadores');

// Módulo Mandato (briefing de novembro/2026) — rotas com login.
//
// Arquivo próprio pelo mesmo motivo do mapas.js e do apuracao.js: não mexe na
// pirâmide, e misturar com apoiadores.js aumentaria o risco de quebrar a rede.
// A parte sem login (página pública, pedido do cidadão) está em
// routes/mandatoPublico.js.
//
// Quem é quem (utils/mandato.js): vereador (o candidato, ou admin/CG no
// workspace), chefe (Chefe de Gabinete), equipe (Equipe do Gabinete) e rede
// (Líder, Coordenador, Mobilizador). A rede só alcança o que o vereador abriu
// para ela, módulo por módulo — o padrão de todos é Interno.

const router = express.Router();
router.use(authRequired, resolveWorkspace, asyncHandler(M.contextoMandato));

// Id que não é UUID (link quebrado, tela antiga) viraria erro de sintaxe do
// Postgres e "Erro interno" na tela. Responde como registro inexistente.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: 'Registro não encontrado.' })));

const STATUS_DEMANDA = ['recebida', 'em_analise', 'encaminhada', 'aguardando_resposta', 'em_execucao', 'respondida', 'concluida', 'indeferida', 'arquivada', 'cancelada'];
const TIPOS_DEMANDA = ['pedido', 'reclamacao', 'sugestao', 'elogio', 'denuncia', 'informacao'];
const TIPOS_PROP = Object.keys(modelos.TIPOS);
const STATUS_PROP = ['em_elaboracao', 'protocolada', 'em_tramitacao', 'em_comissao', 'aprovada', 'rejeitada', 'sancionada', 'vetada', 'respondida', 'arquivada', 'retirada'];
const FASES_EMENDA = ['indicada', 'aprovada', 'empenhada', 'paga', 'executada', 'cancelada'];
const STATUS_AGENDA = ['pedido', 'confirmado', 'reagendado', 'recusado', 'realizado', 'cancelado'];
const FECHADAS = ['respondida', 'concluida', 'indeferida', 'arquivada', 'cancelada'];

// ─── Validação de campos ────────────────────────────────────────────────────
// Tudo o que chega do navegador é relido campo a campo; propriedade fora da
// lista é ignorada. criacao=false: campo ausente = não mexer.
async function lerCampos(spec, body, candidatoId, criacao) {
  const out = {};
  for (const [nome, r] of Object.entries(spec)) {
    const v = body?.[nome];
    if (v === undefined) {
      if (criacao && r.obrig) return { erro: `Preencha: ${r.rotulo}.` };
      if (criacao && r.padrao !== undefined) out[nome] = r.padrao;
      continue;
    }
    const vazio = v === null || v === '';
    let val = null;
    switch (r.tipo) {
      case 'texto':
        val = M.texto(v, r.max);
        if (val && r.min && val.length < r.min) return { erro: `${r.rotulo}: escreva pelo menos ${r.min} letras.` };
        if (val && r.url && !/^https:\/\/[^\s<>"']+$/i.test(val)) return { erro: `${r.rotulo}: use um endereço começando com https://` };
        break;
      case 'enum':
        if (!vazio) { if (!r.valores.includes(v)) return { erro: `${r.rotulo}: opção inválida.` }; val = v; }
        break;
      case 'int':
        if (!vazio) { const n = Number(v); if (!Number.isInteger(n) || n < r.min || n > r.max) return { erro: `${r.rotulo}: número inválido.` }; val = n; }
        break;
      case 'valor':
        if (!vazio) {
          const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
          if (!Number.isFinite(n) || n < 0 || n > 1e11) return { erro: `${r.rotulo}: valor inválido.` };
          val = Math.round(n * 100) / 100;
        }
        break;
      case 'data':
        if (!vazio) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return { erro: `${r.rotulo}: data inválida.` }; val = v; }
        break;
      case 'datahora':
        if (!vazio) { const d = new Date(v); if (isNaN(d.getTime())) return { erro: `${r.rotulo}: data e hora inválidas.` }; val = d.toISOString(); }
        break;
      case 'bool':
        val = v === true || v === 'true' || v === 1;
        break;
      case 'nicho':
        if (!vazio) {
          if (!UUID.test(String(v))) return { erro: `${r.rotulo}: nicho não encontrado.` };
          const { rows } = await pool.query('SELECT 1 FROM nichos WHERE id = $1 AND candidato_id = $2', [String(v), candidatoId]);
          if (!rows[0]) return { erro: `${r.rotulo}: nicho não encontrado.` };
          val = String(v);
        }
        break;
      case 'ref':
        if (!vazio) {
          if (!UUID.test(String(v))) return { erro: `${r.rotulo}: registro não encontrado.` };
          const { rows } = await pool.query(`SELECT 1 FROM ${r.tabela} WHERE id = $1 AND candidato_id = $2`, [String(v), candidatoId]);
          if (!rows[0]) return { erro: `${r.rotulo}: registro não encontrado.` };
          val = String(v);
        }
        break;
      default:
        continue;
    }
    if (r.obrig && (val === null || val === undefined)) return { erro: `Preencha: ${r.rotulo}.` };
    out[nome] = val;
  }
  return { valores: out };
}

// As travas do banco (CHECK) viram mensagem para a tela.
const MSG_CHECK = {
  mandato_demanda_sensivel_nao_publica: 'Demanda com dado sensível não pode ser publicada.',
  mandato_demanda_publica_tem_titulo: 'Para publicar, escreva o título público — sem nome, telefone ou endereço de ninguém.',
  mandato_foto_pessoas_autorizada: 'Foto com pessoas só pode ser publicada com autorização de imagem.',
  mandato_minuta_aprovacao_completa: 'Aprovação incompleta.',
};
function erroBanco(err, res) {
  if (err.code === '23514') return res.status(400).json({ error: MSG_CHECK[err.constraint] || 'Algum campo está fora do permitido.' });
  if (err.code === '22001') return res.status(400).json({ error: 'Texto longo demais em algum campo.' });
  throw err;
}

function insertSql(tabela, valores, extras) {
  const todos = { ...valores, ...extras };
  const cols = Object.keys(todos);
  return {
    sql: `INSERT INTO ${tabela} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    params: cols.map((c) => todos[c]),
  };
}
function updateSql(tabela, valores, id, candidatoId, comUpdatedAt = true) {
  const cols = Object.keys(valores);
  const sets = cols.map((c, i) => `${c} = $${i + 1}`);
  if (comUpdatedAt) sets.push('updated_at = now()');
  return {
    sql: `UPDATE ${tabela} SET ${sets.join(', ')} WHERE id = $${cols.length + 1} AND candidato_id = $${cols.length + 2} RETURNING *`,
    params: [...cols.map((c) => valores[c]), id, candidatoId],
  };
}

const quem = (req) => req.user.id;
const nomeDeQuem = (req) => req.user.nome;

// ─── Situação, configuração e visibilidade ─────────────────────────────────
function urlPublica(codigo) { return `${publicUrl}/?mandato=${codigo}`; }

router.get('/situacao', asyncHandler(async (req, res) => {
  const cfg = await M.configDoMandato(req.mandato.candidatoId);
  const { rows: cand } = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [req.mandato.candidatoId]);
  const base = {
    ativo: true,
    papel: req.mandato.papel,
    equipe: req.mandato.equipe,
    podeConfigurar: req.mandato.podeConfigurar,
    podeAprovar: req.mandato.podeAprovar,
    vis: req.mandato.vis,
    vereador: cfg.nome_publico || cand[0]?.nome || 'Vereador',
  };
  if (!req.mandato.equipe) return res.json(base);
  res.json({
    ...base,
    config: { ...cfg, url_publica: urlPublica(cfg.codigo_publico) },
    captcha: M.captchaConfigurado(),
    ia: await ia.situacao(req.mandato.candidatoId),
  });
}));

router.put('/config', asyncHandler(async (req, res) => {
  if (!req.mandato.podeConfigurar) return res.status(403).json({ error: 'Só o vereador ou o chefe de gabinete muda a configuração do mandato.' });
  const cfg = await M.configDoMandato(req.mandato.candidatoId);
  const lido = await lerCampos({
    nome_publico: { tipo: 'texto', max: 120, rotulo: 'Nome público' },
    cargo_publico: { tipo: 'texto', max: 80, rotulo: 'Cargo' },
    municipio_publico: { tipo: 'texto', max: 120, rotulo: 'Município' },
    apresentacao: { tipo: 'texto', max: 2000, rotulo: 'Apresentação' },
    contato_publico: { tipo: 'texto', max: 300, rotulo: 'Contato do gabinete' },
    prazo_resposta_dias: { tipo: 'int', min: 1, max: 90, rotulo: 'Prazo de resposta' },
  }, req.body, req.mandato.candidatoId, false);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  if (!Object.keys(lido.valores).length) return res.json(cfg);
  if (lido.valores.prazo_resposta_dias === null) delete lido.valores.prazo_resposta_dias;
  const cols = Object.keys(lido.valores);
  const { rows } = await pool.query(
    `UPDATE mandato_config SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, atualizado_por = $${cols.length + 1}, atualizado_em = now()
      WHERE candidato_id = $${cols.length + 2} RETURNING *`,
    [...cols.map((c) => lido.valores[c]), quem(req), req.mandato.candidatoId]
  );
  const mudou = diferencas(cfg, rows[0], cols);
  if (Object.keys(mudou).length) await registrar(req, { acao: 'mandato.config', alvoTipo: 'mandato', alvoId: req.mandato.candidatoId, detalhes: { campos: mudou } });
  res.json({ ...rows[0], url_publica: urlPublica(rows[0].codigo_publico) });
}));

// Regras 1, 5 e 6 do briefing: padrão interno, só vereador/chefe mudam,
// Público exige confirmação explícita, e fica registrado quem mudou e quando
// (atualizado_por/atualizado_em na linha + linha no log de auditoria).
router.put('/visibilidade/:modulo', asyncHandler(async (req, res) => {
  if (!req.mandato.podeConfigurar) return res.status(403).json({ error: 'Só o vereador ou o chefe de gabinete muda a visibilidade do mandato.' });
  const { modulo } = req.params;
  const nova = req.body?.visibilidade;
  if (!M.MODULOS.includes(modulo)) return res.status(400).json({ error: 'Módulo inválido.' });
  if (!M.VISIBILIDADES.includes(nova)) return res.status(400).json({ error: 'Visibilidade inválida.' });
  if (modulo === 'pagina_publica' && nova === 'rede') return res.status(400).json({ error: 'A página pública fica ligada ou desligada.' });
  if (nova === 'publico' && req.body?.confirmado !== true) {
    return res.status(400).json({ error: 'Confirme que leu o aviso antes de tornar o módulo público.', precisaConfirmar: true });
  }
  const antes = req.mandato.vis[modulo];
  await pool.query(
    `INSERT INTO mandato_visibilidade (candidato_id, modulo, visibilidade, atualizado_por, atualizado_em)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (candidato_id, modulo) DO UPDATE SET visibilidade = EXCLUDED.visibilidade,
       atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
    [req.mandato.candidatoId, modulo, nova, quem(req)]
  );
  if (antes !== nova) {
    await registrar(req, { acao: 'mandato.visibilidade', alvoTipo: 'mandato', alvoId: req.mandato.candidatoId, alvoNome: modulo, detalhes: { modulo, de: antes, para: nova } });
  }
  res.json({ modulo, visibilidade: nova });
}));

// Quem mudou a visibilidade e quando — lido do log de auditoria, que guarda
// o nome por cópia e sobrevive à exclusão de quem mudou.
router.get('/visibilidade/historico', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ocorrido_em, ator_nome, ator_perfil, como_admin, detalhes FROM auditoria
      WHERE candidato_id = $1 AND acao = 'mandato.visibilidade' ORDER BY id DESC LIMIT 50`, [req.mandato.candidatoId]
  );
  res.json(rows);
}));

router.get('/qrcode.svg', M.soEquipe, asyncHandler(async (req, res) => {
  const cfg = await M.configDoMandato(req.mandato.candidatoId);
  const svg = await QRCode.toString(urlPublica(cfg.codigo_publico), { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0f1f3d', light: '#ffffff' } });
  res.set('Content-Type', 'image/svg+xml').send(svg);
}));

// Equipe do gabinete (para escolher o responsável de uma demanda).
router.get('/equipe', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, perfil FROM usuarios
      WHERE ativo AND (id = $1 OR (criado_por = $1 AND perfil IN ('chefe_gabinete','assessor')))
      ORDER BY perfil = 'candidato' DESC, nome`, [req.mandato.candidatoId]
  );
  res.json(rows);
}));

// Busca de pessoa da rede para ligar a demanda ao apoiador de origem. Devolve
// o mínimo (nome, bairro, papel): a equipe do gabinete não navega a pirâmide
// da campanha — mandato e campanha ficam separados (regra 7 do briefing).
router.get('/pessoas', M.soEquipe, asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  const { rows } = await pool.query(
    `SELECT id, nome, regiao, cidade, nivel FROM (${SQL_ARVORE_CANDIDATO}) t WHERE lower(nome) LIKE $2 ORDER BY nome LIMIT 20`,
    [req.mandato.candidatoId, `%${q.replace(/[%_]/g, '')}%`]
  );
  res.json(rows);
}));

// ─── Demandas ──────────────────────────────────────────────────────────────
// Ids da rede de quem está logado (ele mesmo + todos abaixo), para a
// liderança ver só as demandas que vieram da rede dela.
async function subarvoreDe(usuarioId) {
  const { rows } = await pool.query(`${RECURSAO_SUBARVORE} SELECT id FROM arvore`, [usuarioId]);
  return rows.map((r) => r.id);
}

async function prazoDoMandato(candidatoId) {
  const cfg = await M.configDoMandato(candidatoId);
  return new Date(Date.now() + cfg.prazo_resposta_dias * 86400000).toISOString();
}

const SPEC_DEMANDA_EQUIPE = {
  tipo: { tipo: 'enum', valores: TIPOS_DEMANDA, rotulo: 'Tipo', padrao: 'pedido' },
  titulo: { tipo: 'texto', max: 200, min: 3, obrig: true, rotulo: 'Título' },
  descricao: { tipo: 'texto', max: 4000, rotulo: 'Descrição' },
  categoria: { tipo: 'texto', max: 80, rotulo: 'Categoria' },
  bairro: { tipo: 'texto', max: 120, rotulo: 'Bairro' },
  cidade: { tipo: 'texto', max: 120, rotulo: 'Cidade' },
  nicho_id: { tipo: 'nicho', rotulo: 'Nicho' },
  solicitante_nome: { tipo: 'texto', max: 120, rotulo: 'Nome de quem pediu' },
  solicitante_contato: { tipo: 'texto', max: 120, rotulo: 'Contato de quem pediu' },
  dado_sensivel: { tipo: 'bool', rotulo: 'Dado sensível' },
  publicada: { tipo: 'bool', rotulo: 'Publicada' },
  titulo_publico: { tipo: 'texto', max: 200, rotulo: 'Título público' },
  encaminhada_para: { tipo: 'texto', max: 200, rotulo: 'Encaminhada para' },
  prazo_em: { tipo: 'datahora', rotulo: 'Prazo' },
};
// A rede cadastra só o pedido; status, publicação e prazo são da equipe.
const SPEC_DEMANDA_REDE = {
  tipo: SPEC_DEMANDA_EQUIPE.tipo, titulo: SPEC_DEMANDA_EQUIPE.titulo, descricao: SPEC_DEMANDA_EQUIPE.descricao,
  categoria: SPEC_DEMANDA_EQUIPE.categoria, bairro: SPEC_DEMANDA_EQUIPE.bairro, cidade: SPEC_DEMANDA_EQUIPE.cidade,
  nicho_id: SPEC_DEMANDA_EQUIPE.nicho_id, dado_sensivel: SPEC_DEMANDA_EQUIPE.dado_sensivel,
};

const SELECT_DEMANDA = `
  SELECT d.*, n.nome AS nicho_nome, ap.nome AS origem_nome, r.nome AS responsavel_nome, c.nome AS criado_por_nome,
         (d.status <> ALL($FECHADAS) AND d.prazo_em < now()) AS vencida,
         (SELECT count(*)::int FROM mandato_proposicao_demandas pd WHERE pd.demanda_id = d.id) AS proposicoes
    FROM mandato_demandas d
    LEFT JOIN nichos n ON n.id = d.nicho_id
    LEFT JOIN apoiadores ap ON ap.id = d.apoiador_origem_id
    LEFT JOIN usuarios r ON r.id = d.responsavel_id
    LEFT JOIN usuarios c ON c.id = d.criado_por`;

// O que a rede vê de uma demanda: a própria inteira; a da sua rede, sem o
// contato de quem pediu nem as notas internas.
function demandaParaRede(d, usuarioId) {
  const minha = d.criado_por === usuarioId;
  const base = {
    id: d.id, protocolo: d.protocolo, tipo: d.tipo, titulo: d.titulo, categoria: d.categoria, bairro: d.bairro,
    cidade: d.cidade, nicho_nome: d.nicho_nome, origem_nome: d.origem_nome, status: d.status, prazo_em: d.prazo_em,
    vencida: d.vencida, created_at: d.created_at, updated_at: d.updated_at, minha,
  };
  return minha ? { ...base, descricao: d.descricao, dado_sensivel: d.dado_sensivel } : base;
}

router.get('/demandas', M.exigeAbertoParaRede('demandas'), asyncHandler(async (req, res) => {
  const f = req.query;
  const cond = ['d.candidato_id = $1'];
  const params = [req.mandato.candidatoId, FECHADAS];
  const add = (sql, v) => { params.push(v); cond.push(sql.replace('?', `$${params.length}`)); };
  if (f.status && STATUS_DEMANDA.includes(f.status)) add('d.status = ?', f.status);
  if (f.abertas === '1') add('d.status <> ALL(?)', FECHADAS);
  if (f.vencidas === '1') { add('d.status <> ALL(?)', FECHADAS); cond.push('d.prazo_em < now()'); }
  if (f.tipo && TIPOS_DEMANDA.includes(f.tipo)) add('d.tipo = ?', f.tipo);
  if (f.bairro) add("lower(trim(d.bairro)) = lower(trim(?))", String(f.bairro));
  if (f.nicho) add('d.nicho_id::text = ?', String(f.nicho));
  if (f.origem && ['gabinete', 'rede', 'publico'].includes(f.origem)) add('d.origem = ?', f.origem);
  if (f.q) {
    params.push(`%${String(f.q).slice(0, 80).replace(/[%_]/g, '')}%`);
    cond.push(`(d.titulo ILIKE $${params.length} OR d.protocolo ILIKE $${params.length})`);
  }
  if (!req.mandato.equipe) {
    const ids = await subarvoreDe(req.user.id);
    params.push(req.user.id); const pMeu = params.length;
    params.push(ids); const pIds = params.length;
    cond.push(`(d.criado_por = $${pMeu} OR d.apoiador_origem_id = ANY($${pIds}))`);
  }
  const { rows } = await pool.query(
    `${SELECT_DEMANDA.replace('$FECHADAS', '$2')} WHERE ${cond.join(' AND ')} ORDER BY d.created_at DESC LIMIT 1000`, params
  );
  res.json(req.mandato.equipe ? rows : rows.map((d) => demandaParaRede(d, req.user.id)));
}));

async function carregarDemanda(req, id) {
  const { rows } = await pool.query(
    `${SELECT_DEMANDA.replace('$FECHADAS', '$3')} WHERE d.id = $1 AND d.candidato_id = $2`,
    [id, req.mandato.candidatoId, FECHADAS]
  );
  const d = rows[0];
  if (!d) return null;
  if (req.mandato.equipe) return d;
  if (d.criado_por === req.user.id) return d;
  if (d.apoiador_origem_id && (await subarvoreDe(req.user.id)).includes(d.apoiador_origem_id)) return d;
  return null;
}

router.get('/demandas/:id', M.exigeAbertoParaRede('demandas'), asyncHandler(async (req, res) => {
  const d = await carregarDemanda(req, req.params.id);
  if (!d) return res.status(404).json({ error: 'Demanda não encontrada.' });
  const { rows: and } = await pool.query(
    `SELECT id, status_de, status_para, nota, visivel_solicitante, autor_nome, created_at FROM mandato_demanda_andamentos
      WHERE demanda_id = $1 ${req.mandato.equipe ? '' : 'AND visivel_solicitante'} ORDER BY created_at`, [d.id]
  );
  const { rows: props } = await pool.query(
    `SELECT p.id, p.tipo, p.numero, p.ano, p.ementa, p.status FROM mandato_proposicao_demandas pd
      JOIN mandato_proposicoes p ON p.id = pd.proposicao_id WHERE pd.demanda_id = $1
      ${req.mandato.equipe ? '' : 'AND p.publicada'}`, [d.id]
  );
  const base = req.mandato.equipe ? d : demandaParaRede(d, req.user.id);
  res.json({ ...base, andamentos: and, proposicoes_ligadas: props });
}));

router.post('/demandas', M.exigeAbertoParaRede('demandas'), asyncHandler(async (req, res) => {
  const equipe = req.mandato.equipe;
  const lido = await lerCampos(equipe ? SPEC_DEMANDA_EQUIPE : SPEC_DEMANDA_REDE, req.body, req.mandato.candidatoId, true);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  const v = lido.valores;
  // Apoiador de origem: a equipe escolhe qualquer pessoa da rede; a liderança,
  // ela mesma ou alguém da rede dela.
  let origemId = req.body?.apoiador_origem_id ? String(req.body.apoiador_origem_id) : null;
  if (origemId) {
    if (!UUID.test(origemId)) return res.status(400).json({ error: 'A pessoa de origem não está na rede.' });
    const ok = equipe
      ? (await pool.query(`SELECT 1 FROM (${SQL_ARVORE_CANDIDATO}) t WHERE id = $2`, [req.mandato.candidatoId, origemId])).rows[0]
      : (await subarvoreDe(req.user.id)).includes(origemId);
    if (!ok) return res.status(400).json({ error: 'A pessoa de origem não está na rede.' });
  } else if (!equipe) {
    origemId = req.user.id; // a ficha da liderança tem o mesmo id do login
    const { rows } = await pool.query('SELECT 1 FROM apoiadores WHERE id = $1', [origemId]);
    if (!rows[0]) origemId = null;
  }
  if (v.dado_sensivel) { v.publicada = false; }
  const extras = {
    candidato_id: req.mandato.candidatoId,
    origem: equipe ? 'gabinete' : 'rede',
    criado_por: quem(req),
    apoiador_origem_id: origemId,
    status: 'recebida',
    prazo_em: v.prazo_em || await prazoDoMandato(req.mandato.candidatoId),
  };
  delete v.prazo_em;
  if (!equipe) { v.publicada = false; }
  const { sql, params } = insertSql('mandato_demandas', v, extras);
  let d;
  try { ({ rows: [d] } = await pool.query(sql, params)); } catch (err) { return erroBanco(err, res); }
  await pool.query(
    'INSERT INTO mandato_demanda_andamentos (demanda_id, status_para, nota, autor_id, autor_nome) VALUES ($1,$2,$3,$4,$5)',
    [d.id, 'recebida', 'Demanda registrada.', quem(req), nomeDeQuem(req)]
  );
  await registrar(req, { acao: 'mandato.demanda.criar', alvoTipo: 'demanda', alvoId: d.id, alvoNome: d.protocolo, detalhes: { titulo: d.titulo, origem: d.origem } });
  res.status(201).json(d);
}));

router.put('/demandas/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows: [antes] } = await pool.query('SELECT * FROM mandato_demandas WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!antes) return res.status(404).json({ error: 'Demanda não encontrada.' });
  const lido = await lerCampos(SPEC_DEMANDA_EQUIPE, req.body, req.mandato.candidatoId, false);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  const v = lido.valores;
  if (v.prazo_em === null) delete v.prazo_em;
  if (req.body?.responsavel_id !== undefined) {
    const r = req.body.responsavel_id || null;
    if (r && !UUID.test(String(r))) return res.status(400).json({ error: 'Responsável precisa ser da equipe do gabinete.' });
    if (r) {
      const { rows } = await pool.query(
        "SELECT 1 FROM usuarios WHERE id = $1 AND (id = $2 OR (criado_por = $2 AND perfil IN ('chefe_gabinete','assessor')))", [r, req.mandato.candidatoId]
      );
      if (!rows[0]) return res.status(400).json({ error: 'Responsável precisa ser da equipe do gabinete.' });
    }
    v.responsavel_id = r;
  }
  if (req.body?.apoiador_origem_id !== undefined) {
    const o = req.body.apoiador_origem_id || null;
    if (o && !UUID.test(String(o))) return res.status(400).json({ error: 'A pessoa de origem não está na rede.' });
    if (o && !(await pool.query(`SELECT 1 FROM (${SQL_ARVORE_CANDIDATO}) t WHERE id = $2`, [req.mandato.candidatoId, o])).rows[0]) {
      return res.status(400).json({ error: 'A pessoa de origem não está na rede.' });
    }
    v.apoiador_origem_id = o;
  }
  // Marcar como sensível tira da publicação na mesma hora.
  if (v.dado_sensivel === true) v.publicada = false;
  if (!Object.keys(v).length) return res.json(antes);
  const { sql, params } = updateSql('mandato_demandas', v, antes.id, req.mandato.candidatoId);
  let d;
  try { ({ rows: [d] } = await pool.query(sql, params)); } catch (err) { return erroBanco(err, res); }
  const mudou = diferencas(antes, d, Object.keys(v));
  if (Object.keys(mudou).length) await registrar(req, { acao: 'mandato.demanda.editar', alvoTipo: 'demanda', alvoId: d.id, alvoNome: d.protocolo, detalhes: { campos: mudou } });
  res.json(d);
}));

// Andamento: troca de status e/ou nota. É o registro da resposta ao
// solicitante (canal de contato); nota interna fica com visivel_solicitante=false.
router.post('/demandas/:id/andamentos', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows: [d] } = await pool.query('SELECT * FROM mandato_demandas WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!d) return res.status(404).json({ error: 'Demanda não encontrada.' });
  const status = req.body?.status || null;
  if (status && !STATUS_DEMANDA.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
  const nota = M.texto(req.body?.nota, 4000);
  if (!nota && (!status || status === d.status)) return res.status(400).json({ error: 'Escreva uma nota ou escolha um novo status.' });
  const visivel = req.body?.visivel_solicitante !== false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (status && status !== d.status) {
      await client.query(
        `UPDATE mandato_demandas SET status = $1, updated_at = now(),
                concluida_em = CASE WHEN $1 = ANY($3) THEN COALESCE(concluida_em, now()) ELSE NULL END
          WHERE id = $2`, [status, d.id, FECHADAS]
      );
    }
    const { rows: [a] } = await client.query(
      `INSERT INTO mandato_demanda_andamentos (demanda_id, status_de, status_para, nota, visivel_solicitante, autor_id, autor_nome)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.id, status && status !== d.status ? d.status : null, status && status !== d.status ? status : null, nota, visivel, quem(req), nomeDeQuem(req)]
    );
    await client.query('COMMIT');
    if (status && status !== d.status) {
      await registrar(req, { acao: 'mandato.demanda.status', alvoTipo: 'demanda', alvoId: d.id, alvoNome: d.protocolo, detalhes: { de: d.status, para: status } });
    }
    res.status(201).json(a);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/demandas/:id', M.soEquipe, asyncHandler(async (req, res) => {
  if (!req.mandato.podeConfigurar) return res.status(403).json({ error: 'Só o vereador ou o chefe de gabinete exclui uma demanda.' });
  const { rows } = await pool.query('DELETE FROM mandato_demandas WHERE id = $1 AND candidato_id = $2 RETURNING protocolo, titulo', [req.params.id, req.mandato.candidatoId]);
  if (!rows[0]) return res.status(404).json({ error: 'Demanda não encontrada.' });
  await registrar(req, { acao: 'mandato.demanda.excluir', alvoTipo: 'demanda', alvoId: req.params.id, alvoNome: rows[0].protocolo, detalhes: { titulo: rows[0].titulo } });
  res.status(204).end();
}));

// ─── Proposições, emendas e trabalhos (cadastros publicáveis) ──────────────
// Mesmo formato para os três: a equipe cadastra; a rede (e o público, pela
// página) só vê o que estiver marcado como publicado, e só se o módulo estiver
// aberto. CRUD gerado a partir da especificação de cada um.
const CADASTROS = {
  proposicoes: {
    tabela: 'mandato_proposicoes', modulo: 'proposicoes', alvo: 'proposicao', col: 'publicada', nome: 'ementa',
    ordem: 'COALESCE(x.protocolada_em, x.created_at::date) DESC, x.created_at DESC',
    spec: {
      tipo: { tipo: 'enum', valores: TIPOS_PROP, obrig: true, rotulo: 'Tipo' },
      numero: { tipo: 'texto', max: 30, rotulo: 'Número' },
      ano: { tipo: 'int', min: 1990, max: 2100, rotulo: 'Ano' },
      ementa: { tipo: 'texto', max: 1000, min: 3, obrig: true, rotulo: 'Ementa' },
      texto: { tipo: 'texto', max: 30000, rotulo: 'Texto' },
      status: { tipo: 'enum', valores: STATUS_PROP, rotulo: 'Situação', padrao: 'protocolada' },
      protocolada_em: { tipo: 'data', rotulo: 'Data do protocolo' },
      bairro: { tipo: 'texto', max: 120, rotulo: 'Bairro' },
      nicho_id: { tipo: 'nicho', rotulo: 'Nicho' },
      resposta: { tipo: 'texto', max: 5000, rotulo: 'Resposta' },
      publicada: { tipo: 'bool', rotulo: 'Publicada', padrao: false },
    },
    publicos: ['id', 'tipo', 'numero', 'ano', 'ementa', 'status', 'protocolada_em', 'bairro', 'resposta', 'nicho_nome'],
  },
  emendas: {
    tabela: 'mandato_emendas', modulo: 'emendas', alvo: 'emenda', col: 'publicada', nome: 'objeto',
    ordem: 'x.ano DESC, x.created_at DESC',
    spec: {
      ano: { tipo: 'int', min: 1990, max: 2100, obrig: true, rotulo: 'Ano' },
      numero: { tipo: 'texto', max: 30, rotulo: 'Número' },
      objeto: { tipo: 'texto', max: 500, min: 3, obrig: true, rotulo: 'Objeto' },
      valor: { tipo: 'valor', obrig: true, rotulo: 'Valor' },
      destino: { tipo: 'texto', max: 200, rotulo: 'Destino' },
      bairro: { tipo: 'texto', max: 120, rotulo: 'Bairro' },
      nicho_id: { tipo: 'nicho', rotulo: 'Nicho' },
      fase: { tipo: 'enum', valores: FASES_EMENDA, rotulo: 'Fase', padrao: 'indicada' },
      resposta_executivo: { tipo: 'texto', max: 5000, rotulo: 'Resposta do Executivo' },
      descricao_publica: { tipo: 'texto', max: 2000, rotulo: 'Descrição pública' },
      publicada: { tipo: 'bool', rotulo: 'Publicada', padrao: false },
    },
    publicos: ['id', 'ano', 'numero', 'objeto', 'valor', 'destino', 'bairro', 'fase', 'descricao_publica', 'nicho_nome'],
  },
  trabalhos: {
    tabela: 'mandato_trabalhos', modulo: 'trabalhos', alvo: 'trabalho', col: 'publicado', nome: 'titulo',
    ordem: 'COALESCE(x.realizado_em, x.created_at::date) DESC, x.created_at DESC',
    spec: {
      titulo: { tipo: 'texto', max: 200, min: 3, obrig: true, rotulo: 'Título' },
      descricao: { tipo: 'texto', max: 4000, rotulo: 'Descrição' },
      bairro: { tipo: 'texto', max: 120, rotulo: 'Bairro' },
      nicho_id: { tipo: 'nicho', rotulo: 'Nicho' },
      realizado_em: { tipo: 'data', rotulo: 'Data' },
      foto_url: { tipo: 'texto', max: 1000, url: true, rotulo: 'Endereço da foto' },
      foto_tem_pessoas: { tipo: 'bool', rotulo: 'Foto tem pessoas', padrao: false },
      autorizacao_imagem: { tipo: 'bool', rotulo: 'Autorização de imagem', padrao: false },
      demanda_id: { tipo: 'ref', tabela: 'mandato_demandas', rotulo: 'Demanda' },
      proposicao_id: { tipo: 'ref', tabela: 'mandato_proposicoes', rotulo: 'Proposição' },
      emenda_id: { tipo: 'ref', tabela: 'mandato_emendas', rotulo: 'Emenda' },
      publicado: { tipo: 'bool', rotulo: 'Publicado', padrao: false },
    },
    publicos: ['id', 'titulo', 'descricao', 'bairro', 'realizado_em', 'foto_url', 'foto_tem_pessoas', 'autorizacao_imagem', 'nicho_nome'],
  },
};

// Foto com pessoas sem autorização nunca sai para fora da equipe, mesmo que
// o item esteja publicado sem foto e a foto tenha sido trocada depois.
function limparParaFora(tipo, item, publicos) {
  const o = Object.fromEntries(publicos.map((k) => [k, item[k]]));
  if (tipo === 'trabalhos') {
    if (o.foto_tem_pessoas && !o.autorizacao_imagem) o.foto_url = null;
    delete o.foto_tem_pessoas; delete o.autorizacao_imagem;
  }
  return o;
}

for (const [tipo, c] of Object.entries(CADASTROS)) {
  router.get(`/${tipo}`, M.exigeAbertoParaRede(c.modulo), asyncHandler(async (req, res) => {
    const soPublicados = !req.mandato.equipe;
    const extra = tipo === 'proposicoes'
      ? ', (SELECT count(*)::int FROM mandato_proposicao_demandas pd WHERE pd.proposicao_id = x.id) AS demandas'
      : '';
    const { rows } = await pool.query(
      `SELECT x.*, n.nome AS nicho_nome ${extra} FROM ${c.tabela} x LEFT JOIN nichos n ON n.id = x.nicho_id
        WHERE x.candidato_id = $1 ${soPublicados ? `AND x.${c.col}` : ''} ORDER BY ${c.ordem} LIMIT 2000`,
      [req.mandato.candidatoId]
    );
    res.json(soPublicados ? rows.map((r) => limparParaFora(tipo, r, c.publicos)) : rows);
  }));

  router.post(`/${tipo}`, M.soEquipe, asyncHandler(async (req, res) => {
    const lido = await lerCampos(c.spec, req.body, req.mandato.candidatoId, true);
    if (lido.erro) return res.status(400).json({ error: lido.erro });
    const { sql, params } = insertSql(c.tabela, lido.valores, { candidato_id: req.mandato.candidatoId, criado_por: quem(req) });
    let item;
    try { ({ rows: [item] } = await pool.query(sql, params)); } catch (err) { return erroBanco(err, res); }
    if (tipo === 'proposicoes') await ligarDemandas(item.id, req.body?.demandas, req.mandato.candidatoId);
    await registrar(req, { acao: `mandato.${c.alvo}.criar`, alvoTipo: c.alvo, alvoId: item.id, alvoNome: String(item[c.nome]).slice(0, 120) });
    res.status(201).json(item);
  }));

  router.put(`/${tipo}/:id`, M.soEquipe, asyncHandler(async (req, res) => {
    const { rows: [antes] } = await pool.query(`SELECT * FROM ${c.tabela} WHERE id = $1 AND candidato_id = $2`, [req.params.id, req.mandato.candidatoId]);
    if (!antes) return res.status(404).json({ error: 'Registro não encontrado.' });
    const lido = await lerCampos(c.spec, req.body, req.mandato.candidatoId, false);
    if (lido.erro) return res.status(400).json({ error: lido.erro });
    let item = antes;
    if (Object.keys(lido.valores).length) {
      const { sql, params } = updateSql(c.tabela, lido.valores, antes.id, req.mandato.candidatoId);
      try { ({ rows: [item] } = await pool.query(sql, params)); } catch (err) { return erroBanco(err, res); }
    }
    if (tipo === 'proposicoes' && req.body?.demandas !== undefined) await ligarDemandas(item.id, req.body.demandas, req.mandato.candidatoId, true);
    const mudou = diferencas(antes, item, Object.keys(lido.valores));
    if (Object.keys(mudou).length) await registrar(req, { acao: `mandato.${c.alvo}.editar`, alvoTipo: c.alvo, alvoId: item.id, alvoNome: String(item[c.nome]).slice(0, 120), detalhes: { campos: mudou } });
    res.json(item);
  }));

  router.delete(`/${tipo}/:id`, M.soEquipe, asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`DELETE FROM ${c.tabela} WHERE id = $1 AND candidato_id = $2 RETURNING ${c.nome} AS nome`, [req.params.id, req.mandato.candidatoId]);
    if (!rows[0]) return res.status(404).json({ error: 'Registro não encontrado.' });
    await registrar(req, { acao: `mandato.${c.alvo}.excluir`, alvoTipo: c.alvo, alvoId: req.params.id, alvoNome: String(rows[0].nome).slice(0, 120) });
    res.status(204).end();
  }));
}

// Vínculo proposição × demandas. Demanda de outro mandato é descartada.
async function ligarDemandas(proposicaoId, lista, candidatoId, substituir = false) {
  if (!Array.isArray(lista)) return;
  const ids = [...new Set(lista.map(String))].slice(0, 200);
  if (substituir) await pool.query('DELETE FROM mandato_proposicao_demandas WHERE proposicao_id = $1', [proposicaoId]);
  if (!ids.length) return;
  await pool.query(
    `INSERT INTO mandato_proposicao_demandas (proposicao_id, demanda_id)
     SELECT $1, d.id FROM mandato_demandas d WHERE d.candidato_id = $2 AND d.id::text = ANY($3)
     ON CONFLICT DO NOTHING`, [proposicaoId, candidatoId, ids]
  );
}

router.get('/proposicoes/:id/demandas', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.protocolo, d.titulo, d.status FROM mandato_proposicao_demandas pd
       JOIN mandato_demandas d ON d.id = pd.demanda_id
       JOIN mandato_proposicoes p ON p.id = pd.proposicao_id
      WHERE pd.proposicao_id = $1 AND p.candidato_id = $2 ORDER BY d.created_at`, [req.params.id, req.mandato.candidatoId]
  );
  res.json(rows);
}));

// ─── Agenda ────────────────────────────────────────────────────────────────
router.get('/agenda', M.exigeAbertoParaRede('agenda'), asyncHandler(async (req, res) => {
  if (req.mandato.equipe) {
    const { rows } = await pool.query(
      `SELECT a.*, u.nome AS solicitante_usuario FROM mandato_agenda a LEFT JOIN usuarios u ON u.id = a.solicitante_id
        WHERE a.candidato_id = $1 ORDER BY (a.status = 'pedido') DESC, COALESCE(a.marcado_para, a.created_at) DESC LIMIT 1000`,
      [req.mandato.candidatoId]
    );
    return res.json(rows);
  }
  const { rows } = await pool.query(
    `SELECT id, motivo, preferencia, status, marcado_para, local, resposta, created_at FROM mandato_agenda
      WHERE candidato_id = $1 AND solicitante_id = $2 ORDER BY created_at DESC`, [req.mandato.candidatoId, req.user.id]
  );
  res.json(rows);
}));

router.post('/agenda', M.exigeAbertoParaRede('agenda'), asyncHandler(async (req, res) => {
  const equipe = req.mandato.equipe;
  const lido = await lerCampos({
    motivo: { tipo: 'texto', max: 2000, min: 3, obrig: true, rotulo: 'Motivo' },
    preferencia: { tipo: 'texto', max: 300, rotulo: 'Melhor dia e horário' },
    ...(equipe ? {
      solicitante_nome: { tipo: 'texto', max: 120, rotulo: 'Com quem' },
      solicitante_contato: { tipo: 'texto', max: 120, rotulo: 'Contato' },
      marcado_para: { tipo: 'datahora', rotulo: 'Data e hora' },
      local: { tipo: 'texto', max: 300, rotulo: 'Local' },
      status: { tipo: 'enum', valores: STATUS_AGENDA, rotulo: 'Situação' },
    } : {}),
  }, req.body, req.mandato.candidatoId, true);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  const v = lido.valores;
  const extras = equipe
    ? { origem: 'gabinete', status: v.status || (v.marcado_para ? 'confirmado' : 'pedido') }
    : { origem: 'rede', status: 'pedido', solicitante_id: req.user.id, solicitante_nome: req.user.nome };
  delete v.status;
  const { sql, params } = insertSql('mandato_agenda', v, { ...extras, candidato_id: req.mandato.candidatoId, atualizado_por: quem(req) });
  let a;
  try { ({ rows: [a] } = await pool.query(sql, params)); } catch (err) { return erroBanco(err, res); }
  await registrar(req, { acao: 'mandato.agenda.criar', alvoTipo: 'agenda', alvoId: a.id, detalhes: { origem: a.origem, status: a.status } });
  res.status(201).json(equipe ? a : { id: a.id, status: a.status });
}));

router.put('/agenda/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows: [antes] } = await pool.query('SELECT * FROM mandato_agenda WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!antes) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const lido = await lerCampos({
    motivo: { tipo: 'texto', max: 2000, min: 3, rotulo: 'Motivo' },
    preferencia: { tipo: 'texto', max: 300, rotulo: 'Preferência' },
    solicitante_nome: { tipo: 'texto', max: 120, rotulo: 'Com quem' },
    solicitante_contato: { tipo: 'texto', max: 120, rotulo: 'Contato' },
    status: { tipo: 'enum', valores: STATUS_AGENDA, rotulo: 'Situação' },
    marcado_para: { tipo: 'datahora', rotulo: 'Data e hora' },
    local: { tipo: 'texto', max: 300, rotulo: 'Local' },
    resposta: { tipo: 'texto', max: 2000, rotulo: 'Resposta' },
  }, req.body, req.mandato.candidatoId, false);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  // Motivo e situação não podem ficar vazios: campo vazio = não mexer.
  if (lido.valores.motivo === null) delete lido.valores.motivo;
  if (lido.valores.status === null) delete lido.valores.status;
  if (!Object.keys(lido.valores).length) return res.json(antes);
  lido.valores.atualizado_por = quem(req);
  const { sql, params } = updateSql('mandato_agenda', lido.valores, antes.id, req.mandato.candidatoId);
  const { rows: [a] } = await pool.query(sql, params);
  const mudou = diferencas(antes, a, ['status', 'marcado_para', 'local']);
  if (Object.keys(mudou).length) await registrar(req, { acao: 'mandato.agenda.editar', alvoTipo: 'agenda', alvoId: a.id, detalhes: { campos: mudou } });
  res.json(a);
}));

router.delete('/agenda/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM mandato_agenda WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!rowCount) return res.status(404).json({ error: 'Pedido não encontrado.' });
  await registrar(req, { acao: 'mandato.agenda.excluir', alvoTipo: 'agenda', alvoId: req.params.id });
  res.status(204).end();
}));

// ─── Enquetes ──────────────────────────────────────────────────────────────
// O voto individual nunca sai: só totais. No recorte por bairro/nicho, grupo
// com menos de MIN_GRUPO votos some (dentro de "outros"), porque num grupo de
// uma ou duas pessoas o total revelaria o voto de cada uma.
const MIN_GRUPO = 3;

async function totaisEnquetes(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    'SELECT enquete_id, escolha, count(*)::int AS n FROM mandato_enquete_votos WHERE enquete_id = ANY($1) GROUP BY 1, 2', [ids]
  );
  const m = new Map(ids.map((id) => [id, { a_favor: 0, contra: 0, abstencao: 0, total: 0 }]));
  for (const r of rows) { const t = m.get(r.enquete_id); t[r.escolha] = r.n; t.total += r.n; }
  return m;
}

router.get('/enquetes', M.exigeAbertoParaRede('enquetes'), asyncHandler(async (req, res) => {
  const equipe = req.mandato.equipe;
  const { rows } = await pool.query(
    `SELECT e.*, p.ementa AS proposicao_ementa, p.tipo AS proposicao_tipo, p.numero AS proposicao_numero, p.ano AS proposicao_ano
       FROM mandato_enquetes e LEFT JOIN mandato_proposicoes p ON p.id = e.proposicao_id
      WHERE e.candidato_id = $1 ${equipe ? '' : 'AND e.publicada'} ORDER BY e.created_at DESC`, [req.mandato.candidatoId]
  );
  const totais = await totaisEnquetes(rows.map((r) => r.id));
  let meus = new Map();
  if (!equipe) {
    const { rows: v } = await pool.query('SELECT enquete_id, escolha FROM mandato_enquete_votos WHERE usuario_id = $1 AND enquete_id = ANY($2)', [req.user.id, rows.map((r) => r.id)]);
    meus = new Map(v.map((x) => [x.enquete_id, x.escolha]));
  }
  res.json(rows.map((e) => ({
    id: e.id, pergunta: e.pergunta, descricao: e.descricao, encerra_em: e.encerra_em, publicada: e.publicada,
    aberta: !e.encerra_em || new Date(e.encerra_em) > new Date(), created_at: e.created_at,
    proposicao_id: e.proposicao_id,
    proposicao: e.proposicao_id ? { tipo: e.proposicao_tipo, numero: e.proposicao_numero, ano: e.proposicao_ano, ementa: e.proposicao_ementa } : null,
    totais: totais.get(e.id), meu_voto: equipe ? undefined : (meus.get(e.id) || null),
  })));
}));

const SPEC_ENQUETE = {
  pergunta: { tipo: 'texto', max: 300, min: 3, obrig: true, rotulo: 'Pergunta' },
  descricao: { tipo: 'texto', max: 2000, rotulo: 'Explicação' },
  proposicao_id: { tipo: 'ref', tabela: 'mandato_proposicoes', rotulo: 'Proposição' },
  encerra_em: { tipo: 'datahora', rotulo: 'Encerra em' },
  publicada: { tipo: 'bool', rotulo: 'Publicada', padrao: false },
};

router.post('/enquetes', M.soEquipe, asyncHandler(async (req, res) => {
  const lido = await lerCampos(SPEC_ENQUETE, req.body, req.mandato.candidatoId, true);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  const { sql, params } = insertSql('mandato_enquetes', lido.valores, { candidato_id: req.mandato.candidatoId, criado_por: quem(req) });
  const { rows: [e] } = await pool.query(sql, params);
  await registrar(req, { acao: 'mandato.enquete.criar', alvoTipo: 'enquete', alvoId: e.id, alvoNome: e.pergunta.slice(0, 120) });
  res.status(201).json(e);
}));

router.put('/enquetes/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const lido = await lerCampos(SPEC_ENQUETE, req.body, req.mandato.candidatoId, false);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  if (!Object.keys(lido.valores).length) return res.status(400).json({ error: 'Nada para salvar.' });
  const { sql, params } = updateSql('mandato_enquetes', lido.valores, req.params.id, req.mandato.candidatoId, false);
  const { rows: [e] } = await pool.query(sql, params);
  if (!e) return res.status(404).json({ error: 'Enquete não encontrada.' });
  await registrar(req, { acao: 'mandato.enquete.editar', alvoTipo: 'enquete', alvoId: e.id, alvoNome: e.pergunta.slice(0, 120), detalhes: { campos: Object.keys(lido.valores) } });
  res.json(e);
}));

router.delete('/enquetes/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM mandato_enquetes WHERE id = $1 AND candidato_id = $2 RETURNING pergunta', [req.params.id, req.mandato.candidatoId]);
  if (!rows[0]) return res.status(404).json({ error: 'Enquete não encontrada.' });
  await registrar(req, { acao: 'mandato.enquete.excluir', alvoTipo: 'enquete', alvoId: req.params.id, alvoNome: rows[0].pergunta.slice(0, 120) });
  res.status(204).end();
}));

// Votar: só a rede com login, um voto por pessoa (chave primária), só em
// enquete publicada e aberta. A equipe do gabinete não vota.
router.post('/enquetes/:id/voto', M.exigeAbertoParaRede('enquetes'), asyncHandler(async (req, res) => {
  if (req.mandato.equipe) return res.status(403).json({ error: 'A equipe do gabinete não vota nas enquetes.' });
  const escolha = req.body?.escolha;
  if (!['a_favor', 'contra', 'abstencao'].includes(escolha)) return res.status(400).json({ error: 'Escolha inválida.' });
  const { rows: [e] } = await pool.query(
    'SELECT id, encerra_em FROM mandato_enquetes WHERE id = $1 AND candidato_id = $2 AND publicada', [req.params.id, req.mandato.candidatoId]
  );
  if (!e) return res.status(404).json({ error: 'Enquete não encontrada.' });
  if (e.encerra_em && new Date(e.encerra_em) <= new Date()) return res.status(400).json({ error: 'Esta enquete já foi encerrada.' });
  try {
    await pool.query('INSERT INTO mandato_enquete_votos (enquete_id, usuario_id, escolha) VALUES ($1,$2,$3)', [e.id, req.user.id, escolha]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Você já votou nesta enquete.' });
    throw err;
  }
  res.status(201).json({ ok: true, totais: (await totaisEnquetes([e.id])).get(e.id) });
}));

router.get('/enquetes/:id/resultado', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows: [e] } = await pool.query('SELECT id, pergunta FROM mandato_enquetes WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!e) return res.status(404).json({ error: 'Enquete não encontrada.' });
  const [porBairro, porNicho] = await Promise.all([
    pool.query(
      `SELECT COALESCE(NULLIF(trim(a.regiao), ''), NULLIF(a.regiao, '—'), 'Bairro não informado') AS grupo, v.escolha, count(*)::int AS n
         FROM mandato_enquete_votos v LEFT JOIN apoiadores a ON a.id = v.usuario_id
        WHERE v.enquete_id = $1 GROUP BY 1, 2`, [e.id]
    ),
    pool.query(
      `SELECT COALESCE(n.nome, 'Sem nicho') AS grupo, v.escolha, count(*)::int AS n
         FROM mandato_enquete_votos v
         LEFT JOIN apoiador_nichos an ON an.apoiador_id = v.usuario_id
         LEFT JOIN nichos n ON n.id = an.nicho_id
        WHERE v.enquete_id = $1 GROUP BY 1, 2`, [e.id]
    ),
  ]);
  const agrupar = (rows) => {
    const g = new Map();
    for (const r of rows) {
      const nome = r.grupo === '—' ? 'Bairro não informado' : r.grupo;
      if (!g.has(nome)) g.set(nome, { grupo: nome, a_favor: 0, contra: 0, abstencao: 0, total: 0 });
      const x = g.get(nome); x[r.escolha] += r.n; x.total += r.n;
    }
    const visiveis = []; const outros = { grupo: `Outros (grupos com menos de ${MIN_GRUPO} votos)`, a_favor: 0, contra: 0, abstencao: 0, total: 0 };
    for (const x of g.values()) {
      if (x.total >= MIN_GRUPO) visiveis.push(x);
      else for (const k of ['a_favor', 'contra', 'abstencao', 'total']) outros[k] += x[k];
    }
    visiveis.sort((a, b) => b.total - a.total);
    if (outros.total >= MIN_GRUPO) visiveis.push(outros);
    else if (outros.total) visiveis.push({ grupo: outros.grupo, oculto: true, total: outros.total });
    return visiveis;
  };
  res.json({
    pergunta: e.pergunta,
    totais: (await totaisEnquetes([e.id])).get(e.id),
    porBairro: agrupar(porBairro.rows),
    // Uma pessoa pode estar em mais de um nicho: a soma por nicho passa do total.
    porNicho: agrupar(porNicho.rows),
    minimoGrupo: MIN_GRUPO,
  });
}));

// ─── Biblioteca de modelos e minutas (IA sempre com revisão humana) ────────
router.get('/modelos', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM mandato_modelos WHERE candidato_id = $1 ORDER BY tipo, titulo', [req.mandato.candidatoId]);
  res.json({
    tipos: modelos.TIPOS,
    modelos: [
      ...modelos.modelosGlobais().map((m) => ({ ...m, global: true })),
      ...rows.map((m) => ({ ...m, global: false })),
    ],
  });
}));

const SPEC_MODELO = {
  tipo: { tipo: 'enum', valores: TIPOS_PROP, obrig: true, rotulo: 'Tipo' },
  titulo: { tipo: 'texto', max: 200, min: 3, obrig: true, rotulo: 'Título' },
  nicho: { tipo: 'texto', max: 60, rotulo: 'Nicho' },
  corpo: { tipo: 'texto', max: 30000, min: 10, obrig: true, rotulo: 'Texto do modelo' },
  dicas: { tipo: 'texto', max: 5000, rotulo: 'Dicas' },
};
router.post('/modelos', M.soEquipe, asyncHandler(async (req, res) => {
  const lido = await lerCampos(SPEC_MODELO, req.body, req.mandato.candidatoId, true);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  const { sql, params } = insertSql('mandato_modelos', lido.valores, { candidato_id: req.mandato.candidatoId, criado_por: quem(req) });
  const { rows: [m] } = await pool.query(sql, params);
  res.status(201).json(m);
}));
router.put('/modelos/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const lido = await lerCampos(SPEC_MODELO, req.body, req.mandato.candidatoId, false);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  if (!Object.keys(lido.valores).length) return res.status(400).json({ error: 'Nada para salvar.' });
  const { sql, params } = updateSql('mandato_modelos', lido.valores, req.params.id, req.mandato.candidatoId, false);
  const { rows: [m] } = await pool.query(sql, params);
  if (!m) return res.status(404).json({ error: 'Modelo não encontrado (os modelos do RedeApoio não são editáveis — copie para um modelo seu).' });
  res.json(m);
}));
router.delete('/modelos/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM mandato_modelos WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!rowCount) return res.status(404).json({ error: 'Modelo não encontrado.' });
  res.status(204).end();
}));

async function modeloPorRef(ref, candidatoId) {
  if (!ref) return null;
  if (String(ref).startsWith('g:')) return modelos.modeloGlobal(String(ref));
  const { rows } = await pool.query('SELECT * FROM mandato_modelos WHERE id::text = $1 AND candidato_id = $2', [String(ref), candidatoId]);
  return rows[0] || null;
}

router.get('/minutas', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.tipo, m.titulo, m.status, m.origem, m.created_at, m.editado_em, m.aprovado_em, m.aprovado_nome,
            m.proposicao_id, d.protocolo AS demanda_protocolo
       FROM mandato_minutas m LEFT JOIN mandato_demandas d ON d.id = m.demanda_id
      WHERE m.candidato_id = $1 ORDER BY m.created_at DESC LIMIT 500`, [req.mandato.candidatoId]
  );
  res.json(rows);
}));

router.get('/minutas/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows: [m] } = await pool.query(
    `SELECT m.*, d.protocolo AS demanda_protocolo, g.nome AS gerado_nome, e.nome AS editado_nome
       FROM mandato_minutas m LEFT JOIN mandato_demandas d ON d.id = m.demanda_id
       LEFT JOIN usuarios g ON g.id = m.gerado_por LEFT JOIN usuarios e ON e.id = m.editado_por
      WHERE m.id = $1 AND m.candidato_id = $2`, [req.params.id, req.mandato.candidatoId]
  );
  if (!m) return res.status(404).json({ error: 'Minuta não encontrada.' });
  // O texto aprovado ainda é o que está gravado? (o servidor nunca deixa
  // divergir, mas a tela mostra a conferência).
  res.json({ ...m, aprovacao_confere: m.status === 'aprovado' ? M.sha256(m.texto) === m.aprovado_hash : null });
}));

// Minuta manual: o texto do modelo vira um rascunho para a equipe editar.
router.post('/minutas', M.soEquipe, asyncHandler(async (req, res) => {
  const modelo = await modeloPorRef(req.body?.modelo_ref, req.mandato.candidatoId);
  const tipo = req.body?.tipo || modelo?.tipo;
  if (!TIPOS_PROP.includes(tipo)) return res.status(400).json({ error: 'Escolha o tipo de documento.' });
  const texto = M.texto(req.body?.texto, 30000) || modelo?.corpo;
  if (!texto) return res.status(400).json({ error: 'Escreva o texto ou escolha um modelo.' });
  const demandaId = req.body?.demanda_id || null;
  if (demandaId && !UUID.test(String(demandaId))) return res.status(400).json({ error: 'Demanda não encontrada.' });
  if (demandaId && !(await pool.query('SELECT 1 FROM mandato_demandas WHERE id = $1 AND candidato_id = $2', [demandaId, req.mandato.candidatoId])).rows[0]) {
    return res.status(400).json({ error: 'Demanda não encontrada.' });
  }
  const { rows: [m] } = await pool.query(
    `INSERT INTO mandato_minutas (candidato_id, tipo, titulo, modelo_ref, demanda_id, texto, origem, gerado_por)
     VALUES ($1,$2,$3,$4,$5,$6,'manual',$7) RETURNING *`,
    [req.mandato.candidatoId, tipo, M.texto(req.body?.titulo, 200) || modelo?.titulo || modelos.TIPOS[tipo], modelo?.id || null, demandaId, texto, quem(req)]
  );
  res.status(201).json(m);
}));

// Minuta gerada por IA: nasce rascunho, sempre.
router.post('/minutas/ia', M.soEquipe, asyncHandler(async (req, res) => {
  const modelo = await modeloPorRef(req.body?.modelo_ref, req.mandato.candidatoId);
  const tipo = req.body?.tipo || modelo?.tipo;
  if (!TIPOS_PROP.includes(tipo)) return res.status(400).json({ error: 'Escolha o tipo de documento.' });
  const pedido = M.texto(req.body?.pedido, 3000);
  let demanda = null;
  if (req.body?.demanda_id) {
    if (!UUID.test(String(req.body.demanda_id))) return res.status(400).json({ error: 'Demanda não encontrada.' });
    ({ rows: [demanda] } = await pool.query('SELECT id, titulo, titulo_publico, categoria, bairro FROM mandato_demandas WHERE id = $1 AND candidato_id = $2', [req.body.demanda_id, req.mandato.candidatoId]));
    if (!demanda) return res.status(400).json({ error: 'Demanda não encontrada.' });
  }
  if (!pedido && !demanda) return res.status(400).json({ error: 'Diga o que a minuta precisa tratar, ou escolha uma demanda.' });
  const cfg = await M.configDoMandato(req.mandato.candidatoId);
  let gerada;
  try {
    gerada = await ia.gerarMinuta(req.mandato.candidatoId, quem(req), { tipoNome: modelos.TIPOS[tipo], modelo, municipio: cfg.municipio_publico, demanda, pedido });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  const texto = gerada.observacoes ? `${gerada.texto}\n\n---\nPONTOS PARA A EQUIPE CONFERIR (apague antes de protocolar):\n${gerada.observacoes}` : gerada.texto;
  const { rows: [m] } = await pool.query(
    `INSERT INTO mandato_minutas (candidato_id, tipo, titulo, modelo_ref, demanda_id, pedido, texto, origem, modelo_ia, gerado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ia',$8,$9) RETURNING *`,
    [req.mandato.candidatoId, tipo, gerada.titulo || modelos.TIPOS[tipo], modelo?.id || null, demanda?.id || null, pedido, texto, gerada.modelo, quem(req)]
  );
  await registrar(req, { acao: 'ia.minuta.gerar', alvoTipo: 'minuta', alvoId: m.id, alvoNome: m.titulo.slice(0, 120), detalhes: { tipo, modelo_ia: gerada.modelo } });
  res.status(201).json(m);
}));

// Editar: se estava aprovada, volta a rascunho e perde a aprovação — o que
// foi aprovado é o texto exato (docs/04, padrão de IA com aprovação humana).
router.put('/minutas/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows: [m] } = await pool.query('SELECT * FROM mandato_minutas WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!m) return res.status(404).json({ error: 'Minuta não encontrada.' });
  if (m.status === 'descartado') return res.status(400).json({ error: 'Minuta descartada não pode ser editada.' });
  const texto = req.body?.texto !== undefined ? M.texto(req.body.texto, 30000) : m.texto;
  const titulo = req.body?.titulo !== undefined ? (M.texto(req.body.titulo, 200) || m.titulo) : m.titulo;
  if (!texto) return res.status(400).json({ error: 'O texto não pode ficar vazio.' });
  const mudouTexto = texto !== m.texto;
  const { rows: [nova] } = await pool.query(
    `UPDATE mandato_minutas SET texto = $1, titulo = $2, editado_por = $3, editado_em = now(),
            status = CASE WHEN $4 THEN 'rascunho' ELSE status END,
            aprovado_por = CASE WHEN $4 THEN NULL ELSE aprovado_por END,
            aprovado_nome = CASE WHEN $4 THEN NULL ELSE aprovado_nome END,
            aprovado_em = CASE WHEN $4 THEN NULL ELSE aprovado_em END,
            aprovado_hash = CASE WHEN $4 THEN NULL ELSE aprovado_hash END
      WHERE id = $5 RETURNING *`, [texto, titulo, quem(req), mudouTexto, m.id]
  );
  if (mudouTexto && m.status === 'aprovado') {
    await registrar(req, { acao: 'ia.minuta.reaberta', alvoTipo: 'minuta', alvoId: m.id, alvoNome: m.titulo.slice(0, 120), detalhes: { motivo: 'texto editado depois da aprovação' } });
  }
  res.json(nova);
}));

// Aprovar: quem e quando vêm da sessão, nunca do navegador. O hash amarra a
// aprovação ao texto exato que estava gravado no momento.
router.post('/minutas/:id/aprovar', M.soEquipe, asyncHandler(async (req, res) => {
  if (!req.mandato.podeAprovar) return res.status(403).json({ error: 'Só o vereador ou o chefe de gabinete aprova uma minuta.' });
  const { rows: [m] } = await pool.query('SELECT * FROM mandato_minutas WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!m) return res.status(404).json({ error: 'Minuta não encontrada.' });
  if (m.status !== 'rascunho') return res.status(400).json({ error: 'Só um rascunho pode ser aprovado.' });
  // A tela manda o hash do texto que a pessoa leu: se alguém editou no meio
  // tempo, aprovar recusaria o texto que ela não viu.
  if (req.body?.hash && req.body.hash !== M.sha256(m.texto)) {
    return res.status(409).json({ error: 'A minuta foi alterada enquanto você lia. Abra de novo e confira antes de aprovar.' });
  }
  const { rows: [nova] } = await pool.query(
    `UPDATE mandato_minutas SET status = 'aprovado', aprovado_por = $1, aprovado_nome = $2, aprovado_em = now(), aprovado_hash = $3
      WHERE id = $4 AND status = 'rascunho' RETURNING *`, [quem(req), nomeDeQuem(req), M.sha256(m.texto), m.id]
  );
  if (!nova) return res.status(409).json({ error: 'A minuta mudou de situação. Abra de novo.' });
  await registrar(req, { acao: 'ia.aprovar', alvoTipo: 'minuta', alvoId: m.id, alvoNome: m.titulo.slice(0, 120), detalhes: { origem: m.origem, tipo: m.tipo, hash: nova.aprovado_hash } });
  res.json(nova);
}));

router.post('/minutas/:id/descartar', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows: [m] } = await pool.query(
    `UPDATE mandato_minutas SET status = 'descartado', aprovado_por = NULL, aprovado_nome = NULL, aprovado_em = NULL, aprovado_hash = NULL
      WHERE id = $1 AND candidato_id = $2 AND proposicao_id IS NULL RETURNING id, titulo`, [req.params.id, req.mandato.candidatoId]
  );
  if (!m) return res.status(400).json({ error: 'Minuta não encontrada, ou já virou proposição.' });
  await registrar(req, { acao: 'ia.minuta.descartar', alvoTipo: 'minuta', alvoId: m.id, alvoNome: m.titulo.slice(0, 120) });
  res.json({ ok: true });
}));

// O efeito: a minuta vira proposição cadastrada. Só aprovada, e só se o texto
// gravado ainda for o que foi aprovado (conferido no banco, não na tela).
router.post('/minutas/:id/proposicao', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows: [m] } = await pool.query('SELECT * FROM mandato_minutas WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!m) return res.status(404).json({ error: 'Minuta não encontrada.' });
  if (m.status !== 'aprovado' || M.sha256(m.texto) !== m.aprovado_hash) {
    return res.status(400).json({ error: 'A minuta precisa estar aprovada, com o texto exato da aprovação, para virar proposição.' });
  }
  if (m.proposicao_id) return res.status(400).json({ error: 'Esta minuta já virou proposição.' });
  const ementa = M.texto(req.body?.ementa, 1000) || m.titulo;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [p] } = await client.query(
      `INSERT INTO mandato_proposicoes (candidato_id, tipo, ementa, texto, status, ano, criado_por)
       VALUES ($1,$2,$3,$4,'em_elaboracao',$5,$6) RETURNING *`,
      [req.mandato.candidatoId, m.tipo, ementa, m.texto, new Date().getFullYear(), quem(req)]
    );
    if (m.demanda_id) await client.query('INSERT INTO mandato_proposicao_demandas (proposicao_id, demanda_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, m.demanda_id]);
    await client.query('UPDATE mandato_minutas SET proposicao_id = $1 WHERE id = $2', [p.id, m.id]);
    await client.query('COMMIT');
    await registrar(req, { acao: 'mandato.proposicao.criar', alvoTipo: 'proposicao', alvoId: p.id, alvoNome: ementa.slice(0, 120), detalhes: { de_minuta: m.id, aprovada_por: m.aprovado_nome, aprovada_em: m.aprovado_em } });
    res.status(201).json(p);
  } catch (err) {
    await client.query('ROLLBACK');
    return erroBanco(err, res);
  } finally {
    client.release();
  }
}));

// ─── Perfil de atuação ─────────────────────────────────────────────────────
router.get('/atuacao', M.soEquipe, asyncHandler(async (req, res) => {
  const [cruzamento, focos] = await Promise.all([
    painel.cruzamentoAtuacao(req.mandato.candidatoId),
    pool.query("SELECT * FROM mandato_atuacao_focos WHERE candidato_id = $1 AND status <> 'descartado' ORDER BY (status = 'sugerido') DESC, updated_at DESC", [req.mandato.candidatoId]),
  ]);
  res.json({ ...cruzamento, focos: focos.rows, ia: await ia.situacao(req.mandato.candidatoId) });
}));

// A IA SUGERE; cada sugestão vira um foco 'sugerido' que o vereador adota,
// ajusta ou descarta. Nada é executado a partir dela.
router.post('/atuacao/sugerir', M.soEquipe, asyncHandler(async (req, res) => {
  const cruzamento = await painel.cruzamentoAtuacao(req.mandato.candidatoId);
  let sugestoes;
  try { sugestoes = await ia.sugerirAtuacao(req.mandato.candidatoId, quem(req), cruzamento); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
  const criados = [];
  for (const s of sugestoes) {
    const { rows: [f] } = await pool.query(
      `INSERT INTO mandato_atuacao_focos (candidato_id, recorte, alvo, diagnostico, acao, origem, status)
       VALUES ($1,$2,$3,$4,$5,'ia','sugerido') RETURNING *`, [req.mandato.candidatoId, s.recorte, s.alvo, s.diagnostico, s.acao]
    );
    criados.push(f);
  }
  await registrar(req, { acao: 'ia.atuacao.sugerir', alvoTipo: 'mandato', alvoId: req.mandato.candidatoId, detalhes: { sugestoes: criados.length } });
  res.status(201).json(criados);
}));

const SPEC_FOCO = {
  recorte: { tipo: 'enum', valores: ['bairro', 'nicho', 'tema'], obrig: true, rotulo: 'Recorte' },
  alvo: { tipo: 'texto', max: 200, obrig: true, rotulo: 'Bairro, nicho ou tema' },
  diagnostico: { tipo: 'texto', max: 2000, rotulo: 'Diagnóstico' },
  acao: { tipo: 'texto', max: 2000, min: 3, obrig: true, rotulo: 'Ação' },
};

router.post('/atuacao/focos', M.soEquipe, asyncHandler(async (req, res) => {
  const lido = await lerCampos(SPEC_FOCO, req.body, req.mandato.candidatoId, true);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  // Quem decide (vereador/chefe) já cria adotado; a equipe propõe.
  const decide = req.mandato.podeAprovar;
  const { sql, params } = insertSql('mandato_atuacao_focos', lido.valores, {
    candidato_id: req.mandato.candidatoId, origem: 'manual', status: decide ? 'adotado' : 'sugerido',
    ...(decide ? { decidido_por: quem(req), decidido_nome: nomeDeQuem(req), decidido_em: new Date().toISOString() } : {}),
  });
  const { rows: [f] } = await pool.query(sql, params);
  res.status(201).json(f);
}));

router.put('/atuacao/focos/:id', M.soEquipe, asyncHandler(async (req, res) => {
  const { rows: [antes] } = await pool.query('SELECT * FROM mandato_atuacao_focos WHERE id = $1 AND candidato_id = $2', [req.params.id, req.mandato.candidatoId]);
  if (!antes) return res.status(404).json({ error: 'Foco não encontrado.' });
  const lido = await lerCampos(SPEC_FOCO, req.body, req.mandato.candidatoId, false);
  if (lido.erro) return res.status(400).json({ error: lido.erro });
  const v = lido.valores;
  for (const k of ['recorte', 'alvo', 'acao']) if (v[k] === null) delete v[k];
  const status = req.body?.status;
  if (status !== undefined) {
    if (!['sugerido', 'adotado', 'descartado', 'concluido'].includes(status)) return res.status(400).json({ error: 'Situação inválida.' });
    if (status !== antes.status) {
      if (!req.mandato.podeAprovar) return res.status(403).json({ error: 'Quem escolhe o foco é o vereador ou o chefe de gabinete.' });
      Object.assign(v, { status, decidido_por: quem(req), decidido_nome: nomeDeQuem(req), decidido_em: new Date().toISOString() });
    }
  }
  if (!Object.keys(v).length) return res.json(antes);
  const { sql, params } = updateSql('mandato_atuacao_focos', v, antes.id, req.mandato.candidatoId);
  const { rows: [f] } = await pool.query(sql, params);
  if (v.status) await registrar(req, { acao: 'mandato.atuacao.decidir', alvoTipo: 'foco', alvoId: f.id, alvoNome: f.alvo, detalhes: { de: antes.status, para: f.status, origem: f.origem } });
  res.json(f);
}));

// ─── Painel e prestação de contas ──────────────────────────────────────────
router.get('/painel', M.soEquipe, asyncHandler(async (req, res) => {
  res.json(await painel.painel(req.mandato.candidatoId));
}));

router.get('/prestacao', M.exigeAbertoParaRede('prestacao_contas'), asyncHandler(async (req, res) => {
  const { de, ate } = painel.periodo(req.query);
  const agrupar = req.query.agrupar === 'nicho' ? 'nicho' : 'bairro';
  const r = await painel.agregados(req.mandato.candidatoId, { agrupar, de, ate, somentePublicados: !req.mandato.equipe });
  if (!req.mandato.equipe) {
    // Para fora da equipe vão só os agregados que o briefing lista: pedido,
    // feito e pendente. Prazo vencido é gestão interna.
    for (const g of [r.totais, ...r.grupos]) delete g.vencidas;
  }
  res.json(r);
}));

module.exports = router;
module.exports.lerCampos = lerCampos;
module.exports.erroBanco = erroBanco;
