// Express 4 não encaminha rejeições de Promise pro error handler sozinho (só o
// Express 5 faz isso). Sem isso, um erro de banco não tratado dentro de uma
// rota async trava a requisição em vez de responder com erro — o cliente
// fica com um loading infinito. Envolve o handler e encaminha qualquer
// rejeição pro next(err), que cai no error handler central do server.js.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = asyncHandler;
