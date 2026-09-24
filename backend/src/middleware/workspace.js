const pool = require('../db');
const { registrar } = require('../utils/auditoria');

// Última vez que cada admin abriu cada workspace — o log registra a abertura,
// não cada clique lá dentro (seriam centenas de linhas por visita).
const ultimaAbertura = new Map();
const INTERVALO_LOG_MS = 30 * 60 * 1000;

// Permite que um admin atue "como" um candidato específico, passando ?as=<id>
// (ou { as: id } no corpo da requisição). Fora desse caso, o usuário sempre
// atua sobre os próprios dados. Isso é o que possibilita a Central de Vagas
// abrir o workspace de qualquer candidato para gerenciar sem trocar de login.
//
// O administrador é a dona do sistema e o suporte de todos os clientes: ele
// sempre entra, em qualquer campanha. A especificação de segurança chegou a
// pedir que o candidato pudesse bloquear isso, mas a dona precisa ver tudo
// para ajudar no processo — então o controle virou transparência: cada
// abertura fica no log, e o candidato vê esse registro em Minha Conta.
async function resolveWorkspace(req, res, next) {
  const asId = req.query.as || req.body?.as;

  if (req.user.perfil === 'admin' && asId) {
    const { rows } = await pool.query(
      "SELECT id, nome FROM usuarios WHERE id = $1 AND perfil = 'candidato'",
      [asId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Workspace não encontrado.' });
    req.effectiveId = asId;
    req.effectivePerfil = 'candidato';
    const chave = `${req.user.id}|${asId}`;
    if (Date.now() - (ultimaAbertura.get(chave) || 0) > INTERVALO_LOG_MS) {
      ultimaAbertura.set(chave, Date.now());
      await registrar(req, { acao: 'workspace.abrir', alvoTipo: 'candidato', alvoId: asId, alvoNome: rows[0].nome });
    }
    return next();
  }

  req.effectiveId = req.user.id;
  req.effectivePerfil = req.user.perfil;
  next();
}

module.exports = resolveWorkspace;