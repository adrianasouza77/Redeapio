// Quantos votos de uma urna dá para atribuir a uma equipe (pedido da dona do
// sistema, 06/10/2026, depois de ver um Mobilizador com 8 cadastrados
// "entregar 662%"). O TSE só publica o total da urna; o voto é secreto. Antes,
// cada liderança recebia a urna INTEIRA — inclusive o voto de quem não tem
// nada a ver com a rede, e o mesmo voto contado para dois líderes da mesma
// seção, a ponto de a soma dos líderes passar do total do candidato.
//
// A regra, seção por seção:
//   1. a rede inteira pode ter dado no máximo min(votos da urna, cadastrados
//      da rede na urna) — nunca mais votos que gente cadastrada ali;
//   2. esse teto se divide entre as equipes na proporção de quantos
//      cadastrados de cada uma votam ali.
// Assim nenhuma equipe passa dos próprios cadastrados na seção, e a soma de
// equipes que não se sobrepõem (dois Líderes, por exemplo) nunca passa do
// total da urna. Continua sendo estimativa da área de influência, não voto de
// ninguém — as telas dizem isso.
function votosDaEquipe(votosUrna, cadastradosRede, daEquipe) {
  if (!cadastradosRede || !daEquipe) return 0;
  const teto = Math.min(votosUrna || 0, cadastradosRede);
  return (teto * Math.min(daEquipe, cadastradosRede)) / cadastradosRede;
}

// O que a rede inteira pode ter dado na urna (a parte que não é "fora da rede").
function votosDaRede(votosUrna, cadastradosRede) {
  return Math.min(votosUrna || 0, cadastradosRede || 0);
}

// Arredonda para baixo: com arredondamento normal, três equipes com 0,5 voto
// cada mostrariam 3 votos numa urna de 1. Para baixo, a soma do que aparece
// na tela nunca passa do total.
const inteiro = (v) => Math.floor(v + 1e-9);

module.exports = { votosDaEquipe, votosDaRede, inteiro };
