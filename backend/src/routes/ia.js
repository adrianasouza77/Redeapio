const express = require('express');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const ia = require('../services/ia');

// Copiloto de IA ("Me ajuda a entender isso"). Só candidato (e admin no
// workspace): o resumo é da rede inteira.
const router = express.Router();
router.use(authRequired, resolveWorkspace, requireRole('candidato', 'admin'));

router.get('/', asyncHandler(async (req, res) => {
  res.json(await ia.situacao(req.effectiveId));
}));

router.post('/gerar', asyncHandler(async (req, res) => {
  try {
    const r = await ia.gerar(req.effectiveId);
    await registrar(req, { acao: 'ia.gerar', alvoTipo: 'config', detalhes: { modelo: r.modelo, insights: r.insights.length } });
    res.json(r);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

module.exports = router;