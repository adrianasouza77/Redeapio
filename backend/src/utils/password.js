const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const TEMP_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefghjkmnpqrstwxyz23456789@#';

// crypto.randomInt (CSPRNG) em vez de Math.random — senha temporária precisa
// resistir a força bruta, não só parecer aleatória. 12 caracteres do alfabeto
// acima (sem caracteres ambíguos como I/l/O/0/1) dão ~68 bits de entropia.
function gerarSenhaTemporaria(tamanho = 12) {
  return Array.from({ length: tamanho }, () => TEMP_CHARS[crypto.randomInt(TEMP_CHARS.length)]).join('');
}

function hash(senha) {
  return bcrypt.hash(senha, 10);
}

function compare(senha, senhaHash) {
  return bcrypt.compare(senha, senhaHash);
}

module.exports = { gerarSenhaTemporaria, hash, compare };
