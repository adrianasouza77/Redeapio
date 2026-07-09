const { termoVersaoAtual } = require('../config');

// Candidato, liderança e apoiador (com login) precisam ler e aceitar o termo
// de consentimento LGPD vigente, e quem recebeu uma senha que não escolheu
// precisa trocá-la — ambos bloqueiam o acesso ao painel até serem resolvidos
// (ver modal de primeiro acesso no frontend). Admin fica de fora: não opera
// dados de terceiros da campanha.
function avaliarStatusTermo(usuario) {
  if (usuario.perfil === 'admin') {
    return { precisaAceitarTermo: false, precisaTrocarSenha: false, termoVersaoAtual };
  }
  return {
    precisaAceitarTermo: usuario.termo_versao_aceita !== termoVersaoAtual,
    precisaTrocarSenha: !!usuario.senha_temporaria,
    termoVersaoAtual,
  };
}

module.exports = { avaliarStatusTermo };
