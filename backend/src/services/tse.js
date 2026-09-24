// Leitura do portal de resultados do TSE (resultados.tse.jus.br) — o mesmo que
// o site oficial e o app "Resultados" consomem. Não há API documentada: o
// formato abaixo foi conferido na eleição de 2024 (pleito 452) e é o mesmo
// desde 2022. Se o TSE mudar alguma coisa, é aqui que quebra — e a tela de
// apuração mostra o erro em vez de exibir zero voto como se fosse verdade.
//
// Caminho de um boletim de urna:
//   1. <ciclo>/arquivo-urna/<pleito>/config/<uf>/<uf>-p000<pleito>-cs.json
//      lista municípios → zonas → seções do estado (e quais são agregadas)
//   2. .../dados/<uf>/<mun>/<zona>/<secao>/p000<pleito>-<uf>-m<mun>-z<zona>-s<secao>-aux.json
//      diz se o BU já chegou e em qual pasta (hash) ele está
//   3. .../<hash>/<arquivo>-imgbu.dat — o BU em texto, igual ao impresso na urna

const BASE = 'https://resultados.tse.jus.br/oficial';

// Seção e zona chegam do cadastro de todo jeito ("15", "015", "0015"); o TSE
// usa sempre 4 dígitos. Sem normalizar, "15" e "0015" viram zonas diferentes.
function pad4(v) {
  const d = String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return d && d.length <= 4 ? d.padStart(4, '0') : null;
}

const pad = (n, t) => String(n).padStart(t, '0');

async function baixar(url, { texto = false } = {}) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (resp.status === 404 || resp.status === 403) return null; // ainda não publicado
  if (!resp.ok) throw new Error(`TSE respondeu ${resp.status} em ${url}`);
  if (!texto) return resp.json();
  // O BU vem em Latin-1 (o "ã" de "Município" quebra se lido como UTF-8).
  return new TextDecoder('latin1').decode(await resp.arrayBuffer());
}

// Os arquivos de configuração são grandes (o de SP tem milhares de seções) e
// não mudam durante a apuração: baixar a cada minuto seria desperdício.
const cache = new Map();
async function comCache(chave, horas, fn) {
  const c = cache.get(chave);
  if (c && c.expira > Date.now()) return c.valor;
  const valor = await fn();
  if (valor) cache.set(chave, { valor, expira: Date.now() + horas * 3600e3 });
  return valor;
}

// Eleições que o portal conhece (o TSE publica a do ano pouco antes do dia).
async function listarPleitos() {
  const j = await comCache('ele-c', 1, () => baixar(`${BASE}/comum/config/ele-c.json`));
  if (!j) return [];
  return (j.pl || []).map((p) => ({
    ciclo: j.c,
    pleito: p.cd,
    data: p.dt,
    // tp 7 = consulta popular (plebiscito municipal), que não tem candidato.
    eleicoes: (p.e || []).filter((e) => String(e.tp) !== '7').map((e) => ({
      nome: String(e.nm || '').replace(/&#186;/g, 'º'),
      turno: e.t,
      cargos: [...new Set((e.abr || []).flatMap((a) => (a.cp || []).map((c) => c.ds)))],
    })),
  })).filter((p) => p.eleicoes.length);
}

// Mapa zona|seção → { municipio, zona, principal } de um estado inteiro.
async function configSecoes(ciclo, pleito, uf) {
  return comCache(`cs:${ciclo}:${pleito}:${uf}`, 6, async () => {
    const j = await baixar(`${BASE}/${ciclo}/arquivo-urna/${pleito}/config/${uf}/${uf}-p${pad(pleito, 6)}-cs.json`);
    if (!j) return null;
    const secoes = new Map();
    const municipios = [];
    for (const abr of j.abr || []) {
      for (const mu of abr.mu || []) {
        municipios.push({ codigo: mu.cd, nome: mu.nm });
        for (const zon of mu.zon || []) {
          for (const s of zon.sec || []) {
            // "nsp" = seção agregada: vota na urna da seção principal indicada.
            secoes.set(`${zon.cd}|${s.ns}`, { municipio: mu.cd, zona: zon.cd, principal: s.nsp || s.ns });
          }
        }
      }
    }
    municipios.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    return { secoes, municipios };
  });
}

// Votos de um número num BU em texto. Devolve null se o cargo não aparece no
// boletim — o que significa configuração errada (cargo trocado), e não zero
// voto. Candidato sem voto na seção simplesmente não é listado no BU.
function votosNoBU(texto, cargo, numero) {
  const linhas = texto.split(/\r?\n/);
  const cabecalho = /^\s*-{3,}\s*([A-ZÀ-Ú][A-ZÀ-Ú ]+?)\s*-{3,}\s*$/;
  const alvo = cargo.trim().toUpperCase();
  let dentro = false;
  let achouCargo = false;
  for (const linha of linhas) {
    const cab = linha.match(cabecalho);
    if (cab) {
      dentro = cab[1].trim() === alvo;
      if (dentro) achouCargo = true;
      continue;
    }
    if (!dentro) continue;
    // "  MARIA IZABEL             11123  0003" — nome, número, votos. Nome
    // comprido quebra em duas linhas e o número vai para a de baixo, depois de
    // uma seta ("----->  15123  0014"); o casamento pelo fim da linha cobre os dois.
    const m = linha.match(/\s(\d{2,5})\s+(\d{1,5})\s*$/);
    if (m && m[1] === numero) return Number(m[2]);
  }
  return achouCargo ? 0 : null;
}

// Totais da urna impressos no BU. Primeira ocorrência: o BU repete os aptos
// no rodapé de cada cargo, com o mesmo valor.
function totaisDoBU(texto) {
  const num = (re) => { const m = texto.match(re); return m ? Number(m[1]) : null; };
  return {
    aptos: num(/Eleitores aptos\s+(\d+)/),
    comparecimento: num(/Comparecimento\s+(\d+)/),
  };
}

// Busca o BU de uma seção. null = ainda não divulgado; senão
// { votos, aptos, comparecimento }.
async function buscarSecao({ ciclo, pleito, uf, municipio, zona, secao, cargo, numero }) {
  const p6 = pad(pleito, 6);
  const pasta = `${BASE}/${ciclo}/arquivo-urna/${pleito}/dados/${uf}/${municipio}/${zona}/${secao}`;
  const aux = await baixar(`${pasta}/p${p6}-${uf}-m${municipio}-z${zona}-s${secao}-aux.json`);
  if (!aux || !Array.isArray(aux.hashes) || !aux.hashes.length) return null;
  // Uma urna pode ter mais de um envio (reenvio, urna de contingência). Vale o
  // que o TSE totalizou; sem ele, o mais recente que não tenha sido excluído.
  const validos = aux.hashes.filter((h) => !/exclu|anulad|cancel/i.test(h.st || ''));
  const h = validos.find((x) => /totalizad/i.test(x.st || '')) || validos[validos.length - 1];
  const arq = h && (h.arq || []).find((a) => a.tp === 'imgbu');
  if (!arq) return null;
  const texto = await baixar(`${pasta}/${h.hash}/${arq.nm}`, { texto: true });
  if (!texto) return null;
  const votos = votosNoBU(texto, cargo, numero);
  if (votos === null) {
    throw new Error(`O cargo "${cargo}" não aparece no boletim de urna. Confira o cargo na configuração.`);
  }
  return { votos, ...totaisDoBU(texto) };
}

// ─── Resultado consolidado por município (eleições passadas) ────────────────
// Um arquivo por município × cargo com TODOS os candidatos, os votos e a
// posição no ranking local ("seq"). Dois formatos convivem no portal:
//   -u.json → carg[].agr[].par[].cand[] com nome e partido (eleição estadual e municipal)
//   -v.json → abr[].cand[] só com número, mas com eleitores aptos e comparecimento
// ("seq" nos dois NÃO é a posição por votos — ver abaixo.)
// Presidente (2022) só tem o -v; os demais têm os dois. Tenta o -u primeiro
// pelo nome, e completa aptos/comparecimento com o -v quando existir.
async function resultadoMunicipio({ ciclo, eleicao, uf, municipio, cargo }) {
  const base = `${BASE}/${ciclo}/${eleicao}/dados/${uf}/${uf}${municipio}-c${pad(cargo, 4)}-e${pad(eleicao, 6)}`;
  const [u, v] = await Promise.all([baixar(`${base}-u.json`).catch(() => null), baixar(`${base}-v.json`).catch(() => null)]);
  let candidatos = [];
  if (u && Array.isArray(u.carg)) {
    for (const c of u.carg) {
      for (const agr of c.agr || []) {
        for (const par of agr.par || []) {
          for (const cand of par.cand || []) {
            candidatos.push({
              numero: String(cand.n), nome: cand.nmu || cand.nm || null, partido: par.sg || null,
              votos: Number(cand.vap) || 0, posicao: Number(cand.seq) || null, eleito: /^s$/i.test(cand.e || ''),
            });
          }
        }
      }
    }
  }
  const abr = v && Array.isArray(v.abr) ? v.abr[0] : null;
  if (!candidatos.length && abr) {
    candidatos = (abr.cand || []).map((cand) => ({
      numero: String(cand.n), nome: null, partido: null,
      votos: Number(cand.vap) || 0, posicao: Number(cand.seq) || null, eleito: /^s$/i.test(cand.e || ''),
    }));
  }
  if (!candidatos.length) return null;
  // A posição é calculada aqui, pelos votos. O "seq" do TSE parece ranking,
  // mas não é: no arquivo de vereador de Dourados/2024 a candidata com 2.992
  // votos vinha com seq 30 e o de 2.375 com seq 33 — a ordem é outra (lista
  // de eleitos). Empate de votos divide a mesma posição.
  candidatos.sort((a, b) => b.votos - a.votos);
  candidatos.forEach((c, i) => {
    c.posicao = i > 0 && c.votos === candidatos[i - 1].votos ? candidatos[i - 1].posicao : i + 1;
  });
  return {
    candidatos,
    aptos: abr && abr.e ? Number(abr.e) : null,
    comparecimento: abr && abr.c ? Number(abr.c) : null,
  };
}

// Municípios de um estado naquela eleição (lista oficial, com código TSE).
async function municipiosEleicao(ciclo, eleicao, uf) {
  const j = await comCache(`cm:${ciclo}:${eleicao}`, 24, () => baixar(`${BASE}/${ciclo}/${eleicao}/config/mun-e${pad(eleicao, 6)}-cm.json`));
  if (!j) return [];
  const estado = (j.abr || []).find((a) => String(a.cd).toLowerCase() === uf);
  return (estado?.mu || []).map((m) => ({ codigo: m.cd, nome: m.nm }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

module.exports = { pad4, listarPleitos, configSecoes, buscarSecao, votosNoBU, resultadoMunicipio, municipiosEleicao };
