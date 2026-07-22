const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const { limitesDoCandidato } = require('../utils/limites');
const { resolverCandidatoId } = require('../utils/duplicidade');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired, resolveWorkspace);

// Candidato dono da rede em que o usuário logado está: o próprio (candidato),
// o do workspace aberto (admin com ?as=) ou quem o criou (lideranca/apoiador).
function candidatoDaRede(req) {
  if (req.effectivePerfil === 'candidato') return req.effectiveId;
  return resolverCandidatoId(req.user);
}

// Limites vigentes da pirâmide — qualquer perfil logado lê (a liderança também
// precisa exibir "X de Y vagas" com o valor que o candidato dela configurou).
router.get('/', asyncHandler(async (req, res) => {
  const limites = await limitesDoCandidato(candidatoDaRede(req));
  res.json({
    limiteNivel1: limites[1],
    limiteNivel2: limites[2],
    limiteNivel3: limites[3],
    limiteNivel4: limites[4],
  });
}));

// Salva os limites personalizados do candidato (tela de Configurações). Antes
// isso só mudava a memória do navegador e voltava a 50/30/15/10 em todo reload.
router.put('/', asyncHandler(async (req, res) => {
  if (req.effectivePerfil !== 'candidato') {
    return res.status(403).json({ error: 'Só o candidato pode alterar os limites da rede.' });
  }

  const valores = {};
  for (const campo of ['limiteNivel1', 'limiteNivel2', 'limiteNivel3', 'limiteNivel4']) {
    const v = Number(req.body?.[campo]);
    if (!Number.isInteger(v) || v < 1 || v > 100000) {
      return res.status(400).json({ error: 'Cada limite precisa ser um número inteiro entre 1 e 100000.' });
    }
    valores[campo] = v;
  }

  const { rowCount } = await pool.query(
    `UPDATE usuarios SET limite_nivel1 = $1, limite_nivel2 = $2, limite_nivel3 = $3, limite_nivel4 = $4
     WHERE id = $5 AND perfil = 'candidato'`,
    [valores.limiteNivel1, valores.limiteNivel2, valores.limiteNivel3, valores.limiteNivel4, req.effectiveId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Candidato não encontrado.' });
  res.json(valores);
}));

module.exports = router;
