const pool = require('../db');

// Nichos temáticos da campanha e a meta de votos — as duas coisas que o
// cadastro ganhou junto com o mapa mental de nichos. Fica aqui, e não em cada
// rota, porque quatro caminhos cadastram gente (painel da liderança, tela de
// usuários do candidato, link público e edição) e a regra precisa ser a mesma
// nos quatro.

const CORES_NICHO = ['#0f1f3d', '#c8a84b', '#276749', '#c53030', '#6b8ed6', '#8b5cf6', '#ea580c', '#0891b2', '#be185d', '#65a30d'];

async function nichosDoCandidato(candidatoId) {
  if (!candidatoId) return [];
  const { rows } = await pool.query(
    'SELECT id, nome, cor FROM nichos WHERE candidato_id = $1 ORDER BY lower(nome)',
    [candidatoId]
  );
  return rows;
}

// Confere os nichos enviados contra os da campanha. Id que não é desta
// campanha é descartado em silêncio (nunca grava ligação com nicho alheio).
//   criacao = true  → campo ausente conta como "nenhum"
//   criacao = false → campo ausente = não mexer (edição parcial)
// Só é obrigatório escolher ao menos um quando a campanha tem nichos criados:
// campanha que não usa nichos continua cadastrando exatamente como antes.
async function prepararNichos(candidatoId, entrada, { criacao }) {
  if (entrada === undefined && !criacao) return { ids: undefined };
  const lista = await nichosDoCandidato(candidatoId);
  const pedidos = new Set((Array.isArray(entrada) ? entrada : []).map(String));
  const ids = lista.filter((n) => pedidos.has(n.id)).map((n) => n.id);
  if (lista.length && !ids.length) {
    return { erro: 'Escolha pelo menos um nicho (área de interesse).' };
  }
  return { ids };
}

// db = pool ou o client de uma transação aberta.
async function gravarNichos(db, apoiadorId, ids) {
  if (ids === undefined) return;
  await db.query('DELETE FROM apoiador_nichos WHERE apoiador_id = $1', [apoiadorId]);
  if (ids.length) {
    await db.query(
      'INSERT INTO apoiador_nichos (apoiador_id, nicho_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING',
      [apoiadorId, ids]
    );
  }
}

// Meta de votos: só Líder, Coordenador e Mobilizador (níveis 1 a 3) declaram,
// e para eles é OBRIGATÓRIA (especificação: "obrigatório para
// Líder/Coordenador/Mobilizador"). No cadastro precisa vir; na edição, se a
// tela mandou o campo, não pode vir vazio — quem ainda não tinha meta passa a
// ter que informar na primeira vez que alguém edita a ficha.
// undefined (só na edição) = não mexer.
function prepararMeta(entrada, nivel, { criacao = false } = {}) {
  if (nivel === 4) return { meta: entrada === undefined ? undefined : null };
  if (entrada === undefined && !criacao) return { meta: undefined };
  if (entrada === undefined || entrada === null || entrada === '') {
    return { erro: 'Informe a meta de votos: quantos votos essa pessoa acredita entregar.' };
  }
  const n = Number(String(entrada).replace(/\D/g, ''));
  if (!Number.isInteger(n) || n < 0 || n > 10000000) return { erro: 'Meta de votos inválida.' };
  return { meta: n };
}

// Acrescenta a cada linha o array "nichos" (ids). Uma consulta só para a rede
// inteira, em vez de uma por pessoa.
async function anexarNichos(linhas) {
  if (!linhas.length) return linhas;
  const { rows } = await pool.query(
    'SELECT apoiador_id, nicho_id FROM apoiador_nichos WHERE apoiador_id = ANY($1::uuid[])',
    [linhas.map((l) => l.id)]
  );
  const porPessoa = new Map();
  for (const r of rows) {
    if (!porPessoa.has(r.apoiador_id)) porPessoa.set(r.apoiador_id, []);
    porPessoa.get(r.apoiador_id).push(r.nicho_id);
  }
  for (const l of linhas) l.nichos = porPessoa.get(l.id) || [];
  return linhas;
}

module.exports = { CORES_NICHO, nichosDoCandidato, prepararNichos, gravarNichos, prepararMeta, anexarNichos };