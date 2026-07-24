const pool = require('../db');

// Nível do usuário-com-login na pirâmide. Liderança é sempre nível 1. Um
// apoiador pode estar no nível 2 OU 3 (quando ele mesmo se autocadastrou pelo
// link de alguém do nível acima) — então o nível real vem da ficha-espelho em
// "apoiadores" (apoiadores.id = usuarios.id), e não do perfil. Cai em 2 se a
// ficha ainda não existir (apoiador antigo criado antes desta lógica).
async function nivelUsuario(user) {
  if (user.perfil === 'lideranca') return 1;
  if (user.perfil !== 'apoiador') return null;
  const { rows } = await pool.query('SELECT nivel FROM apoiadores WHERE id = $1', [user.id]);
  return rows[0]?.nivel ?? 2;
}

module.exports = { nivelUsuario };
