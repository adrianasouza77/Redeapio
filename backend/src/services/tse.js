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
//   3. .../<hash>/<arquivo>-bu.dat — o BU em ASN.1 (binário), lido por buBinario()
//      .../<hash>/<arquivo>-imgbu.dat — o mesmo BU em texto, só como reserva
//
// Na noite de 04/10/2026 o TSE publicava só o bu.dat: o imgbu.dat dava 404 em
// 100% das seções já recebidas (50 de 50 na amostra de MS), e a apuração
// inteira ficava "aguardando" enquanto o site oficial já tinha 15% das urnas.

const BASE = 'https://resultados.tse.jus.br/oficial';

// Seção e zona chegam do cadastro de todo jeito ("15", "015", "0015"); o TSE
// usa sempre 4 dígitos. Sem normalizar, "15" e "0015" viram zonas diferentes.
function pad4(v) {
  const d = String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return d && d.length <= 4 ? d.padStart(4, '0') : null;
}

const pad = (n, t) => String(n).padStart(t, '0');

async function baixar(url, { texto = false, binario = false, semCache = false } = {}) {
  // A CDN do TSE guarda até ~50 s, inclusive o 404 de um arquivo que ainda
  // não existia. O app oficial fura com ?nocache=<agora>; fazemos igual no
  // que muda durante a apuração (o aux.json de cada seção).
  const resp = await fetch(semCache ? `${url}?nocache=${Date.now()}` : url, { signal: AbortSignal.timeout(20000) });
  if (resp.status === 404 || resp.status === 403) return null; // ainda não publicado
  if (!resp.ok) throw new Error(`TSE respondeu ${resp.status} em ${url}`);
  if (binario) return Buffer.from(await resp.arrayBuffer());
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
    // O ciclo vem em cada pleito ("c": "ele2026"): o ele-c.json de 2026 mistura
    // pleitos de 2024 e 2026 e não tem mais "c" no topo. Lendo do topo, toda
    // opção da lista saía "undefined" e a configuração era recusada.
    ciclo: p.c || j.c,
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

// Eleitores aptos da urna, impresso no BU (primeira ocorrência: o BU repete o
// número no rodapé de cada cargo). O BU também traz o comparecimento, mas ele
// é ignorado de propósito: a especificação da apuração proíbe guardar dado de
// comparecimento.
function totaisDoBU(texto) {
  const m = texto.match(/Eleitores aptos\s+(\d+)/);
  return { aptos: m ? Number(m[1]) : null };
}

// ─── BU binário (bu.dat) ─────────────────────────────────────────────────────
// ASN.1 em BER, especificação pública do TSE (bu.asn1). Não precisa de
// biblioteca: o leitor abaixo só separa tag/tamanho/conteúdo, e buBinario()
// procura as estruturas pelo formato, sem depender da posição exata de cada
// campo. Conferido no BU real da seção 0012/zona 0053 de Campo Grande
// (04/10/2026): em todo cargo a soma dos votos bate com o comparecimento.
//
// Estruturas usadas (o resto do BU é ignorado):
//   ResultadoVotacaoPorEleicao ::= SEQ { idEleicao INT, qtdEleitoresAptos INT, ..., resultadosVotacao SEQ }
//   TotalVotosCargo   ::= SEQ { [1] codigoCargo, ordemImpressao INT, votosVotaveis SEQ OF TotalVotosVotavel }
//   TotalVotosVotavel ::= SEQ { [1] tipoVoto, [2] quantidadeVotos, [3] identificacaoVotavel SEQ { partido, codigo }, assinatura }
function berLer(buf, ini = 0, fim = buf.length) {
  const nos = [];
  let p = ini;
  while (p < fim) {
    const tag = buf[p++];
    let len = buf[p++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
    }
    if (p + len > fim) throw new Error('BU binário truncado');
    const no = { tag, ini: p, fim: p + len };
    if (tag & 0x20) no.filhos = berLer(buf, p, p + len); // construído: tem filhos
    nos.push(no);
    p += len;
  }
  return nos;
}
const berInt = (buf, no) => { let v = 0; for (let i = no.ini; i < no.fim; i++) v = v * 256 + buf[i]; return v; };

// Código do cargo no BU = código do TSE (enum CargoConstitucional).
const CODIGO_CARGO = {
  PRESIDENTE: 1, GOVERNADOR: 3, SENADOR: 5, 'DEPUTADO FEDERAL': 6, 'DEPUTADO ESTADUAL': 7,
  'DEPUTADO DISTRITAL': 8, PREFEITO: 11, VEREADOR: 13,
};

// Mesmo contrato de votosNoBU: null se o cargo não está no boletim.
function buBinario(buf, cargo, numero) {
  const codCargo = CODIGO_CARGO[String(cargo).trim().toUpperCase()];
  // O arquivo é um envelope (EntidadeEnvelopeGenerico) com o BU dentro de um
  // OCTET STRING; o BU em si é decodificado em seguida.
  const env = berLer(buf)[0];
  const conteudo = (env?.filhos || []).find((n) => n.tag === 0x04);
  if (!conteudo) throw new Error('BU binário sem conteúdo');
  const raiz = berLer(buf, conteudo.ini, conteudo.fim)[0];

  let votos = null; let aptos = null;
  const andar = (no) => {
    const k = no.filhos;
    if (!k) return;
    // ResultadoVotacaoPorEleicao: idEleicao, aptos, ... e um SEQ que contém
    // ResultadoVotacao (que começa por ENUM tipoCargo).
    if (aptos === null && k.length >= 3 && k[0].tag === 0x02 && k[1].tag === 0x02
        && k.some((c) => c.tag === 0x30 && (c.filhos || []).some((d) => d.tag === 0x30 && d.filhos?.[0]?.tag === 0x0a))) {
      aptos = berInt(buf, k[1]);
    }
    // TotalVotosCargo
    if (k.length >= 3 && k[0].tag === 0x81 && k[1].tag === 0x02 && k[2].tag === 0x30 && berInt(buf, k[0]) === codCargo) {
      votos = votos || 0;
      for (const v of k[2].filhos || []) {
        const campo = (t) => (v.filhos || []).find((x) => x.tag === t);
        const tipo = campo(0x81); const qtd = campo(0x82); const id = campo(0xa3);
        // tipoVoto 1 = nominal. Legenda (4) usa o número do partido e não é
        // voto do candidato; branco/nulo não têm identificação.
        if (!tipo || berInt(buf, tipo) !== 1 || !qtd || !id || !id.filhos?.[1]) continue;
        if (String(berInt(buf, id.filhos[1])) === numero) votos += berInt(buf, qtd);
      }
      return;
    }
    k.forEach(andar);
  };
  andar(raiz);
  return votos === null ? null : { votos, aptos };
}

// Busca o BU de uma seção. null = ainda não divulgado; senão { votos, aptos }.
async function buscarSecao({ ciclo, pleito, uf, municipio, zona, secao, cargo, numero }) {
  const p6 = pad(pleito, 6);
  const pasta = `${BASE}/${ciclo}/arquivo-urna/${pleito}/dados/${uf}/${municipio}/${zona}/${secao}`;
  const aux = await baixar(`${pasta}/p${p6}-${uf}-m${municipio}-z${zona}-s${secao}-aux.json`, { semCache: true });
  if (!aux || !Array.isArray(aux.hashes) || !aux.hashes.length) return null;
  // Uma urna pode ter mais de um envio (reenvio, urna de contingência). Vale o
  // que o TSE totalizou; sem ele, o mais recente que não tenha sido excluído.
  const validos = aux.hashes.filter((h) => !/exclu|anulad|cancel/i.test(h.st || ''));
  const h = validos.find((x) => /totalizad/i.test(x.st || '')) || validos[validos.length - 1];
  if (!h) return null;
  const arquivo = (tp) => (h.arq || []).find((a) => a.tp === tp);

  // Primeiro o bu.dat, que o TSE publica assim que recebe a urna.
  const bin = arquivo('bu');
  if (bin) {
    const buf = await baixar(`${pasta}/${h.hash}/${bin.nm}`, { binario: true });
    if (buf) {
      const r = buBinario(buf, cargo, numero);
      if (r === null) {
        throw new Error(`O cargo "${cargo}" não aparece no boletim de urna. Confira o cargo na configuração.`);
      }
      return r;
    }
  }

  const arq = arquivo('imgbu');
  if (!arq) return null;  const texto = await baixar(`${pasta}/${h.hash}/${arq.nm}`, { texto: true });
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
//   -v.json → abr[].cand[] só com número, mas com os eleitores aptos
// ("seq" nos dois NÃO é a posição por votos — ver abaixo.)
// Presidente (2022) só tem o -v; os demais têm os dois. Tenta o -u primeiro
// pelo nome, e completa os aptos com o -v quando existir (o -v também traz
// comparecimento, que não é lido — ver totaisDoBU).
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

module.exports = { pad4, listarPleitos, configSecoes, buscarSecao, votosNoBU, buBinario, resultadoMunicipio, municipiosEleicao };
