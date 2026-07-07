module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET,
  tokenExpiresIn: '12h',
  cookieMaxAgeMs: 12 * 60 * 60 * 1000,
  limites: {
    1: parseInt(process.env.LIMITE_NIVEL1 || '50', 10),
    2: parseInt(process.env.LIMITE_NIVEL2 || '30', 10),
    3: parseInt(process.env.LIMITE_NIVEL3 || '15', 10),
  },
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
};
