const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const campanha = require('./campanha');
const resumos = require('./iaResumos');

// Copiloto de IA ("Me ajuda a entender isso"): explica, em linguagem simples,
// a TELA que a pessoa está vendo, com os números do candidato e dos filtros
// dela (orientação técnica "Copiloto da rede por tela", 06/10/2026). Até
// então ele lia sempre o mesmo resumo geral da rede, em qualquer página. A IA
// não decide nada e não inventa dado — só lê o resumo que montamos em
// services/iaResumos.js, uma função por tela.
//
// REGRA OBRIGATÓRIA (CLAUDE.md, regra 7; Resolução TSE 23.748/2026): saída de
// IA é sempre alerta ou rascunho, nunca efeito. Este arquivo só LÊ a rede e
// devolve texto para a tela; a única escrita é guardar a leitura em
// ia_insights. Nunca acrescente aqui nada que envie, publique ou altere a
// rede a partir da resposta da IA — isso exige aprovação humana registrada
// (padrão em docs/04-referencia-tecnica.md#ia-aprovacao-humana).
//
// Nenhum nome, telefone ou título de eleitor sai do servidor (LGPD): pessoa
// vai como código ("Líder 3"), e o nome entra no lugar do código só na volta.

// A especificação pede o Sonnet. IA_MODELO permite trocar pelo Portainer sem
// mexer no código, se a dona preferir outro modelo depois.
const MODELO = process.env.IA_MODELO || 'claude-sonnet-5';
// Teto de leituras por dia por campanha: cada uma é uma chamada paga. Vale
// para todas as telas somadas.
const LIMITE_DIA = Number(process.env.IA_LIMITE_DIA) || 30;

// Instrução base da orientação técnica, igual em todas as telas, com as
// regras que o sistema já tinha (código no lugar de nome, seção com zona).
const PROMPT_BASE = `Você é o Copiloto do RedeApoio. Explique em linguagem simples o que a usuária está vendo na tela indicada em "tela", para o candidato em "candidato", com os filtros em "filtros". Os números da tela estão em "resumo".

Regras:
- Use SOMENTE os números recebidos. Não invente dados. Se faltar dado para explicar a tela, diga o que falta em "dados_que_faltam" (senão, deixe vazio)
- Linguagem simples, sem jargão técnico, para quem não tem bagagem de gestão
- Pessoas da rede vêm só como código ("Líder 3", "Coordenador 3.1", "Mobilizador 3.1.2"; o número mostra de quem cada um é equipe). Cite sempre o código exato e nunca invente nome
- Território eleitoral é a seção escrita junto da zona, exatamente como vem ("Zona 18 · Seção 123"). Seções de zonas diferentes são urnas diferentes: nunca some nem compare como se fossem a mesma
- Quando houver "votos_da_equipe": é a parte dos votos de cada seção que cabe aos cadastrados da equipe ali, e não o total da urna. Sem meta, diga "sem meta" e não calcule porcentagem
- Papéis da rede: Líder (nível 1), Coordenador (nível 2), Mobilizador (nível 3), Apoiador (nível 4, a base)
- Responda com: "o_que_mostra" (o que esta tela mostra, em até 2 frases), "pontos" (exatamente os 3 pontos mais importantes, cada um com título curto, texto de até 2 frases e um detalhe de até 4 frases citando os números) e "acao_da_semana" (uma ação prática para esta semana, em 1 ou 2 frases)`;

// Complemento por tela (orientação técnica, seção 5), somado à instrução base.
const PROMPT_TELA = {
  votos_por_secao: 'Esta é a tela Votos por Seção. Destaque seções com muitos cadastrados e poucos votos, seções da rede com zero voto e seções grandes sem ninguém da rede. Fale só de seções, votos e cadastrados.',
  rede: 'Esta é a tela Rede de Apoio (a pirâmide). Compare cada Líder com a própria meta, aponte quem tem equipe grande sem conversão em voto, e Coordenadores sem equipe. Fale de líderes, metas e hierarquia.',
  prometido_entregue: 'Esta é a tela Prometido × Entregue. Mostre meta, entrega e onde o voto vazou (seções com muita gente da equipe e pouco voto que cabe a ela). Se houver "lider_selecionado", a leitura é sobre ele e a equipe dele. Se não houver meta, diga "sem meta" e não calcule porcentagem. Se "votos_no_escopo.alertas" vier preenchido, comece por ele.',
  inicio: 'Esta é a tela Início. Faça um panorama curto da campanha, citando o candidato ativo e a data da importação de votos (votos.importados_em), e diga o que priorizar.',
  apoiadores: 'Esta é a tela Apoiadores. Diga quantos cadastros há por Líder, quem está sem responsável e sem seção, e qual território falta cobrir.',
  territorio: 'Esta é a tela Rede por território. Aponte bairros e seções com cadastrados e sem liderança (Líder ou Coordenador), e onde indicar Coordenador primeiro.',
  geral: 'A tela não tem resumo próprio: faça a leitura geral da rede — vazios territoriais, gargalos na hierarquia, metas fora da realidade e, se houver, o resultado da eleição.',
};

const SCHEMA = {
  type: 'object',
  properties: {
    o_que_mostra: { type: 'string' },
    pontos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { titulo: { type: 'string' }, texto: { type: 'string' }, detalhe: { type: 'string' } },
        required: ['titulo', 'texto', 'detalhe'],
        additionalProperties: false,
      },
    },
    acao_da_semana: { type: 'string' },
    dados_que_faltam: { type: 'string' },
  },
  required: ['o_que_mostra', 'pontos', 'acao_da_semana', 'dados_que_faltam'],
  additionalProperties: false,
};

const configurado = () => Boolean(process.env.ANTHROPIC_API_KEY);

// Erro com mensagem para a tela, sem detalhe técnico nem pedaço da chave.
function erroTela(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

// A mesma tela + candidato + filtros é a mesma leitura guardada. Mudou
// qualquer um, é outra (orientação técnica, seção 6).
const chaveDe = (candidatoId, ctx) => crypto.createHash('sha1')
  .update(JSON.stringify([candidatoId, ctx.tela, ctx.filtros])).digest('hex');

// Rótulo "Leitura de: …" que a tela mostra no topo. Vem do navegador (ele já
// tem o nome do município, do líder e do candidato da tela) e só serve para
// exibir de volta à mesma pessoa: nunca vai para a IA. O candidato ativo, se
// faltar, o servidor completa.
async function rotuloFinal(candidatoId, ctx, rotulo) {
  const r = rotulo && typeof rotulo === 'object' ? rotulo : {};
  const limpa = (v) => String(v || '').replace(/[<>]/g, '').trim().slice(0, 120);
  let cand = limpa(r.candidato);
  if (!cand) {
    const d = await campanha.carregarDados(candidatoId).catch(() => null);
    if (d) cand = `${d.nome_urna || d.nome_candidato}${d.cargo_nome ? ` (${d.cargo_nome})` : ''}`;
  }
  return [ctx.nomeTela, cand, limpa(r.filtros)].filter(Boolean).join(' | ');
}

async function usadasHoje(candidatoId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS c FROM ia_insights WHERE candidato_id = $1 AND gerado_em > now() - interval '1 day'`,
    [candidatoId]
  );
  return rows[0].c;
}

// A última leitura DESTA combinação, e se os dados mudaram desde então.
async function situacao(candidatoId, entrada) {
  const ctx = resumos.normalizarContexto(entrada);
  const chave = chaveDe(candidatoId, ctx);
  const [{ rows }, hoje] = await Promise.all([
    pool.query(
      `SELECT gerado_em, insights, contexto, versao_dados FROM ia_insights
        WHERE candidato_id = $1 AND chave = $2 ORDER BY gerado_em DESC LIMIT 1`, [candidatoId, chave]
    ),
    usadasHoje(candidatoId),
  ]);
  let ultimo = null;
  if (rows[0]) {
    const versao = await resumos.versaoDados(candidatoId).catch(() => null);
    ultimo = {
      gerado_em: rows[0].gerado_em, leitura: rows[0].insights, rotulo: rows[0].contexto?.rotulo || ctx.nomeTela,
      // Entrou cadastro, mudou meta/responsável, nova importação ou apuração:
      // a leitura guardada não é mais a destes números.
      desatualizada: !!versao && rows[0].versao_dados !== versao,
    };
  }
  return { configurado: configurado(), tela: ctx.tela, nomeTela: ctx.nomeTela, ultimo, usadasHoje: hoje, limite: LIMITE_DIA };
}

async function gerar(candidatoId, entrada, rotulo) {
  if (!configurado()) throw erroTela('O copiloto ainda não foi ativado: falta a chave da API da Anthropic no servidor.');
  if (await usadasHoje(candidatoId) >= LIMITE_DIA) throw erroTela(`Limite de ${LIMITE_DIA} leituras por dia atingido. Tente de novo amanhã.`, 429);

  const ctx = resumos.normalizarContexto(entrada);
  const [versao, montado, rotuloTxt] = await Promise.all([
    resumos.versaoDados(candidatoId),
    resumos.montarTela(candidatoId, ctx),
    rotuloFinal(candidatoId, ctx, rotulo),
  ]);
  const { resumo, codigos } = montado;
  if (resumo && resumo.total_na_rede === 0 && ctx.tela !== 'votos_por_secao') {
    throw erroTela('Cadastre sua rede primeiro: sem dados, não há o que o copiloto ler.');
  }

  // Só a tela, os filtros normalizados (pessoa como código) e os números.
  const conteudo = {
    tela: ctx.nomeTela,
    candidato: resumo.candidato_na_tela || resumo.candidato || null,
    filtros: resumo.escopo || ctx.filtros,
    gerado_em: new Date().toISOString(),
    resumo,
  };
  const cliente = new Anthropic();
  let resp;
  try {
    resp = await cliente.messages.create({
      model: MODELO,
      max_tokens: 16000,
      system: `${PROMPT_BASE}\n\n${PROMPT_TELA[ctx.tela] || PROMPT_TELA.geral}`,
      messages: [{ role: 'user', content: JSON.stringify(conteudo) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw erroTela('A chave da API da Anthropic foi recusada. Confira a variável ANTHROPIC_API_KEY no servidor.', 502);
    if (e instanceof Anthropic.RateLimitError) throw erroTela('A IA está recebendo muitas chamadas agora. Tente em alguns minutos.', 503);
    if (e instanceof Anthropic.APIError) throw erroTela(`A IA não respondeu (erro ${e.status}). Tente de novo em instantes.`, 502);
    throw erroTela('Não foi possível falar com a IA. Tente de novo em instantes.', 502);
  }
  if (resp.stop_reason === 'refusal') throw erroTela('A IA não conseguiu gerar a leitura desta vez. Tente de novo.', 502);
  const texto = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let dados;
  try { dados = JSON.parse(texto); } catch { throw erroTela('A resposta da IA veio incompleta. Tente de novo.', 502); }
  const troca = (t) => resumos.trocarCodigos(t, codigos || new Map());
  const leitura = {
    o_que_mostra: troca(dados.o_que_mostra || ''),
    pontos: (dados.pontos || []).slice(0, 3).map((p) => ({ titulo: troca(p.titulo), texto: troca(p.texto), detalhe: troca(p.detalhe) })),
    acao_da_semana: troca(dados.acao_da_semana || ''),
    dados_que_faltam: troca(dados.dados_que_faltam || ''),
  };

  // resumo guarda só códigos (o que foi para a IA); leitura, já com nomes.
  const { rows } = await pool.query(
    `INSERT INTO ia_insights (candidato_id, modelo, resumo, insights, tokens_entrada, tokens_saida, tela, chave, contexto, versao_dados)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING gerado_em`,
    [candidatoId, resp.model || MODELO, JSON.stringify(conteudo), JSON.stringify(leitura), resp.usage?.input_tokens ?? null, resp.usage?.output_tokens ?? null,
      ctx.tela, chaveDe(candidatoId, ctx), JSON.stringify({ tela: ctx.tela, filtros: ctx.filtros, rotulo: rotuloTxt }), versao]
  );
  return { gerado_em: rows[0].gerado_em, leitura, rotulo: rotuloTxt, tela: ctx.tela, modelo: resp.model || MODELO };
}

module.exports = { situacao, gerar, montarResumo: resumos.montarResumo };
