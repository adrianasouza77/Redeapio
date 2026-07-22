const pool = require('../db');
const { limites: padroes } = require('../config');

// Limites da pirâmide do candidato dono da rede: o que ele salvou na tela de
// Configurações (usuarios.limite_nivel1..4) vence; campo NULL cai no padrão
// global das variáveis LIMITE_NIVEL1..4 (config.js). Sempre retorna os 4 níveis.
async function limitesDoCandidato(candidatoId) {
  if (!candidatoId) return { ...padroes };
  const { rows } = await pool.query(
    'SELECT limite_nivel1, limite_nivel2, limite_nivel3, limite_nivel4 FROM usuarios WHERE id = $1',
    [candidatoId]
  );
  const r = rows[0] || {};
  return {
    1: r.limite_nivel1 ?? padroes[1],
    2: r.limite_nivel2 ?? padroes[2],
    3: r.limite_nivel3 ?? padroes[3],
    4: r.limite_nivel4 ?? padroes[4],
  };
}

module.exports = { limitesDoCandidato };
