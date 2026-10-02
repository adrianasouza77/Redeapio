const express = require('express');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const ia = require('../services/ia');
const ajuda = require('../services/ajuda');

const router = express.Router();

// Assistente de ajuda ("❓ Ajuda"): qualquer perfil com login. Fica ANTES do
// router.use abaixo, que restringe o resto deste arquivo ao candidato. Usa
// req.user e não req.effectiveId de propósito: o limite diário é de quem
// está digitando, mesmo o admin dentro do workspace de um candidato.
router.get('/ajuda', authRequired, asyncHandler(async (req, res) => {
  res.json(await ajuda.situacao(req.user));
}));

router.post('/ajuda', authRequired, asyncHandler(async (req, res) => {
  try {
    res.json(await ajuda.perguntar(req.user, req.body?.mensagens));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

// Copiloto de IA ("Me ajuda a entender isso"). Só candidato (e admin no
// workspace): o resumo é da rede inteira.
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