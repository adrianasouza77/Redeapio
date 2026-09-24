const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const tse = require('../services/tse');
const historico = require('../services/historico');

// Desempenho eleitoral histórico. Só candidato (e admin no workspace): cruza a
// rede inteira com resultado de eleição, visão que a liderança não tem.
const router = express.Router();
router.use(authRequired, resolveWorkspace, requireRole('candidato', 'admin'));

const UFS = ['ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to'];

router.get('/eleicoes', (req, res) => {
  res.json({ eleicoes: historico.ELEICOES, cargos: historico.CARGOS });
});

router.get('/', asyncHandler(async (req, res) => {
  try {
    res.json(await historico.visaoGeral(req.effectiveId));
  } catch (e) {
    const cfg = await historico.carregarConfig(req.effectiveId);
    res.json({ config: cfg ? { ...cfg } : null, municipios: [], erro: `Não foi possível falar com o TSE: ${e.message}` });
  }
}));

// Todos os municípios do estado naquela eleição — para abrir um onde a rede
// ainda não tem ninguém (é justamente onde pode estar a oportunidade).
router.get('/municipios', asyncHandler(async (req, res) => {
  const cfg = await historico.carregarConfig(req.effectiveId);
  if (!cfg) return res.json([]);
  res.json(await tse.municipiosEleicao(cfg.ciclo, cfg.eleicao, cfg.uf).catch(() => []));
}));

router.get('/municipio/:codigo', asyncHandler(async (req, res) => {
  if (!/^\d{5}$/.test(req.params.codigo)) return res.status(400).json({ error: 'Município inválido.' });
  const d = await historico.detalhe(req.effectiveId, req.params.codigo);
  if (!d) return res.status(400).json({ error: 'Configure a eleição de referência primeiro.' });
  res.json(d);
}));

router.put('/config', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const el = historico.ELEICOES.find((e) => e.ciclo === b.ciclo && e.eleicao === String(b.eleicao));
  if (!el) return res.status(400).json({ error: 'Escolha a eleição.' });
  const cargo = String(b.cargo || '');
  if (!el.cargos.includes(cargo)) return res.status(400).json({ error: 'Esse cargo não existe nessa eleição.' });
  const uf = String(b.uf || '').toLowerCase();
  if (!UFS.includes(uf)) return res.status(400).json({ error: 'Estado inválido.' });
  const numero = String(b.numero || '').replace(/\D/g, '');
  if (!/^\d{2,5}$/.test(numero)) return res.status(400).json({ error: 'Número do candidato inválido.' });
  await pool.query(
    `INSERT INTO historico_config (candidato_id, ciclo, eleicao, uf, cargo, numero, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (candidato_id) DO UPDATE SET ciclo = EXCLUDED.ciclo, eleicao = EXCLUDED.eleicao, uf = EXCLUDED.uf,
       cargo = EXCLUDED.cargo, numero = EXCLUDED.numero, atualizado_em = now()`,
    [req.effectiveId, el.ciclo, el.eleicao, uf, cargo, numero]
  );
  await registrar(req, { acao: 'historico.configurar', alvoTipo: 'config', detalhes: { ciclo: el.ciclo, eleicao: el.eleicao, uf, cargo, numero } });
  res.json({ ok: true });
}));

module.exports = router;