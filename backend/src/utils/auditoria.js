const pool = require('../db');

// Log de auditoria do sistema. Só o Administrador Geral lê (ver rotas em
// routes/admin.js); ninguém escreve nele a não ser por aqui.
//
// Regra número um: registrar NUNCA pode derrubar a requisição. Um erro ao
// gravar o log não pode desfazer um cadastro que já foi salvo, nem devolver
// "Erro interno" para quem acabou de concluir a ação com sucesso — por isso
// todo o corpo está dentro de try/catch e o erro só vai para o console do
// servidor. Também por isso o log fica FORA das transações das rotas: se
// entrasse no client da transação, um ROLLBACK apagaria o registro da
// tentativa, que é justamente o que se quer poder auditar depois.

// De qual candidato (workspace) é a ação. O admin fora de um workspace opera
// sobre o sistema todo, então fica NULL — a tela de log do admin trata esse
// caso à parte.
function candidatoDoContexto(req) {
  const perfil = req.effectivePerfil || req.user?.perfil;
  const id = req.effectiveId || req.user?.id;
  if (perfil === 'candidato') return id || null;
  if (perfil === 'lideranca' || perfil === 'apoiador') return req.user?.criado_por || null;
  return null;
}

async function registrar(req, evento = {}) {
  try {
    const {
      acao,
      alvoTipo = null,
      alvoId = null,
      alvoNome = null,
      detalhes = {},
      // Quem agiu. Só precisa ser passado quando não há req.user (login, e
      // autocadastro público, em que o "ator" é a própria pessoa se cadastrando).
      ator = null,
      // Idem para o workspace, quando ele não sai do contexto da requisição
      // (autocadastro: o candidato vem do link, não da sessão).
      candidatoId,
    } = evento;
    if (!acao) return;

    const quem = ator || req?.user || {};
    // "como_admin" separa o que o próprio candidato fez do que o admin fez
    // atuando como ele (?as=<id>) — sem isso o log culparia o candidato por
    // mudanças que ele não fez.
    const comoAdmin = req?.user?.perfil === 'admin' && !!req?.effectiveId && req.effectiveId !== req.user.id;

    await pool.query(
      `INSERT INTO auditoria
         (candidato_id, ator_id, ator_nome, ator_perfil, como_admin, acao, alvo_tipo, alvo_id, alvo_nome, detalhes, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        candidatoId !== undefined ? candidatoId : candidatoDoContexto(req),
        quem.id || null,
        quem.nome || null,
        quem.perfil || null,
        comoAdmin,
        acao,
        alvoTipo,
        alvoId,
        alvoNome,
        JSON.stringify(detalhes || {}),
        req?.ip || null,
        req?.headers?.['user-agent'] || null,
      ]
    );
  } catch (err) {
    console.error('[auditoria] falha ao gravar log (a ação em si foi concluída):', err.message);
  }
}

// Compara o antes/depois de uma edição e devolve só o que mudou, no formato
// { campo: { de, para } }. É isso que faz o log dizer "trocou o telefone de X
// para Y" em vez de despejar a ficha inteira em toda edição.
const IGNORAR_NA_COMPARACAO = new Set(['senha', 'senha_hash', 'id', 'created_at']);

function diferencas(antes = {}, depois = {}, campos = null) {
  const chaves = campos || [...new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})])];
  const mudou = {};
  for (const campo of chaves) {
    if (IGNORAR_NA_COMPARACAO.has(campo)) continue;
    const de = normalizar(antes?.[campo]);
    const para = normalizar(depois?.[campo]);
    if (de !== para) mudou[campo] = { de, para };
  }
  return mudou;
}

// Datas voltam do Postgres como objeto Date e do formulário como string:
// comparar direto acusaria mudança em todo salvamento, mesmo sem edição nenhuma.
function normalizar(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

module.exports = { registrar, diferencas, candidatoDoContexto };
