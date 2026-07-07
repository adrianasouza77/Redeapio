const pool = require('../db');

// Permite que um admin atue "como" um candidato específico, passando ?as=<id>
// (ou { as: id } no corpo da requisição). Fora desse caso, o usuário sempre
// atua sobre os próprios dados. Isso é o que possibilita a Central de Vagas
// abrir o workspace de qualquer candidato para gerenciar sem trocar de login.
async function resolveWorkspace(req, res, next) {
  const asId = req.query.as || req.body?.as;

  if (req.user.perfil === 'admin' && asId) {
    const { rows } = await pool.query(
      "SELECT id FROM usuarios WHERE id = $1 AND perfil = 'candidato'",
      [asId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Workspace não encontrado.' });
    req.effectiveId = asId;
    req.effectivePerfil = 'candidato';
    return next();
  }

  req.effectiveId = req.user.id;
  req.effectivePerfil = req.user.perfil;
  next();
}

module.exports = resolveWorkspace;
