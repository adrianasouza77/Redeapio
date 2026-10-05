const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  // Cookie httpOnly é a via principal (protege contra roubo de token via XSS,
  // já que o JS do navegador não consegue ler o cookie). O header Authorization
  // fica como alternativa para chamadas via curl/scripts.
  const token = req.cookies?.token || (header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'Sessão ausente. Faça login novamente.' });
  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
}

function requireRole(...perfis) {
  return (req, res, next) => {
    // O Coordenador Geral dentro de um candidato da rede dele (resolveWorkspace
    // já conferiu) passa onde o candidato passa. Nada mais muda de perfil aqui:
    // o admin continua sendo admin, e rota só de admin segue só de admin.
    const perfil = req.user.perfil === 'coordenador_geral' && req.effectivePerfil === 'candidato'
      ? 'candidato' : req.user.perfil;
    if (!perfis.includes(perfil)) {
      return res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
    }
    next();
  };
}

module.exports = { authRequired, requireRole };
