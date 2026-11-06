const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const M = require('../utils/mandato');
const painel = require('../services/mandatoPainel');

// Módulo Mandato — a parte SEM LOGIN: a página pública do vereador
// (/?mandato=<codigo>, a do QR Code), o pedido do cidadão, o pedido de agenda
// e a consulta do andamento pelo protocolo.
//
// Junto com routes/public.js, é a superfície pública do sistema que escreve
// no banco. Cuidado redobrado aqui:
//   - nada aparece se o módulo não foi contratado, se o contrato acabou ou se
//     a página pública está desligada (responde 404, igual a código inventado);
//   - cada módulo só aparece se o vereador o pôs em Público, e cada item só se
//     estiver marcado como publicado;
//   - o cidadão nunca escreve direto: a rota confere o módulo, exige
//     consentimento (LGPD), limita por IP e grava sempre com status inicial,
//     não publicada (é o que a Edge Function do briefing fazia);
//   - nome, contato e descrição de demanda NUNCA saem por aqui.

const router = express.Router();

const TIPOS_DEMANDA = ['pedido', 'reclamacao', 'sugestao', 'elogio', 'denuncia', 'informacao'];
const TEMPO_MINIMO_MS = 3000; // formulário enviado em menos de 3 s é robô

async function mandatoPorCodigo(codigo) {
  if (!/^[a-z0-9]{4,32}$/.test(String(codigo || ''))) return null;
  const { rows } = await pool.query(
    `SELECT c.*, u.modulo_mandato, u.data_desativacao, u.nome AS nome_candidato
       FROM mandato_config c JOIN usuarios u ON u.id = c.candidato_id
      WHERE c.codigo_publico = $1 AND u.perfil = 'candidato' AND u.ativo`, [codigo]
  );
  const m = rows[0];
  if (!m || !m.modulo_mandato) return null;
  if (m.data_desativacao && new Date(m.data_desativacao) <= new Date()) return null;
  const vis = await M.visibilidades(m.candidato_id);
  if (vis.pagina_publica !== 'publico') return null;
  return { ...m, vis };
}

const naoEncontrada = (res) => res.status(404).json({ error: 'Página não encontrada.' });
const aberto = (m, modulo) => m.vis[modulo] === 'publico';

// Proteção do canal aberto: campo-isca (robô preenche tudo), tempo mínimo,
// limite por IP e captcha quando configurado.
async function barrarRobo(req, res, chave) {
  const b = req.body || {};
  if (b.site) { res.status(400).json({ error: 'Não foi possível registrar.' }); return true; }
  if (!(Number(b.tempo_ms) >= TEMPO_MINIMO_MS)) { res.status(400).json({ error: 'Preencha o formulário com calma e envie de novo.' }); return true; }
  if (!M.limitarPorChave(`${chave}|${req.ip}`, 5, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Muitos envios seguidos deste aparelho. Tente de novo em alguns minutos.' }); return true;
  }
  if (!(await M.conferirCaptcha(b.captcha, req.ip))) { res.status(400).json({ error: 'Confirme que você não é um robô.' }); return true; }
  return false;
}

router.get('/:codigo', asyncHandler(async (req, res) => {
  const m = await mandatoPorCodigo(req.params.codigo);
  if (!m) return naoEncontrada(res);
  const id = m.candidato_id;
  const saida = {
    mandato: {
      nome: m.nome_publico || m.nome_candidato, cargo: m.cargo_publico, municipio: m.municipio_publico,
      apresentacao: m.apresentacao, contato: m.contato_publico, prazo_resposta_dias: m.prazo_resposta_dias,
    },
    modulos: Object.fromEntries(['demandas', 'agenda', 'proposicoes', 'emendas', 'trabalhos', 'enquetes', 'prestacao_contas'].map((k) => [k, aberto(m, k)])),
    captcha_sitekey: M.captchaConfigurado() ? process.env.TURNSTILE_SITEKEY : null,
  };
  const consultas = [];
  if (aberto(m, 'demandas')) {
    // Só pela visão pública: título público, sem nome, contato nem descrição,
    // e nunca demanda marcada como sensível.
    consultas.push(pool.query(
      `SELECT protocolo, titulo_publico AS titulo, categoria, bairro, status, created_at FROM mandato_demandas
        WHERE candidato_id = $1 AND publicada AND NOT dado_sensivel ORDER BY created_at DESC LIMIT 100`, [id]
    ).then((r) => { saida.demandas = r.rows; }));
  }
  if (aberto(m, 'proposicoes')) {
    consultas.push(pool.query(
      `SELECT tipo, numero, ano, ementa, status, protocolada_em, bairro, resposta FROM mandato_proposicoes
        WHERE candidato_id = $1 AND publicada ORDER BY COALESCE(protocolada_em, created_at::date) DESC LIMIT 300`, [id]
    ).then((r) => { saida.proposicoes = r.rows; }));
  }
  if (aberto(m, 'emendas')) {
    consultas.push(pool.query(
      `SELECT ano, numero, objeto, valor::float AS valor, destino, bairro, fase, descricao_publica FROM mandato_emendas
        WHERE candidato_id = $1 AND publicada ORDER BY ano DESC, created_at DESC LIMIT 300`, [id]
    ).then((r) => { saida.emendas = r.rows; }));
  }
  if (aberto(m, 'trabalhos')) {
    consultas.push(pool.query(
      `SELECT titulo, descricao, bairro, realizado_em,
              CASE WHEN foto_tem_pessoas AND NOT autorizacao_imagem THEN NULL ELSE foto_url END AS foto_url
         FROM mandato_trabalhos WHERE candidato_id = $1 AND publicado
        ORDER BY COALESCE(realizado_em, created_at::date) DESC LIMIT 300`, [id]
    ).then((r) => { saida.trabalhos = r.rows; }));
  }
  if (aberto(m, 'enquetes')) {
    // Só o total de cada opção. O cidadão sem login não vota: o briefing pede
    // voto de apoiador, e voto anônimo pela internet não tem como ser um por pessoa.
    consultas.push(pool.query(
      `SELECT e.id, e.pergunta, e.descricao, e.encerra_em,
              count(v.*) FILTER (WHERE v.escolha = 'a_favor')::int AS a_favor,
              count(v.*) FILTER (WHERE v.escolha = 'contra')::int AS contra,
              count(v.*) FILTER (WHERE v.escolha = 'abstencao')::int AS abstencao,
              count(v.*)::int AS total
         FROM mandato_enquetes e LEFT JOIN mandato_enquete_votos v ON v.enquete_id = e.id
        WHERE e.candidato_id = $1 AND e.publicada GROUP BY e.id ORDER BY e.created_at DESC LIMIT 50`, [id]
    ).then((r) => { saida.enquetes = r.rows.map(({ id: _id, ...x }) => x); }));
  }
  if (aberto(m, 'prestacao_contas')) {
    consultas.push(Promise.all([
      painel.agregados(id, { agrupar: 'bairro', somentePublicados: true }),
      painel.agregados(id, { agrupar: 'nicho', somentePublicados: true }),
    ]).then(([b, n]) => {
      for (const g of [b.totais, ...b.grupos, n.totais, ...n.grupos]) delete g.vencidas;
      saida.prestacao = { porBairro: b, porNicho: n };
    }));
  }
  await Promise.all(consultas);
  res.json(saida);
}));

// Pedido do cidadão. Volta o protocolo e um código de acompanhamento: o
// protocolo é sequencial, e só com o código dá para ver o andamento.
router.post('/:codigo/demandas', asyncHandler(async (req, res) => {
  const m = await mandatoPorCodigo(req.params.codigo);
  if (!m || !aberto(m, 'demandas')) return naoEncontrada(res);
  if (await barrarRobo(req, res, `dem|${m.candidato_id}`)) return;
  const b = req.body || {};
  if (b.consentimento !== true) return res.status(400).json({ error: 'É preciso aceitar o uso dos seus dados para registrar o pedido.' });
  const titulo = M.texto(b.titulo, 200);
  if (!titulo || titulo.length < 3) return res.status(400).json({ error: 'Escreva em poucas palavras o que você precisa.' });
  const tipo = TIPOS_DEMANDA.includes(b.tipo) ? b.tipo : 'pedido';
  // Teto por vereador e por dia, além do limite por IP: protege a fila da
  // equipe de uma avalanche vinda de muitos IPs.
  if (!M.limitarPorChave(`demdia|${m.candidato_id}`, 300, 24 * 3600 * 1000)) {
    return res.status(429).json({ error: 'O gabinete recebeu muitos pedidos hoje. Tente de novo amanhã.' });
  }
  const codigo = crypto.randomBytes(4).toString('hex').toUpperCase();
  const prazo = new Date(Date.now() + m.prazo_resposta_dias * 86400000).toISOString();
  const { rows: [d] } = await pool.query(
    `INSERT INTO mandato_demandas (candidato_id, tipo, titulo, descricao, categoria, bairro, cidade, origem,
        solicitante_nome, solicitante_contato, consentimento_em, consentimento_ip, codigo_acomp_hash,
        dado_sensivel, publicada, status, prazo_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'publico',$8,$9,now(),$10,$11,$12,false,'recebida',$13)
     RETURNING id, protocolo, prazo_em`,
    [m.candidato_id, tipo, titulo, M.texto(b.descricao, 4000), M.texto(b.categoria, 80), M.texto(b.bairro, 120), M.texto(b.cidade, 120),
      M.texto(b.nome, 120), M.texto(b.contato, 120), req.ip || null, M.sha256(codigo), b.dado_sensivel === true, prazo]
  );
  await pool.query(
    "INSERT INTO mandato_demanda_andamentos (demanda_id, status_para, nota, autor_nome) VALUES ($1,'recebida','Pedido recebido pela página do mandato.','Página pública')",
    [d.id]
  );
  await registrar(req, {
    acao: 'mandato.demanda.publica', alvoTipo: 'demanda', alvoId: d.id, alvoNome: d.protocolo,
    detalhes: { tipo }, ator: {}, candidatoId: m.candidato_id,
  });
  res.status(201).json({ protocolo: d.protocolo, codigo, prazo_em: d.prazo_em });
}));

router.post('/:codigo/agenda', asyncHandler(async (req, res) => {
  const m = await mandatoPorCodigo(req.params.codigo);
  if (!m || !aberto(m, 'agenda')) return naoEncontrada(res);
  if (await barrarRobo(req, res, `age|${m.candidato_id}`)) return;
  const b = req.body || {};
  if (b.consentimento !== true) return res.status(400).json({ error: 'É preciso aceitar o uso dos seus dados para pedir o horário.' });
  const nome = M.texto(b.nome, 120); const contato = M.texto(b.contato, 120); const motivo = M.texto(b.motivo, 2000);
  if (!nome || !contato) return res.status(400).json({ error: 'Informe seu nome e um telefone ou e-mail para o gabinete confirmar o horário.' });
  if (!motivo || motivo.length < 3) return res.status(400).json({ error: 'Conte em poucas palavras o assunto do encontro.' });
  const { rows: [a] } = await pool.query(
    `INSERT INTO mandato_agenda (candidato_id, origem, solicitante_nome, solicitante_contato, consentimento_em, motivo, preferencia, status)
     VALUES ($1,'publico',$2,$3,now(),$4,$5,'pedido') RETURNING id`,
    [m.candidato_id, nome, contato, motivo, M.texto(b.preferencia, 300)]
  );
  await registrar(req, { acao: 'mandato.agenda.publica', alvoTipo: 'agenda', alvoId: a.id, ator: {}, candidatoId: m.candidato_id });
  res.status(201).json({ ok: true });
}));

// Andamento pelo protocolo + código. Só o que a equipe marcou como visível
// para quem pediu; sem o nome de quem atendeu (vai como "Gabinete").
router.post('/:codigo/consulta', asyncHandler(async (req, res) => {
  const m = await mandatoPorCodigo(req.params.codigo);
  if (!m) return naoEncontrada(res);
  if (!M.limitarPorChave(`cons|${req.ip}`, 20, 15 * 60 * 1000)) return res.status(429).json({ error: 'Muitas consultas seguidas. Tente de novo em alguns minutos.' });
  const protocolo = String(req.body?.protocolo || '').trim().toUpperCase();
  const codigo = String(req.body?.codigo || '').trim().toUpperCase();
  const { rows: [d] } = await pool.query(
    `SELECT id, protocolo, tipo, titulo, status, prazo_em, created_at, codigo_acomp_hash FROM mandato_demandas
      WHERE candidato_id = $1 AND protocolo = $2`, [m.candidato_id, protocolo]
  );
  if (!d || !d.codigo_acomp_hash || d.codigo_acomp_hash !== M.sha256(codigo)) {
    return res.status(404).json({ error: 'Protocolo ou código não conferem.' });
  }
  const { rows: and } = await pool.query(
    `SELECT status_para, nota, created_at FROM mandato_demanda_andamentos
      WHERE demanda_id = $1 AND visivel_solicitante ORDER BY created_at`, [d.id]
  );
  res.json({ protocolo: d.protocolo, tipo: d.tipo, titulo: d.titulo, status: d.status, prazo_em: d.prazo_em, created_at: d.created_at, andamentos: and });
}));

module.exports = router;
