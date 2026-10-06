const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');
const { anexarNichos, nichosDoCandidato } = require('../utils/nichos');
const apuracao = require('./apuracao');
const entrega = require('./entrega');
const historico = require('./historico');
const tse = require('./tse');

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
// a resposta (LGPD). A leitura por liderança (pedido da dona em 06/10/2026)
// vai com CÓDIGOS ("Líder 3", "Coordenador 3.1") e o nome só entra no lugar
// do código aqui, depois que a resposta volta — ver trocarCodigos().
//
// Território eleitoral é sempre ZONA + SEÇÃO, nunca seção sozinha: o número
// da seção se repete em toda zona, e somar a "Seção 10" de zonas diferentes
// mistura urnas que não têm nada a ver uma com a outra.

// A especificação pede o Sonnet. IA_MODELO permite trocar pelo Portainer sem
// mexer no código, se a dona preferir outro modelo depois.
const MODELO = process.env.IA_MODELO || 'claude-sonnet-5';
// Teto de leituras por dia por campanha: cada uma é uma chamada paga.
const LIMITE_DIA = Number(process.env.IA_LIMITE_DIA) || 30;

const TIPOS = ['vazio_territorial', 'desequilibrio_nicho', 'meta_irrealista', 'gargalo_hierarquico', 'padrao_pos_eleicao', 'diagnostico_historico', 'rede_da_lideranca'];
// Com a leitura por liderança, 5 cards não davam para cobrir as lideranças
// principais e ainda os alertas gerais da rede.
const MAX_INSIGHTS = 8;

// Prompt da seção 7 da especificação, com dois acréscimos pedidos pela
// própria tela: "detalhe" (o botão "ver detalhe" do card) e "acao_sugerida".
// Seção no lugar de zona e a leitura por liderança: pedido da dona, 06/10/2026.
const PROMPT = `Você é o copiloto de leitura de dados do RedeApoio. Recebe um resumo estruturado da rede de apoiadores de um candidato político (hierarquia, território, nichos temáticos e metas de votos) e devolve de 3 a ${MAX_INSIGHTS} insights acionáveis.

Regras:
- Linguagem simples, sem jargão técnico, para candidato sem bagagem de gestão
- O campo "texto" de cada insight tem no máximo 2 frases
- "detalhe" explica em até 4 frases de onde vem a leitura, citando os números do resumo
- "acao_sugerida" é um próximo passo concreto, em 1 frase (ex.: "Indique um Coordenador para a Zona 18 · Seção 123")
- O território eleitoral é a SEÇÃO, sempre escrita junto da zona, exatamente como vem no resumo ("Zona 18 · Seção 123"). Seções de zonas diferentes são urnas diferentes: nunca some nem compare como se fossem a mesma. Não faça a leitura por zona
- As pessoas vêm só como código ("Líder 3", "Coordenador 3.1", "Mobilizador 3.1.2"; o número mostra de quem cada um é equipe). Cite sempre o código exato, nunca invente nome
- Em "por_lideranca", cada Líder traz a própria rede nos 4 níveis e as seções onde ela está. Use o tipo rede_da_lideranca para a leitura de um Líder: em que seções a rede dele está forte, onde só tem base sem Coordenador/Mobilizador, que Coordenador está sem equipe e, se houver apuração, se a meta bateu nas seções dele. Dedique a maior parte dos insights às lideranças de maior impacto
- Priorize os problemas de maior impacto (vazios territoriais, desequilíbrio de nicho, metas irrealistas, gargalos hierárquicos)
- Quando "resultado_pos_eleicao" vier preenchido, procure padrões nas seções onde o voto ficou abaixo dos cadastrados (ex.: todas do mesmo nicho, sugerindo problema de mensagem, e não de rede) e nas lideranças cuja meta não bateu e use o tipo padrao_pos_eleicao
- Quando "votos_por_local" vier preenchido, aponte as maiores escolas sem ninguém da rede como vazio_territorial e as metas maiores que os eleitores das seções como meta_irrealista
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
const NOME_PAPEL = { 1: 'Líder', 2: 'Coordenador', 3: 'Mobilizador' };
const lideranca = (a) => a.nivel === 1 || a.nivel === 2;
const semZeros = (v) => String(v || '').replace(/\D/g, '').replace(/^0+/, '');
// Rótulo único da seção. Zona sem seção não vira território: sozinha ela é
// justamente a leitura "por zona" que a dona pediu para não fazer.
const rotuloSecao = (zona, secao) => {
  const z = semZeros(zona); const s = semZeros(secao);
  return z && s ? `Zona ${z} · Seção ${s}` : null;
};

// Códigos hierárquicos: Líder 3 → Coordenador 3.1 → Mobilizador 3.1.2. O
// número já diz de quem a pessoa é equipe, que é o que a IA precisa para ler
// a pirâmide sem receber nome nenhum. Líderes numerados pela rede maior
// primeiro. Coordenador/Mobilizador sem Líder acima dele na rede fica sob o 0.
function codificar(rede, filhos, descendentes) {
  const codigo = new Map();
  const tam = (a) => descendentes(a.id).length;
  const numerar = (pessoas, prefixo) => {
    pessoas.sort((x, y) => tam(y) - tam(x)).forEach((a, i) => {
      const num = prefixo ? `${prefixo}.${i + 1}` : String(i + 1);
      codigo.set(a.id, num);
      if (a.nivel < 3) numerar((filhos.get(a.id) || []).filter((f) => f.nivel === a.nivel + 1 && !codigo.has(f.id)), num);
    });
  };
  numerar(rede.filter((a) => a.nivel === 1), '');
  numerar(rede.filter((a) => a.nivel === 2 && !codigo.has(a.id)), '0');
  numerar(rede.filter((a) => a.nivel === 3 && !codigo.has(a.id)), '0.0');
  const deCodigo = new Map();
  for (const a of rede) if (codigo.has(a.id)) deCodigo.set(codigo.get(a.id), a);
  return { rotulo: (a) => (a && codigo.has(a.id) ? `${NOME_PAPEL[a.nivel]} ${codigo.get(a.id)}` : null), deCodigo };
}

async function montarResumo(candidatoId) {
  const { rows: cand } = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [candidatoId]);
  const { rows: rede } = await pool.query(
    `SELECT id, nome, nivel, parent_id, cadastrado_por, meta_votos, zona, secao, regiao, cidade FROM (${SQL_ARVORE_CANDIDATO}) r`,
    [candidatoId]
  );
  await anexarNichos(rede);
  const nichos = await nichosDoCandidato(candidatoId);
  const nomeNicho = new Map(nichos.map((n) => [n.id, n.nome]));
  const secaoDe = (a) => rotuloSecao(a.zona, a.secao);

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

  // Filhos na pirâmide: mesma regra da árvore do sistema (parent_id, ou quem
  // cadastrou quando o cadastro ficou sem responsável).
  const filhos = new Map();
  for (const a of rede) {
    const pai = a.parent_id || a.cadastrado_por;
    if (!pai || pai === a.id) continue;
    if (!filhos.has(pai)) filhos.set(pai, []);
    filhos.get(pai).push(a);
  }
  // Gargalo: nível sem ninguém embaixo (ex.: Líder sem nenhum Coordenador).
  const semEquipe = (nivel) => rede.filter((a) => a.nivel === nivel && !(filhos.get(a.id) || []).some((f) => f.nivel === nivel + 1)).length;
  // Toda a equipe abaixo da pessoa, em todos os níveis. O "vistos" protege de
  // ciclo em parent_id, que reorganização de hierarquia já produziu.
  const cacheDesc = new Map();
  const descendentes = (id) => {
    if (cacheDesc.has(id)) return cacheDesc.get(id);
    const vistos = new Set([id]); const pilha = [id]; const lista = [];
    while (pilha.length) {
      for (const f of filhos.get(pilha.pop()) || []) {
        if (!vistos.has(f.id)) { vistos.add(f.id); pilha.push(f.id); lista.push(f); }
      }
    }
    cacheDesc.set(id, lista);
    return lista;
  };
  const cod = codificar(rede, filhos, descendentes);
  const pessoaPorId = new Map(rede.map((a) => [a.id, a]));

  const nichoPrincipal = (pessoas) => {
    const cont = new Map();
    for (const a of pessoas) for (const id of a.nichos) { const n = nomeNicho.get(id); if (n) cont.set(n, (cont.get(n) || 0) + 1); }
    const top = [...cont.entries()].sort((x, y) => y[1] - x[1])[0];
    return top ? top[0] : null;
  };
  const porNivel = (pessoas) => {
    const c = { lider: 0, coordenador: 0, mobilizador: 0, apoiador: 0 };
    for (const a of pessoas) { const k = ({ 1: 'lider', 2: 'coordenador', 3: 'mobilizador', 4: 'apoiador' })[a.nivel]; if (k) c[k]++; }
    return c;
  };
  const somaMeta = (pessoas) => pessoas.reduce((t, a) => t + (a.nivel <= 3 && a.meta_votos ? a.meta_votos : 0), 0);
  // Seções de um grupo de pessoas, das mais cheias para as mais vazias.
  const secoesDe = (pessoas, limite) => {
    const m = new Map();
    for (const a of pessoas) {
      const k = secaoDe(a); if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(a);
    }
    const lista = [...m.entries()].sort((x, y) => y[1].length - x[1].length);
    return {
      total: lista.length,
      itens: lista.slice(0, limite).map(([secao, ps]) => {
        const n = porNivel(ps);
        return { secao, por_nivel: n, so_base: !n.lider && !n.coordenador && !n.mobilizador };
      }),
    };
  };

  const resumo = {
    candidato: cand[0]?.nome || 'Candidato',
    total_na_rede: rede.length,
    contagem_por_papel,
    contagem_por_nicho,
    sem_nicho,
    territorios_sem_lideranca: {
      bairros: semLideranca(bairro),
      secoes_eleitorais: semLideranca(secaoDe),
    },
    gargalos_hierarquicos: {
      lideres_sem_coordenador: semEquipe(1),
      coordenadores_sem_mobilizador: semEquipe(2),
      mobilizadores_sem_apoiador: semEquipe(3),
      cadastros_sem_responsavel: rede.filter((a) => a.nivel > 1 && !a.parent_id).length,
      sem_secao_eleitoral: rede.filter((a) => !secaoDe(a)).length,
    },
    metas: {
      pessoas_com_meta: rede.filter((a) => a.nivel <= 3 && a.meta_votos != null).length,
      pessoas_sem_meta: rede.filter((a) => a.nivel <= 3 && a.meta_votos == null).length,
      meta_total: somaMeta(rede),
    },
    // Cada Líder com a rede inteira dele nos 4 níveis, seção por seção. Teto
    // de 30 Líderes / 10 seções / 10 Coordenadores para o resumo caber numa
    // chamada de custo razoável; os maiores vêm primeiro.
    por_lideranca: rede.filter((a) => a.nivel === 1)
      .map((l) => ({ l, equipe: descendentes(l.id) }))
      .sort((x, y) => y.equipe.length - x.equipe.length)
      .slice(0, 30)
      .map(({ l, equipe }) => {
        const todos = [l, ...equipe];
        const secs = secoesDe(todos, 10);
        return {
          lideranca: cod.rotulo(l),
          rede_por_nivel: porNivel(equipe),
          meta: somaMeta(todos),
          nicho_principal: nichoPrincipal(todos),
          secoes_com_rede: secs.total,
          sem_secao: todos.filter((a) => !secaoDe(a)).length,
          principais_secoes: secs.itens,
          coordenadores: equipe.filter((c) => c.nivel === 2)
            .map((c) => ({ c, eq: descendentes(c.id) }))
            .sort((x, y) => y.eq.length - x.eq.length)
            .slice(0, 10)
            .map(({ c, eq }) => ({
              lideranca: cod.rotulo(c),
              mobilizadores: eq.filter((a) => a.nivel === 3).length,
              apoiadores: eq.filter((a) => a.nivel === 4).length,
              secoes_com_rede: secoesDe([c, ...eq], 0).total,
              meta: somaMeta([c, ...eq]),
            })),
          resultado: null,
        };
      }),
    metas_vs_capacidade: [],
    resultado_pos_eleicao: null,
    desempenho_historico: null,
  };

  // Apuração (se configurada): a capacidade é o total de eleitores aptos das
  // urnas (o "total de votantes históricos" da especificação) das seções de
  // cada responsável; com urnas apuradas, vem também o resultado pós-eleição
  // por seção e por Líder. Comparecimento não entra: não é guardado.
  const cfgAp = await apuracao.carregarConfig(candidatoId);
  if (cfgAp) {
    const p = await apuracao.painel(candidatoId).catch(() => null);
    if (p && p.secoes) {
      const porId = new Map(rede.map((a) => [a.id, a]));
      const pr = (p.metas?.porResponsavel || []).filter((r) => porId.has(r.id));
      // A meta de cada Líder/Coordenador/Mobilizador contra os eleitores aptos
      // das seções onde ele e a equipe votam. Os mais apertados primeiro.
      resumo.metas_vs_capacidade = pr
        .filter((r) => r.meta && r.aptosSecoes)
        .sort((x, y) => y.meta / y.aptosSecoes - x.meta / x.aptosSecoes)
        .slice(0, 30)
        .map((r) => ({
          lideranca: cod.rotulo(porId.get(r.id)),
          // Cada seção com a zona DELA: a equipe pode votar em mais de uma zona,
          // e a zona do responsável rotularia as outras com o número errado.
          secoes: (r.secoesDetalhe || []).map((d) => rotuloSecao(d.zona, d.secao)),
          meta: r.meta,
          total_votantes_historico: r.aptosSecoes,
        }));

      const resultadoDe = new Map(pr.filter((r) => r.urnasApuradas).map((r) => [r.id, r]));
      for (const item of resumo.por_lideranca) {
        const l = cod.deCodigo.get(item.lideranca.split(' ')[1]);
        const r = l && resultadoDe.get(l.id);
        if (r) item.resultado = { meta: r.meta, votos: r.votos, urnas_apuradas: `${r.urnasApuradas} de ${r.urnasTotal}` };
      }

      const apuradas = p.secoes.filter((s) => s.status === 'apurado');
      if (apuradas.length) {
        // Quem está cadastrado numa seção agregada vota na urna da principal,
        // como na apuração. A meta NÃO entra por seção: a de um Líder cobre a
        // rede inteira dele, e somá-la na seção onde ele mora inventaria uma
        // urna com meta 10 vezes maior que os cadastrados. Meta × voto fica
        // em por_lideranca.resultado.
        const principal = new Map();
        for (const s of p.secoes) for (const x of [s.secao, ...s.agregadas]) principal.set(`${s.zona}|${x}`, `${s.zona}|${s.secao}`);
        const genteDa = new Map();
        for (const a of rede) {
          const k = principal.get(`${tse.pad4(a.zona)}|${tse.pad4(a.secao)}`); if (!k) continue;
          if (!genteDa.has(k)) genteDa.set(k, []);
          genteDa.get(k).push(a);
        }
        const comMeta = pr.filter((r) => r.meta && r.urnasApuradas);
        resumo.resultado_pos_eleicao = {
          eleicao: `${cfgAp.ciclo} (${cfgAp.pleito})`,
          secoes_apuradas: `${apuradas.length} de ${p.secoes.length}`,
          // Primeiro as seções onde o voto ficou mais abaixo da gente
          // cadastrada: é onde há o que ler.
          por_secao: apuradas
            .map((s) => {
              const gente = genteDa.get(`${s.zona}|${s.secao}`) || [];
              return {
                secao: rotuloSecao(s.zona, s.secao),
                cadastrados: s.cadastrados,
                votos: s.votos,
                nicho_principal: nichoPrincipal(gente),
                folga: s.votos - s.cadastrados,
              };
            })
            .sort((x, y) => x.folga - y.folga)
            .slice(0, 40)
            .map(({ folga, ...s }) => s),
          responsaveis: {
            com_meta_apurada: comMeta.length,
            entregaram: comMeta.filter((r) => r.votos >= r.meta).length,
            // Faixas do briefing "Votos por seção": verde ≥ 80%, amarelo 50–79%.
            entregaram_80: comMeta.filter((r) => r.votos >= 0.8 * r.meta).length,
            ficaram_perto: comMeta.filter((r) => r.votos < 0.8 * r.meta && r.votos >= 0.5 * r.meta).length,
            muito_abaixo: comMeta.filter((r) => r.votos < 0.5 * r.meta).length,
          },
        };
      }
    }
  }

  // Votos por seção importados do TSE (briefing "Votos por seção" v2, Fase 2):
  // alimenta os alertas de vazio territorial (escola sem ninguém da rede
  // votando) e de meta irrealista (meta maior que os eleitores das seções da
  // equipe). Escola é dado público; de pessoa, só o papel — nunca o nome.
  // A IA continua só lendo e sugerindo.
  const rel = await entrega.relatorio(candidatoId, { locais: true }).catch(() => null);
  if (rel && rel.locais && rel.urnasCarregadas) {
    const vazios = rel.locais.filter((l) => l.sinal === 'vazio').sort((a, b) => b.aptos - a.aptos);
    resumo.votos_por_local = {
      escolas_no_escopo: rel.locais.length,
      escolas_sem_ninguem_da_rede: vazios.length,
      maiores_escolas_sem_rede: vazios.slice(0, 15).map((l) => ({
        escola: l.nome, bairro: l.bairro, municipio: l.municipio, eleitores_aptos: l.aptos, votos_do_candidato: l.votos,
      })),
      metas_maiores_que_eleitores: rel.liderancas
        .filter((l) => l.meta > 0 && l.aptos > 0 && l.meta > l.aptos)
        .slice(0, 20)
        .map((l) => ({ lideranca: cod.rotulo(pessoaPorId.get(l.id)) || NOME_PAPEL[l.nivel], meta: l.meta, eleitores_aptos_nas_secoes: l.aptos, secoes: l.secoesCobertas })),
    };
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
  // O mapa código → pessoa não é enumerável: fica fora do JSON que vai para a
  // IA e do que é gravado em ia_insights, e serve só para trocarCodigos().
  Object.defineProperty(resumo, 'codigos', { value: cod.deCodigo, enumerable: false });
  return resumo;
}

// Põe o nome no lugar do código nos textos que voltaram da IA. Código que não
// existe na rede (a IA errou o número) fica como veio, em vez de virar o nome
// de outra pessoa.
const RE_CODIGO = /\b(L[íi]der|Coordenador|Mobilizador)\s+(\d+(?:\.\d+){0,2})(?!\d|\.\d)/gi;
function trocarCodigos(texto, codigos) {
  if (!texto) return texto;
  return String(texto).replace(RE_CODIGO, (tudo, papel, num) => {
    const a = codigos.get(num);
    return a ? `${NOME_PAPEL[a.nivel]} ${a.nome}` : tudo;
  });
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
    .slice(0, MAX_INSIGHTS)
    .map((i) => {
      const t = { ...i };
      for (const campo of ['titulo', 'texto', 'detalhe', 'acao_sugerida', 'territorio_ou_nicho_afetado']) t[campo] = trocarCodigos(t[campo], resumo.codigos);
      return t;
    });

  const { rows } = await pool.query(
    `INSERT INTO ia_insights (candidato_id, modelo, resumo, insights, tokens_entrada, tokens_saida)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING gerado_em`,
    [candidatoId, resp.model || MODELO, JSON.stringify(resumo), JSON.stringify(insights), resp.usage?.input_tokens ?? null, resp.usage?.output_tokens ?? null]
  );
  return { gerado_em: rows[0].gerado_em, insights, modelo: resp.model || MODELO };
}

module.exports = { situacao, gerar, montarResumo };