const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const TEMP_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefghjkmnpqrstwxyz23456789@#';

// crypto.randomInt (CSPRNG) em vez de Math.random — senha temporária precisa
// resistir a força bruta, não só parecer aleatória. 12 caracteres do alfabeto
// acima (sem caracteres ambíguos como I/l/O/0/1) dão ~68 bits de entropia.
function gerarSenhaTemporaria(tamanho = 12) {
  return Array.from({ length: tamanho }, () => TEMP_CHARS[crypto.randomInt(TEMP_CHARS.length)]).join('');
}

// Para a senha que o próprio coordenador passa de mão em mão pelo celular
// (Criar acesso): a de 12 caracteres misturando maiúscula, minúscula e símbolo
// é penosa de digitar no teclado do telefone e gera erro de digitação no
// primeiro acesso. Quatro letras minúsculas + quatro números (~30 bits) bastam
// para uma senha que o sistema obriga a trocar no primeiro login, e cada
// tentativa de adivinhar passa pelo bcrypt.
const LETRAS_FACEIS = 'abcdefghjkmnpqrstuvwxyz';
const NUMEROS_FACEIS = '23456789';
function gerarSenhaFacil() {
  const pega = (alfabeto, n) => Array.from({ length: n }, () => alfabeto[crypto.randomInt(alfabeto.length)]).join('');
  return pega(LETRAS_FACEIS, 4) + pega(NUMEROS_FACEIS, 4);
}

function hash(senha) {
  return bcrypt.hash(senha, 10);
}

function compare(senha, senhaHash) {
  return bcrypt.compare(senha, senhaHash);
}

module.exports = { gerarSenhaTemporaria, gerarSenhaFacil, hash, compare };
