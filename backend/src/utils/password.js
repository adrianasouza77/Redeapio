const bcrypt = require('bcryptjs');

const TEMP_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefghjkmnpqrstwxyz23456789@#';

function gerarSenhaTemporaria(tamanho = 8) {
  return Array.from({ length: tamanho }, () => TEMP_CHARS[Math.floor(Math.random() * TEMP_CHARS.length)]).join('');
}

function hash(senha) {
  return bcrypt.hash(senha, 10);
}

function compare(senha, senhaHash) {
  return bcrypt.compare(senha, senhaHash);
}

module.exports = { gerarSenhaTemporaria, hash, compare };
