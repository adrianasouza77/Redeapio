const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

// IA do Módulo Mandato: minuta de proposição (Fase 4) e sugestão de atuação
// (Fase 5).
//
// REGRA OBRIGATÓRIA (CLAUDE.md, regra 7; Resolução TSE 23.748/2026): tudo o
// que sai daqui é RASCUNHO (minuta) ou SUGESTÃO (foco de atuação). Este
// arquivo só devolve texto; quem grava é a rota, sempre com status
// 'rascunho'/'sugerido'. Aprovar, protocolar ou publicar exige uma pessoa,
// registrada (aprovado_por/aprovado_em, decidido_por/decidido_em). Não
// acrescente aqui nada que aja com a resposta da IA.
//
// LGPD: para a IA vai o modelo, o tipo de documento, o que a equipe escreveu
// no pedido e, de uma demanda, só título, categoria e bairro — nunca nome,
// contato ou a descrição de quem pediu (que costuma ter dado pessoal).

const MODELO = process.env.IA_MODELO || 'claude-sonnet-5';
const LIMITE_DIA = Number(process.env.IA_MANDATO_LIMITE_DIA) || 30;

const configurado = () => Boolean(process.env.ANTHROPIC_API_KEY);
function erroTela(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

async function usadasHoje(candidatoId) {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS c FROM mandato_ia_uso WHERE candidato_id = $1 AND usado_em > now() - interval '1 day'", [candidatoId]
  );
  return rows[0].c;
}

async function situacao(candidatoId) {
  return { configurado: configurado(), usadasHoje: await usadasHoje(candidatoId), limite: LIMITE_DIA };
}

async function chamar(candidatoId, usuarioId, tipo, system, conteudo, schema) {
  if (!configurado()) throw erroTela('A IA ainda não foi ativada: falta a chave da API da Anthropic no servidor.');
  if (await usadasHoje(candidatoId) >= LIMITE_DIA) throw erroTela(`Limite de ${LIMITE_DIA} usos da IA do mandato por dia atingido. Tente de novo amanhã.`, 429);
  const cliente = new Anthropic();
  let resp;
  try {
    resp = await cliente.messages.create({
      model: MODELO,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: JSON.stringify(conteudo) }],
      output_config: { format: { type: 'json_schema', schema } },
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw erroTela('A chave da API da Anthropic foi recusada. Confira a variável ANTHROPIC_API_KEY no servidor.', 502);
    if (e instanceof Anthropic.RateLimitError) throw erroTela('A IA está recebendo muitas chamadas agora. Tente em alguns minutos.', 503);
    if (e instanceof Anthropic.APIError) throw erroTela(`A IA não respondeu (erro ${e.status}). Tente de novo em instantes.`, 502);
    throw erroTela('Não foi possível falar com a IA. Tente de novo em instantes.', 502);
  }
  await pool.query(
    'INSERT INTO mandato_ia_uso (candidato_id, usuario_id, tipo, tokens_entrada, tokens_saida) VALUES ($1,$2,$3,$4,$5)',
    [candidatoId, usuarioId, tipo, resp.usage?.input_tokens ?? null, resp.usage?.output_tokens ?? null]
  );
  if (resp.stop_reason === 'refusal') throw erroTela('A IA não conseguiu gerar o texto desta vez. Tente de novo.', 502);
  const texto = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return { dados: JSON.parse(texto), modelo: resp.model || MODELO }; }
  catch { throw erroTela('A resposta da IA veio incompleta. Tente de novo.', 502); }
}

const PROMPT_MINUTA = `Você redige minutas de proposições legislativas municipais (vereador, Câmara Municipal) no Brasil.
Escreva em português formal, seguindo a estrutura do modelo recebido em "modelo".

Regras:
- É uma MINUTA para revisão da equipe do gabinete: nada será protocolado sem revisão humana
- Nunca escreva nome, telefone, endereço residencial ou qualquer dado de pessoa física. Onde precisar, deixe o campo entre colchetes, ex.: [nome do homenageado]
- Não invente número de lei, artigo de Regimento, valor, data ou estatística. O que não estiver nos dados fica entre colchetes para a equipe preencher
- Projeto de lei de vereador não pode criar despesa obrigatória nem órgão no Executivo (vício de iniciativa): prefira diretrizes, programas autorizativos e datas
- Nada de propaganda eleitoral, pedido de voto ou menção a campanha
- Use os dados de "municipio", "demanda" e "pedido" quando existirem
- Responda com "titulo" (curto, para a lista de minutas), "texto" (a minuta completa, pronta para revisar) e "observacoes" (até 3 pontos que a equipe precisa conferir antes de protocolar)`;

const SCHEMA_MINUTA = {
  type: 'object',
  properties: { titulo: { type: 'string' }, texto: { type: 'string' }, observacoes: { type: 'string' } },
  required: ['titulo', 'texto', 'observacoes'],
  additionalProperties: false,
};

async function gerarMinuta(candidatoId, usuarioId, { tipoNome, modelo, municipio, demanda, pedido }) {
  const conteudo = {
    tipo_de_documento: tipoNome,
    municipio: municipio || null,
    modelo: modelo ? { titulo: modelo.titulo, corpo: modelo.corpo, dicas: modelo.dicas || null } : null,
    demanda: demanda ? { titulo: demanda.titulo_publico || demanda.titulo, categoria: demanda.categoria || null, bairro: demanda.bairro || null } : null,
    pedido: pedido || null,
  };
  const { dados, modelo: modeloIa } = await chamar(candidatoId, usuarioId, 'minuta', PROMPT_MINUTA, conteudo, SCHEMA_MINUTA);
  return {
    titulo: String(dados.titulo || '').slice(0, 200),
    texto: String(dados.texto || '').slice(0, 30000),
    observacoes: String(dados.observacoes || '').slice(0, 3000),
    modelo: modeloIa,
  };
}

const PROMPT_ATUACAO = `Você ajuda o gabinete de um vereador a decidir onde e como atuar no mandato.
Os dados vêm em JSON: por bairro (votos do vereador nas urnas daquele bairro, segundo o local de votação do TSE; pessoas da rede que moram ali; demandas recebidas, pendentes e vencidas; trabalhos executados; valor de emendas) e por nicho (tamanho da base, demandas, proposições, trabalhos).

Regras:
- Use SOMENTE os números recebidos. Não invente dado. Se o voto não veio, não fale de voto
- São SUGESTÕES para o vereador escolher e ajustar: escreva como proposta, nunca como decisão
- Nada de propaganda eleitoral, pedido de voto ou troca de favor: o mandato atende a cidade inteira, e emenda não se liga a apoio político
- Aponte, por exemplo: bairro com muita demanda pendente ou vencida; bairro com votação forte e nenhum trabalho executado; nicho com base grande e nenhuma proposição
- Responda com "sugestoes": de 3 a 5 itens, cada um com "recorte" ("bairro", "nicho" ou "tema"), "alvo" (o nome exato do bairro ou nicho, ou o tema), "diagnostico" (1 ou 2 frases citando os números) e "acao" (uma ação concreta do mandato: indicação, requerimento, visita, audiência, projeto)`;

const SCHEMA_ATUACAO = {
  type: 'object',
  properties: {
    sugestoes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          recorte: { type: 'string', enum: ['bairro', 'nicho', 'tema'] },
          alvo: { type: 'string' }, diagnostico: { type: 'string' }, acao: { type: 'string' },
        },
        required: ['recorte', 'alvo', 'diagnostico', 'acao'],
        additionalProperties: false,
      },
    },
  },
  required: ['sugestoes'],
  additionalProperties: false,
};

async function sugerirAtuacao(candidatoId, usuarioId, cruzamento) {
  const conteudo = {
    votos_total_do_vereador: cruzamento.votosTotal,
    bairros: cruzamento.bairros.slice(0, 40),
    nichos: cruzamento.nichos.slice(0, 30),
  };
  if (!conteudo.bairros.length && !conteudo.nichos.length) {
    throw erroTela('Ainda não há dado para cruzar: registre demandas, trabalhos ou nichos, ou importe os votos do TSE.');
  }
  const { dados } = await chamar(candidatoId, usuarioId, 'atuacao', PROMPT_ATUACAO, conteudo, SCHEMA_ATUACAO);
  return (dados.sugestoes || []).slice(0, 5).map((s) => ({
    recorte: ['bairro', 'nicho', 'tema'].includes(s.recorte) ? s.recorte : 'tema',
    alvo: String(s.alvo || '').slice(0, 200) || 'Geral',
    diagnostico: String(s.diagnostico || '').slice(0, 1000),
    acao: String(s.acao || '').slice(0, 2000),
  })).filter((s) => s.acao.length >= 3);
}

module.exports = { situacao, gerarMinuta, sugerirAtuacao, configurado };
