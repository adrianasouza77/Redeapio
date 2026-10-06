const pool = require('../db');
const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');
const { anexarNichos, nichosDoCandidato } = require('../utils/nichos');
const apuracao = require('./apuracao');
const entrega = require('./entrega');
const historico = require('./historico');
const campanha = require('./campanha');
const votosSecao = require('./votosSecao');
const tse = require('./tse');

// Resumos que o Copiloto lê — um por tela (orientação técnica "Copiloto da
// rede por tela", 06/10/2026: a leitura explica a tela que a pessoa está
// vendo, com o candidato e os filtros dela). Telas sem resumo próprio caem
// na leitura geral (montarResumo), que era a única até então.
//
// Mesmas regras de sempre, em toda função daqui:
//  - nenhum nome, telefone ou título de eleitor de apoiador entra no resumo.
//    Pessoa vai como CÓDIGO ("Líder 3", "Coordenador 3.1"); o nome só entra
//    no lugar do código na resposta, no servidor (trocarCodigos);
//  - território eleitoral é sempre "Zona X · Seção Y" (rotuloSecao): o número
//    da seção se repete em toda zona, e a dona pediu leitura por seção;
//  - votos de pessoa são os ATRIBUÍDOS à equipe (utils/atribuicao.js), e sem
//    meta declarada não há porcentagem.
//
// Só leitura: nada aqui grava, envia ou altera a rede (CLAUDE.md, regra 7).

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
  const { rede, nichos, nomeNicho, filhos, descendentes, cod, pessoaPorId } = await carregarRede(candidatoId);
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

  // Gargalo: nível sem ninguém embaixo (ex.: Líder sem nenhum Coordenador).
  const semEquipe = (nivel) => rede.filter((a) => a.nivel === nivel && !(filhos.get(a.id) || []).some((f) => f.nivel === nivel + 1)).length;

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


// ─── Base comum das leituras por tela ───────────────────────────────────────

// A rede do candidato já montada em pirâmide e codificada. Toda leitura por
// tela parte daqui, para que "Líder 3" seja a mesma pessoa em qualquer tela.
async function carregarRede(candidatoId) {
  const { rows: rede } = await pool.query(
    `SELECT id, nome, nivel, parent_id, cadastrado_por, meta_votos, zona, secao, regiao, cidade FROM (${SQL_ARVORE_CANDIDATO}) r`,
    [candidatoId]
  );
  await anexarNichos(rede);
  const nichos = await nichosDoCandidato(candidatoId);
  const nomeNicho = new Map(nichos.map((n) => [n.id, n.nome]));
  // Filhos na pirâmide: mesma regra da árvore do sistema (parent_id, ou quem
  // cadastrou quando o cadastro ficou sem responsável).
  const filhos = new Map();
  for (const a of rede) {
    const pai = a.parent_id || a.cadastrado_por;
    if (!pai || pai === a.id) continue;
    if (!filhos.has(pai)) filhos.set(pai, []);
    filhos.get(pai).push(a);
  }
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
  return { rede, nichos, nomeNicho, filhos, descendentes, cod, pessoaPorId: new Map(rede.map((a) => [a.id, a])) };
}

const porNivelDe = (pessoas) => {
  const c = { lider: 0, coordenador: 0, mobilizador: 0, apoiador: 0 };
  for (const a of pessoas) { const k = ({ 1: 'lider', 2: 'coordenador', 3: 'mobilizador', 4: 'apoiador' })[a.nivel]; if (k) c[k]++; }
  return c;
};
const pctDe = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const bairroDe = (a) => (a.regiao && a.regiao !== '—' ? `${a.regiao.trim()}${a.cidade ? ' (' + a.cidade.trim() + ')' : ''}` : null);
const metaOuSem = (m) => (m != null ? m : 'sem meta');
// Entrega só existe com meta declarada (06/10/2026): sem meta não há %.
const entregaDe = (votos, meta) => (meta ? pctDe(votos, meta) : null);

async function infoCampanha(candidatoId) {
  const d = await campanha.carregarDados(candidatoId).catch(() => null);
  if (d) return { nome: d.nome_urna || d.nome_candidato, cargo: d.cargo_nome, numero: d.numero, dados: d };
  const { rows } = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [candidatoId]);
  return { nome: rows[0]?.nome || 'Candidato', cargo: null, numero: null, dados: null };
}

// Quando foi a última importação de votos do TSE desta eleição — o Início
// cita isso (orientação técnica de 06/10/2026).
async function importadoEm(d) {
  if (!d?.ciclo) return null;
  const { rows } = await pool.query('SELECT atualizado_em FROM tse_coletas WHERE ciclo = $1 AND pleito = $2 AND uf = $3', [d.ciclo, d.pleito, d.uf]);
  return rows[0]?.atualizado_em || null;
}

// Votos por pessoa: da importação do TSE (Prometido × Entregue) se houver;
// senão da apuração ao vivo. Os dois já vêm divididos por seção (votos da
// equipe, utils/atribuicao.js) e com meta null quando não foi declarada.
async function votosPorPessoa(candidatoId) {
  const rel = await entrega.relatorio(candidatoId, {}).catch(() => null);
  if (rel && rel.urnasCarregadas) {
    return { fonte: 'votos importados do TSE', rel, porId: new Map(rel.liderancas.map((l) => [l.id, { meta: l.meta, votos: l.votos, votosSecoes: l.votosSecoes, secoes: l.secoesCobertas }])) };
  }
  const cfg = await apuracao.carregarConfig(candidatoId).catch(() => null);
  if (cfg) {
    const p = await apuracao.painel(candidatoId).catch(() => null);
    const pr = p?.metas?.porResponsavel;
    if (pr && pr.some((r) => r.urnasApuradas)) {
      return { fonte: 'apuração ao vivo', rel: null, porId: new Map(pr.map((r) => [r.id, { meta: r.meta, votos: r.urnasApuradas ? r.votos : null, votosSecoes: r.votosSecoes, secoes: r.urnasTotal }])) };
    }
  }
  return { fonte: null, rel: rel && !rel.semDados && !rel.indisponivel ? rel : null, porId: new Map() };
}

// ─── Início ─────────────────────────────────────────────────────────────────
async function resumoInicio(candidatoId) {
  const R = await carregarRede(candidatoId);
  const info = await infoCampanha(candidatoId);
  const { rede, filhos } = R;
  const semEquipe = (nivel) => rede.filter((a) => a.nivel === nivel && !(filhos.get(a.id) || []).some((f) => f.nivel === nivel + 1)).length;
  const comSecao = rede.filter((a) => rotuloSecao(a.zona, a.secao)).length;
  const lideres = rede.filter((a) => a.nivel <= 3);
  const resumo = {
    candidato: { nome: info.nome, cargo: info.cargo, numero: info.numero },
    rede: {
      total: rede.length, por_nivel: porNivelDe(rede),
      com_secao_eleitoral: comSecao, pct_com_secao: pctDe(comSecao, rede.length),
      cadastros_sem_responsavel: rede.filter((a) => a.nivel > 1 && !a.parent_id).length,
    },
    estrutura: {
      lideres_sem_coordenador: semEquipe(1), coordenadores_sem_mobilizador: semEquipe(2), mobilizadores_sem_apoiador: semEquipe(3),
    },
    metas: {
      com_meta: lideres.filter((a) => a.meta_votos != null).length,
      sem_meta: lideres.filter((a) => a.meta_votos == null).length,
      meta_total_declarada: lideres.reduce((t, a) => t + (a.meta_votos || 0), 0),
    },
    votos: null,
    apuracao_ao_vivo: null,
  };
  const rel = await entrega.relatorio(candidatoId, {}).catch(() => null);
  if (rel && rel.urnasCarregadas) {
    const ls = rel.liderancas.filter((l) => l.nivel === 1);
    resumo.votos = {
      importados_em: await importadoEm(info.dados),
      total_oficial_do_candidato: rel.totalOficial,
      votos_nas_secoes_da_campanha: rel.atribuicao.totalImportado,
      cabem_a_rede: rel.atribuicao.atribuidosRede, fora_da_rede: rel.atribuicao.foraDaRede,
      lideres_por_sinal: {
        entregou: ls.filter((l) => l.sinal === 'verde').length, ficou_perto: ls.filter((l) => l.sinal === 'amarelo').length,
        abaixo: ls.filter((l) => l.sinal === 'vermelho').length, sem_meta: ls.filter((l) => !l.metaDeclarada).length,
      },
    };
  } else {
    resumo.votos = { situacao: 'votos do TSE ainda não importados' };
  }
  const cfg = await apuracao.carregarConfig(candidatoId).catch(() => null);
  if (cfg) {
    const p = await apuracao.painel(candidatoId).catch(() => null);
    if (p && p.zonas) {
      const tot = p.zonas.reduce((t, z) => ({ secoes: t.secoes + z.secoesTotal, apuradas: t.apuradas + z.secoesApuradas, votos: t.votos + z.votosZona }), { secoes: 0, apuradas: 0, votos: 0 });
      resumo.apuracao_ao_vivo = { eleicao: `${cfg.ciclo} (${cfg.pleito})`, urnas_apuradas: `${tot.apuradas} de ${tot.secoes}`, votos_apurados: tot.votos };
    }
  }
  return { resumo, codigos: R.cod.deCodigo };
}

// ─── Rede de Apoio (pirâmide) ───────────────────────────────────────────────
async function resumoRede(candidatoId) {
  const R = await carregarRede(candidatoId);
  const { rede, filhos, descendentes, cod } = R;
  const v = await votosPorPessoa(candidatoId);
  const semEquipe = (nivel) => rede.filter((a) => a.nivel === nivel && !(filhos.get(a.id) || []).some((f) => f.nivel === nivel + 1));
  const listaCodigos = (ps) => ({ total: ps.length, quem: ps.slice(0, 15).map((a) => cod.rotulo(a)) });
  const linha = (a) => {
    const x = v.porId.get(a.id);
    const meta = a.meta_votos != null ? a.meta_votos : null;
    const votos = x && x.votos != null ? x.votos : null;
    return { meta: metaOuSem(meta), votos_da_equipe: votos, entrega_pct: votos != null ? entregaDe(votos, meta) : null };
  };
  const lideres = rede.filter((a) => a.nivel === 1)
    .map((l) => ({ l, eq: descendentes(l.id) }))
    .sort((x, y) => y.eq.length - x.eq.length)
    .slice(0, 30)
    .map(({ l, eq }) => {
      const coords = eq.filter((a) => a.nivel === 2);
      return {
        lideranca: cod.rotulo(l), equipe: porNivelDe(eq), ...linha(l),
        coordenadores_sem_mobilizador: coords.filter((c) => !(filhos.get(c.id) || []).some((f) => f.nivel === 3)).length,
        coordenadores: coords.map((c) => ({ c, n: descendentes(c.id).length })).sort((x, y) => y.n - x.n).slice(0, 8)
          .map(({ c }) => ({ lideranca: cod.rotulo(c), equipe: porNivelDe(descendentes(c.id)), ...linha(c) })),
      };
    });
  return {
    resumo: {
      fonte_dos_votos: v.fonte || 'nenhuma: sem importação do TSE nem apuração ao vivo',
      como_ler: 'votos_da_equipe = a parte dos votos de cada seção que cabe aos cadastrados da equipe ali; sem meta declarada não há entrega_pct',
      total_na_rede: rede.length, por_nivel: porNivelDe(rede),
      lideres,
      estrutura_quebrada: {
        lideres_sem_coordenador: listaCodigos(semEquipe(1)),
        coordenadores_sem_mobilizador: listaCodigos(semEquipe(2)),
        mobilizadores_sem_apoiador: listaCodigos(semEquipe(3)),
        cadastros_sem_responsavel: rede.filter((a) => a.nivel > 1 && !a.parent_id).length,
      },
    },
    codigos: cod.deCodigo,
  };
}

// ─── Rede por território ────────────────────────────────────────────────────
async function resumoTerritorio(candidatoId) {
  const R = await carregarRede(candidatoId);
  const { rede } = R;
  const agrupar = (chave) => {
    const m = new Map();
    for (const a of rede) {
      const k = chave(a); if (!k) continue;
      if (!m.has(k)) m.set(k, { cadastrados: 0, liderancas: 0, por_nivel: [] });
      const t = m.get(k); t.cadastrados++; t.por_nivel.push(a);
      if (lideranca(a)) t.liderancas++;
    }
    const lista = [...m.entries()].map(([territorio, t]) => ({ territorio, cadastrados: t.cadastrados, liderancas: t.liderancas, por_nivel: porNivelDe(t.por_nivel) }));
    return {
      total: lista.length,
      sem_lideranca: lista.filter((t) => !t.liderancas).sort((x, y) => y.cadastrados - x.cadastrados).slice(0, 25).map(({ por_nivel, liderancas, ...t }) => t),
      com_mais_gente: lista.sort((x, y) => y.cadastrados - x.cadastrados).slice(0, 15),
    };
  };
  return {
    resumo: {
      como_ler: 'liderança = Líder ou Coordenador morando/votando no território',
      total_na_rede: rede.length,
      bairros: agrupar(bairroDe),
      secoes_eleitorais: agrupar((a) => rotuloSecao(a.zona, a.secao)),
      sem_bairro: rede.filter((a) => !bairroDe(a)).length,
      sem_secao_eleitoral: rede.filter((a) => !rotuloSecao(a.zona, a.secao)).length,
    },
    codigos: R.cod.deCodigo,
  };
}

// ─── Apoiadores ─────────────────────────────────────────────────────────────
async function resumoApoiadores(candidatoId) {
  const R = await carregarRede(candidatoId);
  const { rede, descendentes, cod } = R;
  const semResp = rede.filter((a) => a.nivel > 1 && !a.parent_id);
  const contar = (ps, chave, n) => {
    const m = new Map();
    for (const a of ps) { const k = chave(a) || 'não informado'; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([territorio, cadastrados]) => ({ territorio, cadastrados }));
  };
  return {
    resumo: {
      total: rede.length, por_nivel: porNivelDe(rede),
      por_lider: rede.filter((a) => a.nivel === 1)
        .map((l) => ({ l, eq: [l, ...descendentes(l.id)] }))
        .sort((x, y) => y.eq.length - x.eq.length).slice(0, 30)
        .map(({ l, eq }) => ({
          lideranca: cod.rotulo(l), cadastrados: eq.length - 1,
          sem_secao: eq.filter((a) => !rotuloSecao(a.zona, a.secao)).length,
          bairros: new Set(eq.map(bairroDe).filter(Boolean)).size,
        })),
      sem_responsavel: { total: semResp.length, por_nivel: porNivelDe(semResp), onde: contar(semResp, bairroDe, 10) },
      sem_secao_eleitoral: rede.filter((a) => !rotuloSecao(a.zona, a.secao)).length,
      sem_bairro: rede.filter((a) => !bairroDe(a)).length,
      por_bairro: contar(rede, bairroDe, 15),
    },
    codigos: cod.deCodigo,
  };
}

// ─── Votos por seção ────────────────────────────────────────────────────────
const CARGO_NOME = { 1: 'Presidente', 3: 'Governador', 5: 'Senador', 6: 'Deputado Federal', 7: 'Deputado Estadual', 8: 'Deputado Distrital', 11: 'Prefeito', 13: 'Vereador' };

async function resumoVotosPorSecao(candidatoId, f) {
  if (!f.ciclo || !f.pleito || !f.eleicao || !f.uf || !f.cargo || !f.numero) {
    throw erroTela('Escolha a eleição, o cargo e o candidato na tela de Votos por Seção antes de pedir a leitura.');
  }
  const municipal = campanha.MUNICIPAIS.includes(f.cargo);
  const r = await votosSecao.resultadoCandidato({
    ciclo: f.ciclo, pleito: f.pleito, eleicao: f.eleicao, uf: f.uf, cargo: f.cargo, numero: f.numero,
    municipio: municipal ? f.municipio || null : null, candidatoId, secoesDoMunicipio: f.municipio || null,
  });
  const secoes = f.municipio ? r.secoes.filter((s) => s.municipio === f.municipio) : r.secoes;
  const mun = f.municipio ? r.municipios.find((m) => m.codigo === f.municipio) : null;
  const t = mun || r.resumo;
  const nomeMun = new Map(r.municipios.map((m) => [m.codigo, m.nome]));
  const local = new Map(r.locais.map((l) => [l.id, l.nome]));
  // Nada de nome de liderança aqui: "liderancas" de cada seção é lista de
  // nomes e não sai do servidor. Escola e bairro são dado público do TSE.
  const linha = (s) => ({
    secao: rotuloSecao(s.zona, s.secao), municipio: nomeMun.get(s.municipio) || s.municipio,
    local: local.get(s.local) || null, bairro: s.bairro, eleitores_aptos: s.aptos, votos: s.votos, cadastrados_da_rede: s.rede,
  });
  const comRede = secoes.filter((s) => s.rede > 0);
  return {
    resumo: {
      candidato_na_tela: { nome: r.candidato?.nome || null, numero: f.numero, cargo: CARGO_NOME[f.cargo] || String(f.cargo) },
      escopo: mun ? mun.nome : 'estado inteiro',
      totalizacao_tse: r.cargo?.totalizacao ? { secoes_totalizadas: r.cargo.totalizacao.secoesTotalizadas, secoes_total: r.cargo.totalizacao.secoesTotal, final: r.cargo.totalizacao.final } : null,
      total_votos: t.votos || 0, urnas: t.urnas || 0, urnas_com_voto: t.comVoto || 0, urnas_com_zero_voto: (t.urnas || 0) - (t.comVoto || 0),
      pct_dos_validos: pctDe(t.votos || 0, t.vv || 0),
      rede_no_escopo: { cadastrados_com_secao: t.rede || 0, secoes_com_rede: comRede.length, votos_nas_secoes_com_rede: t.votosRede || 0 },
      secoes_com_rede_e_zero_voto: comRede.filter((s) => !s.votos).length,
      cadastro_alto_voto_baixo: comRede.slice().sort((x, y) => (y.rede - y.votos) - (x.rede - x.votos)).slice(0, 15).map(linha),
      maiores_secoes_sem_rede: secoes.filter((s) => !s.rede).sort((x, y) => (y.aptos || 0) - (x.aptos || 0)).slice(0, 15).map(linha),
      secoes_mais_votadas: secoes.slice().sort((x, y) => y.votos - x.votos).slice(0, 10).map(linha),
      // Estado inteiro sem filtro de cidade: a lista de seções vem cortada
      // (as da rede + as mais votadas). Os totais acima são do estado todo.
      lista_de_secoes_parcial: !f.municipio && !!r.secoesParciais,
    },
    codigos: new Map(),
  };
}

// ─── Prometido × Entregue ───────────────────────────────────────────────────
async function resumoPrometidoEntregue(candidatoId, f) {
  const filtros = { ...f }; delete filtros.aba;
  const rel = await entrega.relatorio(candidatoId, { filtros, detalhe: f.lideranca || null });
  if (rel.semDados) return { resumo: { situacao: 'dados do candidato não cadastrados' }, codigos: new Map() };
  if (rel.indisponivel || !rel.urnasCarregadas) return { resumo: { situacao: 'votos do TSE ainda não importados' }, codigos: new Map() };
  const R = await carregarRede(candidatoId);
  const { cod, pessoaPorId } = R;
  const rot = (id) => cod.rotulo(pessoaPorId.get(id));
  const nichoNome = f.nicho ? rel.filtrosDisponiveis.nichos.find((n) => n.id === f.nicho)?.nome : null;
  const linha = (l) => ({
    lideranca: rot(l.id), meta: metaOuSem(l.meta), votos_da_equipe: l.votos, votos_nas_secoes: l.votosSecoes,
    entrega_pct: l.entrega, rede_cadastrada: l.redeCadastrada, com_secao: l.comSecao, secoes_cobertas: l.secoesCobertas,
  });
  const resumo = {
    candidato: { nome: rel.dados.nome, cargo: rel.dados.cargo, numero: rel.dados.numero },
    escopo: {
      municipio: f.municipio ? rel.filtrosDisponiveis.municipios.find((m) => m.codigo === f.municipio)?.nome || f.municipio : 'todos',
      zona: f.zona || null, bairro: f.bairro || null, nivel: f.nivel ? NOME_PAPEL[f.nivel] : null, nicho: nichoNome || null,
      lider: f.lideranca ? rot(f.lideranca) : null,
    },
    como_ler: 'votos_da_equipe = em cada seção, a parte dos votos que cabe aos cadastrados da equipe ali (dividida entre as equipes da mesma seção); votos_nas_secoes = total do candidato nessas urnas, só referência; sem meta não há entrega_pct',
    votos_no_escopo: { do_candidato: rel.atribuicao.totalImportado, cabem_a_rede: rel.atribuicao.atribuidosRede, fora_da_rede: rel.atribuicao.foraDaRede, alertas: rel.atribuicao.alertas },
    lider_selecionado: null,
    liderancas: [],
  };
  let lista = rel.liderancas;
  if (f.lideranca) {
    const l = rel.liderancas.find((x) => x.id === f.lideranca);
    if (l) {
      const ps = l.porSecao || [];
      resumo.lider_selecionado = {
        ...linha(l),
        sem_secao: (l.semSecao || []).length,
        secoes_com_zero_voto: ps.filter((s) => !s.votos).length,
        // Onde vazou: seções com mais gente da equipe e menos voto que cabe a ela.
        onde_vazou: ps.slice().sort((x, y) => (y.cadastrados - y.atribuidos) - (x.cadastrados - x.atribuidos)).slice(0, 15).map((s) => ({
          secao: rotuloSecao(s.zona, s.secao), local: s.local || null, bairro: s.bairro,
          cadastrados_da_equipe: s.cadastrados, votos_na_secao: s.votos, cabem_a_equipe: s.atribuidos,
        })),
      };
      lista = rel.liderancas.filter((x) => x.id !== f.lideranca);
    }
  }
  resumo.liderancas = lista.slice(0, 30).map(linha);
  resumo.sinais = {
    entregou: lista.filter((l) => l.sinal === 'verde').length, ficou_perto: lista.filter((l) => l.sinal === 'amarelo').length,
    abaixo: lista.filter((l) => l.sinal === 'vermelho').length, sem_meta: lista.filter((l) => !l.metaDeclarada).length,
  };
  return { resumo, codigos: cod.deCodigo };
}

// ─── Leitura geral (telas sem resumo próprio) ──────────────────────────────
async function resumoGeral(candidatoId) {
  const resumo = await montarResumo(candidatoId);
  return { resumo, codigos: resumo.codigos };
}

// ─── Contexto: tela + filtros ───────────────────────────────────────────────
// Só o que está nesta lista chega aqui; o resto do que o navegador mandar é
// descartado. Filtros também passam por validação — vão parar em consulta e,
// no caso de votos por seção, em URL do TSE.
const TELAS = {
  inicio: { nome: 'Início', montar: resumoInicio },
  rede: { nome: 'Rede de Apoio', montar: resumoRede },
  territorio: { nome: 'Rede por território', montar: resumoTerritorio },
  apoiadores: { nome: 'Apoiadores', montar: resumoApoiadores },
  votos_por_secao: { nome: 'Votos por seção', montar: resumoVotosPorSecao },
  prometido_entregue: { nome: 'Prometido × Entregue', montar: resumoPrometidoEntregue },
  geral: { nome: 'Visão geral da rede', montar: resumoGeral },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UFS = ['ac', 'al', 'ap', 'am', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mt', 'ms', 'mg', 'pa', 'pb', 'pr', 'pe', 'pi', 'rj', 'rn', 'rs', 'ro', 'rr', 'sc', 'sp', 'se', 'to'];

function normalizarContexto(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const tela = TELAS[e.tela] ? e.tela : 'geral';
  const f = e.filtros && typeof e.filtros === 'object' ? e.filtros : {};
  const out = {};
  const pega = (k, re, conv = String) => { const v = f[k]; if (v != null && v !== '' && re.test(String(v))) out[k] = conv(v); };
  if (tela === 'votos_por_secao') {
    pega('ciclo', /^ele\d{4}$/); pega('pleito', /^\d{1,6}$/); pega('eleicao', /^\d{1,6}$/);
    if (UFS.includes(String(f.uf || '').toLowerCase())) out.uf = String(f.uf).toLowerCase();
    pega('cargo', /^\d{1,2}$/, Number); pega('numero', /^\d{2,5}$/); pega('municipio', /^\d{5}$/);
  }
  if (tela === 'prometido_entregue') {
    pega('municipio', /^\d{5}$/); pega('zona', /^\d{1,4}$/); pega('nivel', /^[1-3]$/, Number);
    pega('nicho', UUID); pega('lideranca', UUID); pega('aba', /^(liderancas|zonas|secoes)$/);
    if (f.bairro) out.bairro = String(f.bairro).slice(0, 120);
  }
  // Chave estável: mesmas escolhas em outra ordem são a mesma leitura.
  const filtros = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  return { tela, filtros, nomeTela: TELAS[tela].nome };
}

async function montarTela(candidatoId, ctx) {
  return TELAS[ctx.tela].montar(candidatoId, ctx.filtros);
}

// "Impressão" dos dados que a leitura usou. Mudou cadastro (inclusive meta,
// responsável ou seção), importação do TSE ou apuração ao vivo, a leitura
// guardada passa a constar como desatualizada.
async function versaoDados(candidatoId) {
  const [{ rows: r }, { rows: t }, { rows: a }] = await Promise.all([
    pool.query(
      `SELECT count(*)::int n, max(created_at) m, COALESCE(sum(meta_votos), 0)::bigint s, count(secao)::int cs,
              count(parent_id)::int cp, COALESCE(sum(nivel), 0)::int sn FROM (${SQL_ARVORE_CANDIDATO}) r`, [candidatoId]
    ),
    pool.query('SELECT max(atualizado_em) m FROM tse_coletas'),
    pool.query('SELECT count(*)::int n, COALESCE(sum(votos), 0)::bigint v FROM apuracao_secoes WHERE candidato_id = $1', [candidatoId]),
  ]);
  const x = r[0];
  return [x.n, x.m && x.m.toISOString(), x.s, x.cs, x.cp, x.sn, t[0].m && t[0].m.toISOString(), a[0].n, a[0].v].join('|');
}

function erroTela(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

module.exports = { TELAS, normalizarContexto, montarTela, versaoDados, trocarCodigos, montarResumo, erroTela };
