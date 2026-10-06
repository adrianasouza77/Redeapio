const zlib = require('zlib');

// Resposta JSON em gzip quando passa de 20 KB e o navegador aceita. O servidor
// não tem compressão ligada para a API inteira; as rotas pesadas usam esta.
// Começou em Votos por Seção (estado inteiro passa de 1,5 MB); em 06/10/2026
// entrou também na apuração, depois que a pirâmide chegou cortada no 4G
// ("Load failed" / "os dados chegaram pela metade").
function jsonComprimido(req, res, dados) {
  const corpo = Buffer.from(JSON.stringify(dados));
  if (corpo.length > 20000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.send(zlib.gzipSync(corpo));
  }
  return res.type('application/json').send(corpo);
}

module.exports = jsonComprimido;
