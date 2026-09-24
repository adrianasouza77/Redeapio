const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');
const { anexarNichos, nichosDoCandidato } = require('../utils/nichos');
const apuracao = require('./apuracao');
const historico = require('./historico');

// Copiloto de IA: traduz os números da própria rede em 3 a 5 alertas em
// linguagem simples, para candidato sem bagagem de gestão. A IA não decide
// nada e não inventa dado — só lê um RESUMO que montamos aqui.
//
// REGRA OBRIGATÓRIA (CLAUDE.md, regra 7; Resolução TSE 23.748/2026): saída de
// IA é sempre alerta ou rascunho, nunca efeito. Este arquivo só LÊ a rede e
// devolve texto para a tela; a única escrita é guardar a leitura em
// ia_insights. Nunca acrescente aqui nada que envie, publique ou altere a
// rede a partir da resposta da IA — isso exige aprovação humana registrada
// (padrão em docs/04-referencia-tecnica.md#ia-aprovacao-humana).
//
// O resumo leva só contagens e nomes de território/nicho. Nenhum nome,
// telefone ou título de eleitor de apoiador sai do servidor: a pergunta é
// sobre a forma da rede, e mandar dado pessoal para fora não ajudaria em nada
// a resposta (LGPD).

// A especificação pede o Sonnet. IA_MODELO permite trocar pelo Portainer sem
// mexer no código, se a dona preferir outro modelo depois.
const MODELO = process.env.IA_MODELO || 'claude-sonnet-5';
// Teto de leituras por dia por campanha: cada uma é uma chamada paga.
const LIMITE_DIA = Number(process.env.IA_LIMITE_DIA) || 30;

const TIPOS = ['vazio_territorial', 'desequilibrio_nicho', 'meta_irrealista', 'gargalo_hierarquico', 'padrao_pos_eleicao', 'diagnostico_historico'];

// Prompt da seção 7 da especificação, com dois acréscimos pedidos pela
// própria tela: "detalhe" (o botão "ver detalhe" do card) e "acao_sugerida".
const PROMPT = `Você é o copiloto de leitura de dados do RedeApoio. Recebe um resumo estruturado da rede de apoiadores de um candidato político (hierarquia, território, nichos temáticos e metas de votos) e devolve de 3 a 5 insights acionáveis.

Regras:
- Linguagem simples, sem jargão técnico, para candidato sem bagagem de gestão
- O campo "texto" de cada insight tem no máximo 2 frases
- "detalhe" explica em até 4 frases de onde vem a leitura, citando os números do resumo
- "acao_sugerida" é um próximo passo concreto, em 1 frase (ex.: "Indique um Coordenador para o bairro X")
- Priorize os problemas de maior impacto (vazios territoriais, desequilíbrio de nicho, metas irrealistas, gargalos hierárquicos)
- Quando "resultado_pos_eleicao" vier preenchido, procure padrões nas zonas onde a meta não bateu (ex.: todas do mesmo nicho, sugerindo problema de mensagem, e não de rede) e use o tipo padrao_pos_eleicao
- Quando "desempenho_historico" vier preenchido, compare votos passados com o tamanho da rede de hoje em cada município e use o tipo diagnostico_historico
- Nunca invente dados que não estejam no resumo enviado; se um dado não veio, não fale dele
- "prioridade" vai de 1 (mais urgente) a 5
- Papéis da rede: Líder (nível 1), Coordenador (nível 2), Mobilizador (nível 3), Apoiador (nível 4, a base)`;

const SCHEMA = {
  type: 'object',
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: TIPOS },
          titulo: { type: 'string' },
          texto: { type: 'string' },
          detalhe: { type: 'string' },
          acao_sugerida: { type: 'string' },
          territorio_ou_nicho_afetado: { type: 'string' },
          prioridade: { type: 'integer' },
        },
        required: ['tipo', 'titulo', 'texto', 'detalhe', 'acao_sugerida', 'territorio_ou_nicho_afetado', 'prioridade'],
        additionalProperties: false,
      },
    },
  },
  required: ['insights'],
  additionalProperties: false,
};

const configurado = () => Boolean(process.env.ANTHROPIC_API_KEY);

const PAPEL = { 1: 'lider', 2: 'coordenador', 3: 'mobilizador', 4: 'apoiador_organico' };
const lideranca = (a) => a.nivel === 1 || a.nivel === 2;

async function montarResumo(candidatoId) {
  const { rows: cand } = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [candidatoId]);
  const { rows: rede } = await pool.query(
    `SELECT id, nivel, parent_id, cadastrado_por, meta_votos, zona, secao, regiao, cidade FROM (${SQL_ARVORE_CANDIDATO}) r`,
    [candidatoId]
  );
  await anexarNichos(rede);
  const nichos = await nichosDoCandidato(candidatoId);
  const nomeNicho = new Map(nichos.map((n) => [n.id, n.nome]));
  const zonaDe = (a) => { const z = String(a.zona || '').replace(/\D/g, '').replace(/^0+/, ''); return z ? `Zona ${z.padStart(3, '0')}` : null; };

  const contagem_por_papel = { lider: 0, coordenador: 0, mobilizador: 0, apoiador_organico: 0 };
  for (const a of rede) if (PAPEL[a.nivel]) contagem_por_papel[PAPEL[a.nivel]]++;

  const contagem_por_nicho = Object.fromEntries(nichos.map((n) => [n.nome, 0]));
  let sem_nicho = 0;
  for (const a of rede) {
    if (!a.nichos.length) sem_nicho++;
    for (const id of a.nichos) if (nomeNicho.has(id)) contagem_por_nicho[nomeNicho.get(id)]++;
  }

  // Território com gente da rede e nenhum Líder/Coordenador morando nele.
  const semLideranca = (chave) => {
    const m = new Map();
    for (const a of rede) {
      const k = chave(a); if (!k) continue;
      if (!m.has(k)) m.set(k, { cadastrados: 0, liderancas: 0 });
      m.get(k).cadastrados++;
      if (lideranca(a)) m.get(k).liderancas++;
    }
    return [...m.entries()].filter(([, v]) => !v.liderancas).sort((x, y) => y[1].cadastrados - x[1].cadastrados)
      .slice(0, 25).map(([k, v]) => ({ territorio: k, cadastrados: v.cadastrados }));
  };
  const bairro = (a) => (a.regiao && a.regiao !== '—' ? `${a.regiao.trim()}${a.cidade ? ' (' + a.cidade.trim() + ')' : ''}` : null);

  // Gargalo: nível sem ninguém embaixo (ex.: Líder sem nenhum Coordenador).
  const filhos = new Map();
  for (const a of rede) {
    const pai = a.parent_id || a.cadastrado_por;
    if (!filhos.has(pai)) filhos.set(pai, []);
    filhos.get(pai).push(a);
  }
  const semEquipe = (nivel) => rede.filter((a) => a.nivel === nivel && !(filhos.get(a.id) || []).some((f) => f.nivel === nivel + 1)).length;

  const nichoPrincipalPorZona = new Map();
  {
    const m = new Map();
    for (const a of rede) {
      const z = zonaDe(a); if (!z) continue;
      if (!m.has(z)) m.set(z, new Map());
      for (const id of a.nichos) { const n = nomeNicho.get(id); if (n) m.get(z).set(n, (m.get(z).get(n) || 0) + 1); }
    }
    for (const [z, cont] of m) {
      const top = [...cont.entries()].sort((x, y) => y[1] - x[1])[0];
      if (top) nichoPrincipalPorZona.set(z, top[0]);
    }
  }

  const resumo = {
    candidato: cand[0]?.nome || 'Candidato',
    total_na_rede: rede.length,
    contagem_por_papel,
    contagem_por_nicho,
    sem_nicho,
    territorios_sem_lideranca: {
      bairros: semLideranca(bairro),
      zonas_eleitorais: semLideranca(zonaDe),
    },
    gargalos_hierarquicos: {
      lideres_sem_coordenador: semEquipe(1),
      coordenadores_sem_mobilizador: semEquipe(2),
      mobilizadores_sem_apoiador: semEquipe(3),
      cadastros_sem_responsavel: rede.filter((a) => a.nivel > 1 && !a.parent_id).length,
      sem_zona_eleitoral: rede.filter((a) => !zonaDe(a)).length,
    },
    metas: {
      pessoas_com_meta: rede.filter((a) => a.nivel <= 3 && a.meta_votos != null).length,
      pessoas_sem_meta: rede.filter((a) => a.nivel <= 3 && a.meta_votos == null).length,
      meta_total: rede.reduce((t, a) => t + (a.nivel <= 3 && a.meta_votos ? a.meta_votos : 0), 0),
    },
    metas_vs_capacidade: [],
    resultado_pos_eleicao: null,
    desempenho_historico: null,
  };

  // Apuração (se configurada): a capacidade é o total de eleitores aptos das
  // urnas (o "total de votantes históricos" da especificação), por zona e por
  // seção de cada responsável; com urnas apuradas, vem também o resultado
  // pós-eleição por zona. Comparecimento não entra: não é guardado.
  const cfgAp = await apuracao.carregarConfig(candidatoId);
  if (cfgAp) {
    const p = await apuracao.painel(candidatoId).catch(() => null);
    if (p && p.zonas) {
      const metaZona = new Map((p.metas?.porZona || []).map((z) => [z.zona, z]));
      const porZona = p.zonas.filter((z) => metaZona.has(z.zona)).map((z) => ({
        territorio: `Zona ${z.zona.replace(/^0/, '')}`,
        meta: metaZona.get(z.zona).meta,
        cadastrados: z.cadastrados,
        total_votantes_historico: z.secoesApuradas === z.secoesTotal && z.aptos ? z.aptos : null,
      }));
      // Por seção: a meta de cada Líder/Coordenador/Mobilizador contra os
      // eleitores aptos das seções onde ele e a equipe votam. Sem nome — só
      // papel e seções. Os mais apertados primeiro, no máximo 30.
      const porSecao = (p.metas?.porResponsavel || [])
        .filter((r) => r.meta && r.aptosSecoes)
        .sort((x, y) => y.meta / y.aptosSecoes - x.meta / x.aptosSecoes)
        .slice(0, 30)
        .map((r) => ({
          territorio: `${r.secoes.length > 1 ? 'Seções' : 'Seção'} ${r.secoes.join(', ')} (Zona ${String(r.zona || '').replace(/^0/, '') || '?'})`,
          papel_responsavel: ({ 1: 'Líder', 2: 'Coordenador', 3: 'Mobilizador' })[r.nivel],
          meta: r.meta,
          total_votantes_historico: r.aptosSecoes,
        }));
      resumo.metas_vs_capacidade = [...porZona, ...porSecao];
      const apuradas = p.zonas.filter((z) => z.secoesApuradas > 0);
      if (apuradas.length) {
        const pr = p.metas?.porResponsavel || [];
        const comMeta = pr.filter((r) => r.meta && r.urnasApuradas);
        resumo.resultado_pos_eleicao = {
          eleicao: `${cfgAp.ciclo} (${cfgAp.pleito})`,
          por_zona: apuradas.map((z) => ({
            territorio: `Zona ${z.zona.replace(/^0/, '')}`,
            cadastrados: z.cadastrados,
            meta: metaZona.get(z.zona)?.meta ?? null,
            votos: z.votosZona,
            urnas_apuradas: `${z.secoesApuradas} de ${z.secoesTotal}`,
            nicho_principal: nichoPrincipalPorZona.get(`Zona ${z.zona.replace(/^0/, '')}`) || null,
          })),
          responsaveis: {
            com_meta_apurada: comMeta.length,
            entregaram: comMeta.filter((r) => r.votos >= r.meta).length,
            ficaram_perto: comMeta.filter((r) => r.votos < r.meta && r.votos >= 0.7 * r.meta).length,
            muito_abaixo: comMeta.filter((r) => r.votos < 0.7 * r.meta).length,
          },
        };
      }
    }
  }

  const cfgHist = await historico.carregarConfig(candidatoId);
  if (cfgHist) {
    const v = await historico.visaoGeral(candidatoId).catch(() => null);
    if (v && v.municipios?.length) {
      resumo.desempenho_historico = {
        eleicao: v.config.nomeEleicao, cargo: v.config.nomeCargo,
        municipios: v.municipios.slice(0, 20).map((m) => ({
          municipio: m.nome, cadastrados_hoje: m.cadastrados, liderancas_hoje: m.liderancas,
          votos: m.resultado?.votos ?? null, posicao: m.resultado?.posicao ?? null,
          votos_do_primeiro: m.resultado?.primeiro?.votos ?? null,
        })),
      };
    }
  }
  return resumo;
}

async function situacao(candidatoId) {
  const { rows } = await pool.query(
    `SELECT gerado_em, insights, modelo FROM ia_insights WHERE candidato_id = $1 ORDER BY gerado_em DESC LIMIT 1`,
    [candidatoId]
  );
  const { rows: hoje } = await pool.query(
    `SELECT count(*)::int AS c FROM ia_insights WHERE candidato_id = $1 AND gerado_em > now() - interval '1 day'`,
    [candidatoId]
  );
  return { configurado: configurado(), ultimo: rows[0] || null, usadasHoje: hoje[0].c, limite: LIMITE_DIA };
}

// Erro com mensagem para a tela, sem detalhe técnico nem pedaço da chave.
function erroTela(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

async function gerar(candidatoId) {
  if (!configurado()) throw erroTela('O copiloto ainda não foi ativado: falta a chave da API da Anthropic no servidor.');
  const s = await situacao(candidatoId);
  if (s.usadasHoje >= LIMITE_DIA) throw erroTela(`Limite de ${LIMITE_DIA} leituras por dia atingido. Tente de novo amanhã.`, 429);

  const resumo = await montarResumo(candidatoId);
  if (!resumo.total_na_rede) throw erroTela('Cadastre sua rede primeiro: sem dados, não há o que o copiloto ler.');

  const cliente = new Anthropic();
  let resp;
  try {
    resp = await cliente.messages.create({
      model: MODELO,
      max_tokens: 16000,
      system: PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(resumo) }],
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
  const insights = (dados.insights || [])
    .filter((i) => TIPOS.includes(i.tipo))
    .sort((a, b) => (a.prioridade || 9) - (b.prioridade || 9))
    .slice(0, 5);

  const { rows } = await pool.query(
    `INSERT INTO ia_insights (candidato_id, modelo, resumo, insights, tokens_entrada, tokens_saida)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING gerado_em`,
    [candidatoId, resp.model || MODELO, JSON.stringify(resumo), JSON.stringify(insights), resp.usage?.input_tokens ?? null, resp.usage?.output_tokens ?? null]
  );
  return { gerado_em: rows[0].gerado_em, insights, modelo: resp.model || MODELO };
}

module.exports = { situacao, gerar, montarResumo };