module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET,
  tokenExpiresIn: '12h',
  cookieMaxAgeMs: 12 * 60 * 60 * 1000,
  limites: {
    1: parseInt(process.env.LIMITE_NIVEL1 || '50', 10),
    2: parseInt(process.env.LIMITE_NIVEL2 || '30', 10),
    3: parseInt(process.env.LIMITE_NIVEL3 || '15', 10),
    4: parseInt(process.env.LIMITE_NIVEL4 || '10', 10),
  },
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
  // Versão vigente do Termo de Consentimento LGPD. Suba este valor sempre que
  // o texto do termo mudar de forma relevante — isso força todo mundo (quem
  // já aceitou uma versão antiga) a ler e aceitar de novo no próximo login.
  termoVersaoAtual: process.env.TERMO_VERSAO || '1.0',
};
