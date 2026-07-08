// Valida o número do Título de Eleitor pelo algoritmo oficial de dígito
// verificador (mod 11). Só confirma que o número está bem formado — não
// consulta a base do TSE, então não garante que o título realmente existe
// ou pertence à pessoa. Serve pra pegar erro de digitação no autocadastro.
function validarTituloEleitoral(valor) {
  const digitos = String(valor || '').replace(/\D/g, '');
  if (digitos.length !== 12) return false;

  const nums = digitos.split('').map(Number);
  const sequencial = nums.slice(0, 8);
  const ufDigitos = nums.slice(8, 10);
  const uf = ufDigitos[0] * 10 + ufDigitos[1];
  if (uf < 1 || uf > 28) return false;

  const dv1Informado = nums[10];
  const dv2Informado = nums[11];

  let soma1 = 0;
  for (let i = 0; i < 8; i++) soma1 += sequencial[i] * (i + 2);
  let resto1 = soma1 % 11;
  let dv1 = resto1 === 10 ? 0 : resto1;
  if ((uf === 1 || uf === 2) && resto1 === 0) dv1 = 1;
  if (dv1 !== dv1Informado) return false;

  const soma2 = ufDigitos[0] * 7 + ufDigitos[1] * 8 + dv1 * 9;
  let resto2 = soma2 % 11;
  let dv2 = resto2 === 10 ? 0 : resto2;
  if ((uf === 1 || uf === 2) && resto2 === 0) dv2 = 1;

  return dv2 === dv2Informado;
}

module.exports = { validarTituloEleitoral };
