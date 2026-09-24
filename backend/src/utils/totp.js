const crypto = require('crypto');

// Verificação em duas etapas pelo código de 6 números do aplicativo
// autenticador (Google Authenticator, Microsoft Authenticator, Authy...).
// É o TOTP padrão (RFC 6238): HMAC-SHA1 sobre o relógio em janelas de 30 s.
// Escrito aqui em vez de puxar uma biblioteca porque são 40 linhas de
// criptografia padrão do Node, e cada dependência a mais é superfície a mais.

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function paraBase32(buf) {
  let bits = 0; let valor = 0; let saida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte; bits += 8;
    while (bits >= 5) { saida += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31];
  return saida;
}

function deBase32(texto) {
  const limpo = String(texto).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let valor = 0; const bytes = [];
  for (const ch of limpo) {
    valor = (valor << 5) | ALFABETO.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function gerarSegredo() {
  return paraBase32(crypto.randomBytes(20));
}

function codigoNoPasso(segredo, passo) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', deBase32(segredo)).update(contador).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

// Aceita o código da janela atual e de uma antes/depois: relógio do celular
// meio minuto adiantado ou atrasado é comum e não pode trancar ninguém fora.
function verificar(segredo, codigo, agoraMs = Date.now()) {
  if (!segredo || !/^\d{6}$/.test(String(codigo || ''))) return false;
  const passo = Math.floor(agoraMs / 30000);
  for (let d = -1; d <= 1; d++) {
    const esperado = Buffer.from(codigoNoPasso(segredo, passo + d));
    if (crypto.timingSafeEqual(esperado, Buffer.from(String(codigo)))) return true;
  }
  return false;
}

// Link que o celular abre direto no aplicativo autenticador.
function linkOtpauth(segredo, conta) {
  const rotulo = encodeURIComponent(`RedeApoio:${conta}`);
  return `otpauth://totp/${rotulo}?secret=${segredo}&issuer=RedeApoio&digits=6&period=30`;
}

module.exports = { gerarSegredo, verificar, linkOtpauth, codigoNoPasso, paraBase32 };