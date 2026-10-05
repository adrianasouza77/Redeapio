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
// "cdi" é o código IBGE do mesmo município — é ele que casa com a malha do
// IBGE no mapa; o código TSE é outro número e não serve para isso.
async function municipiosEleicao(ciclo, eleicao, uf) {
  const j = await comCache(`cm:${ciclo}:${eleicao}`, 24, () => baixar(`${BASE}/${ciclo}/${eleicao}/config/mun-e${pad(eleicao, 6)}-cm.json`));
  if (!j) return [];
  const estado = (j.abr || []).find((a) => String(a.cd).toLowerCase() === uf);
  return (estado?.mu || []).map((m) => ({ codigo: m.cd, nome: m.nm, ibge: m.cdi || null, capital: m.c === 's' }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

// ─── Votos por seção: boletim completo, candidatos e locais de votação ──────

// Eleições de um turno, com o código de cada cargo. O mesmo turno (pleito)
// tem mais de uma "eleição" no TSE — em 2026, a 6257 é a de presidente e a
// 6259 a estadual (governador, senador, deputados) — e o resultado de cada
// cargo mora na pasta da sua eleição.
async function eleicoesDoPleito(ciclo, pleito) {
  const j = await comCache('ele-c', 1, () => baixar(`${BASE}/comum/config/ele-c.json`));
  const p = (j?.pl || []).find((x) => String(x.cd) === String(pleito) && (x.c || j.c) === ciclo);
  if (!p) return [];
  return (p.e || []).filter((e) => String(e.tp) !== '7').map((e) => {
    const cargos = new Map();
    for (const a of e.abr || []) for (const c of a.cp || []) cargos.set(Number(c.cd), String(c.ds).trim());
    return {
      codigo: String(e.cd), turno: Number(e.t), nome: String(e.nm || '').replace(/&#186;/g, 'º'),
      // tp 3 = municipal: o resultado e a lista de candidatos são por município.
      municipal: String(e.tp) === '3' || [...cargos.keys()].every((c) => c === 11 || c === 13),
      cargos: [...cargos].map(([cod, nome]) => ({ cod, nome })),
    };
  });
}

// O boletim inteiro de uma urna: todos os cargos, cada candidato, brancos,
// nulos e legenda. É um arquivo só por urna, com tudo dentro — por isso a
// varredura do estado baixa cada BU uma vez e depois serve qualquer candidato.
//   cargos: { <codCargo>: { v: {numero: votos}, l: {partido: votos}, b, n, vv } }
//   vv = votos válidos do cargo (nominais + legenda), base do "% da seção".
// Conferido no BU da seção 0036/zona 0039 de Glória de Dourados (04/10/2026):
// em todo cargo, nominais + legenda + brancos + nulos = comparecimento (e o
// dobro em senador, que em 2026 elege dois por estado).
function boletimCompleto(buf) {
  const env = berLer(buf)[0];
  const conteudo = (env?.filhos || []).find((n) => n.tag === 0x04);
  if (!conteudo) throw new Error('BU binário sem conteúdo');
  const raiz = berLer(buf, conteudo.ini, conteudo.fim)[0];
  const cargos = {};
  let aptos = null; let comparecimento = null;
  const andar = (no, ctx) => {
    const k = no.filhos;
    if (!k) return;
    // ResultadoVotacaoPorEleicao: idEleicao, qtdEleitoresAptos, ... (ver buBinario)
    if (k.length >= 3 && k[0].tag === 0x02 && k[1].tag === 0x02
        && k.some((c) => c.tag === 0x30 && (c.filhos || []).some((d) => d.tag === 0x30 && d.filhos?.[0]?.tag === 0x0a))) {
      ctx = { ...ctx, aptos: berInt(buf, k[1]) };
      if (aptos === null) aptos = ctx.aptos;
    }
    // ResultadoVotacao ::= SEQ { tipoCargo ENUM, qtdComparecimento INT, totaisVotosCargo SEQ }
    if (k.length >= 3 && k[0].tag === 0x0a && k[1].tag === 0x02 && k[2].tag === 0x30) {
      ctx = { ...ctx, comp: berInt(buf, k[1]) };
      if (comparecimento === null) comparecimento = ctx.comp;
    }
    // TotalVotosCargo
    if (k.length >= 3 && k[0].tag === 0x81 && k[1].tag === 0x02 && k[2].tag === 0x30) {
      const r = { v: {}, l: {}, b: 0, n: 0, vv: 0 };
      for (const v of k[2].filhos || []) {
        const campo = (t) => (v.filhos || []).find((x) => x.tag === t);
        const tipo = campo(0x81); const qtd = campo(0x82); const id = campo(0xa3);
        if (!tipo || !qtd) continue;
        const q = berInt(buf, qtd);
        // tipoVoto: 1 nominal, 2 branco, 3 nulo, 4 legenda (voto só no partido).
        switch (berInt(buf, tipo)) {
          case 1: if (id?.filhos?.[1]) { r.v[berInt(buf, id.filhos[1])] = q; r.vv += q; } break;
          case 2: r.b += q; break;
          case 3: r.n += q; break;
          case 4: if (id?.filhos?.[1]) { r.l[berInt(buf, id.filhos[1])] = q; r.vv += q; } break;
          default: r.n += q; // "cargo sem candidato" e afins não são voto válido
        }
      }
      cargos[berInt(buf, k[0])] = r;
      return;
    }
    k.forEach((x) => andar(x, ctx));
  };
  andar(raiz, {});
  return { aptos, comparecimento, cargos };
}

// Boletim completo de uma urna. null = ainda não divulgado.
async function buscarBoletim({ ciclo, pleito, uf, municipio, zona, secao }) {
  const p6 = pad(pleito, 6);
  const pasta = `${BASE}/${ciclo}/arquivo-urna/${pleito}/dados/${uf}/${municipio}/${zona}/${secao}`;
  const aux = await baixar(`${pasta}/p${p6}-${uf}-m${municipio}-z${zona}-s${secao}-aux.json`, { semCache: true });
  if (!aux || !Array.isArray(aux.hashes) || !aux.hashes.length) return null;
  // Mesma escolha de envio de buscarSecao().
  const validos = aux.hashes.filter((h) => !/exclu|anulad|cancel/i.test(h.st || ''));
  const h = validos.find((x) => /totalizad/i.test(x.st || '')) || validos[validos.length - 1];
  const bin = h && (h.arq || []).find((a) => a.tp === 'bu');
  if (!bin) return null;
  const buf = await baixar(`${pasta}/${h.hash}/${bin.nm}`, { binario: true });
  return buf ? boletimCompleto(buf) : null;
}

// Candidatos de um cargo, com nome de urna, partido, votos e situação. Vem do
// resultado consolidado (-u.json), que o TSE publica mesmo com zero voto: é a
// lista oficial de quem estava na urna. Cargo estadual: o arquivo é da UF;
// prefeito/vereador: do município (o mesmo número existe em toda cidade).
async function candidatosCargo({ ciclo, eleicao, uf, municipio, cargo }) {
  const local = municipio ? `${uf}${municipio}` : uf;
  const url = `${BASE}/${ciclo}/${eleicao}/dados/${uf}/${local}-c${pad(cargo, 4)}-e${pad(eleicao, 6)}-u.json`;
  // 5 minutos: no dia seguinte à eleição o arquivo ainda muda (recontagem,
  // candidato com registro julgado depois).
  const j = await comCache(`cand:${url}`, 1 / 12, () => baixar(url));
  if (!j || !Array.isArray(j.carg)) return null;
  const candidatos = [];
  for (const c of j.carg) {
    for (const agr of c.agr || []) {
      for (const par of agr.par || []) {
        for (const cand of par.cand || []) {
          candidatos.push({
            numero: String(cand.n), nome: cand.nmu || cand.nm, nomeCompleto: cand.nm || null,
            partido: par.sg || null, sq: cand.sqcand || null,
            votos: Number(cand.vap) || 0, pct: cand.pvap || null,
            situacao: cand.st || null, eleito: /^s$/i.test(cand.e || ''),
            // "Válido", "Anulado", "Anulado sub judice"... — o que não é válido
            // não entra no total, mas o eleitor pode ter digitado o número.
            valido: !/anulad|cassad|indefer/i.test(cand.dvt || ''),
            // "Anulado sub judice" ainda pode voltar a valer: o TSE não o conta
            // nem como válido nem como nulo (fica em "vansj").
            subJudice: /sub\s*judice/i.test(cand.dvt || ''),
          });
        }
      }
    }
  }
  candidatos.sort((a, b) => b.votos - a.votos || a.nome.localeCompare(b.nome, 'pt-BR'));
  candidatos.forEach((c, i) => { c.posicao = i > 0 && c.votos === candidatos[i - 1].votos ? candidatos[i - 1].posicao : i + 1; });
  const s = j.s || {};
  return {
    candidatos,
    vagas: Number(j.carg[0]?.nv) || null,
    secoesTotalizadas: Number(s.st) || 0, secoesTotal: Number(s.ts) || 0, pctTotalizado: s.pst || null,
    final: j.tf === 's',
    atualizadoEm: j.dg && j.hg ? `${j.dg} ${j.hg}` : null,
  };
}

function fotoUrl(ciclo, eleicao, uf, sq) {
  return sq ? `${BASE}/${ciclo}/${eleicao}/fotos/${uf}/${sq}.jpeg` : null;
}

// ─── Locais de votação (dados abertos do TSE) ───────────────────────────────
// "Eleitorado por local de votação": uma linha por seção com escola,
// endereço, BAIRRO e LATITUDE/LONGITUDE — é o que permite agrupar votos por
// bairro e pôr cada escola no mapa. Vem num ZIP nacional de ~90 MB com um CSV
// por UF dentro; em vez de baixar o ZIP inteiro, lemos o índice no fim do
// arquivo e buscamos só os bytes do CSV do estado (a CDN aceita Range). O de
// MS são ~500 KB em vez de 90 MB.
const zlib = require('zlib');

async function baixarFaixa(url, ini, fim) {
  const resp = await fetch(url, { headers: { Range: `bytes=${ini}-${fim}` }, signal: AbortSignal.timeout(120000) });
  if (resp.status === 404 || resp.status === 403) return null;
  if (resp.status !== 206 && !resp.ok) throw new Error(`TSE respondeu ${resp.status} em ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const total = Number(String(resp.headers.get('content-range') || '').split('/')[1]) || null;
  // Servidor que ignora Range devolve o arquivo inteiro com 200: recorta aqui.
  return { buf: resp.status === 206 ? buf : buf.subarray(ini, fim + 1), total: total || (resp.status === 200 ? buf.length : null) };
}

async function lerEntradaZip(url, testeNome) {
  const fimArq = await baixarFaixa(url, 0, 0);
  if (!fimArq || !fimArq.total) return null;
  const tam = fimArq.total;
  // EOCD: assinatura 0x06054b50 nos últimos 64 KB (22 bytes + comentário).
  const cauda = await baixarFaixa(url, Math.max(0, tam - 65557), tam - 1);
  const t = cauda.buf;
  let e = -1;
  for (let i = t.length - 22; i >= 0; i--) if (t.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('ZIP do TSE sem índice');
  const cdTam = t.readUInt32LE(e + 12); const cdIni = t.readUInt32LE(e + 16);
  const cd = (await baixarFaixa(url, cdIni, cdIni + cdTam - 1)).buf;
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
    const metodo = cd.readUInt16LE(p + 10);
    const comp = cd.readUInt32LE(p + 20);
    const nl = cd.readUInt16LE(p + 28); const xl = cd.readUInt16LE(p + 30); const cl = cd.readUInt16LE(p + 32);
    const loc = cd.readUInt32LE(p + 42);
    const nome = cd.toString('latin1', p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    if (!testeNome(nome)) continue;
    // O cabeçalho local tem nome/extra próprios (podem diferir do índice).
    const cab = (await baixarFaixa(url, loc, loc + 29)).buf;
    const ini = loc + 30 + cab.readUInt16LE(26) + cab.readUInt16LE(28);
    const dados = (await baixarFaixa(url, ini, ini + comp - 1)).buf;
    if (metodo === 0) return dados;
    if (metodo === 8) return zlib.inflateRawSync(dados);
    throw new Error(`ZIP do TSE com compressão não suportada (${metodo})`);
  }
  return null;
}

// Uma linha do CSV do TSE: campos entre aspas separados por ";", números sem
// aspas. Não há ";" dentro dos campos nesse arquivo, mas há aspas no meio de
// nome de escola ("ESCOLA "PROF. X"") — por isso o corte é por ";" e só as
// aspas das pontas saem.
function camposCsv(linha) {
  return linha.split(';').map((c) => c.replace(/^"|"$/g, ''));
}

async function locaisVotacao(ano, uf) {
  const url = `https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_${ano}.zip`;
  const alvo = `_${ano}_${uf.toUpperCase()}.csv`;
  const buf = await lerEntradaZip(url, (n) => n.toUpperCase().endsWith(alvo.toUpperCase()));
  if (!buf) return null;
  const linhas = new TextDecoder('latin1').decode(buf).split(/\r?\n/);
  const cab = camposCsv(linhas[0]);
  const col = (n) => cab.indexOf(n);
  const c = {
    turno: col('NR_TURNO'), mun: col('CD_MUNICIPIO'), munNome: col('NM_MUNICIPIO'), zona: col('NR_ZONA'), secao: col('NR_SECAO'),
    principal: col('NR_SECAO_PRINCIPAL'), local: col('NR_LOCAL_VOTACAO'), localNome: col('NM_LOCAL_VOTACAO'),
    end: col('DS_ENDERECO'), bairro: col('NM_BAIRRO'), cep: col('NR_CEP'), lat: col('NR_LATITUDE'), lng: col('NR_LONGITUDE'),
    eleitores: col('QT_ELEITOR_SECAO'),
  };
  if (c.zona < 0 || c.secao < 0 || c.bairro < 0) throw new Error('O CSV de locais de votação do TSE mudou de formato.');
  const num = (v) => { const x = Number(String(v || '').replace(',', '.')); return Number.isFinite(x) && x !== -1 ? x : null; };
  const vistos = new Set();
  const out = [];
  for (let i = 1; i < linhas.length; i++) {
    if (!linhas[i]) continue;
    const f = camposCsv(linhas[i]);
    const zona = pad4(f[c.zona]); const secao = pad4(f[c.secao]);
    if (!zona || !secao) continue;
    // O arquivo repete a seção no 2º turno; o local é o mesmo, fica o 1º.
    const chave = `${zona}|${secao}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const principal = num(f[c.principal]);
    const lat = num(f[c.lat]); const lng = num(f[c.lng]);
    out.push({
      municipio: String(f[c.mun]).padStart(5, '0'), municipioNome: f[c.munNome] || null, zona, secao,
      principal: principal && principal > 0 ? pad4(principal) : secao,
      local: f[c.local] || null, localNome: f[c.localNome] || null, endereco: f[c.end] || null,
      bairro: (f[c.bairro] || '').trim() || null, cep: f[c.cep] || null,
      // Coordenada zerada ou fora do Brasil é "sem coordenada", não um ponto no oceano.
      lat: lat && lat < 6 && lat > -34 ? lat : null, lng: lng && lng < -28 && lng > -74 ? lng : null,
      eleitores: num(f[c.eleitores]),
    });
  }
  return out;
}

module.exports = {
  pad4, listarPleitos, configSecoes, buscarSecao, votosNoBU, buBinario, resultadoMunicipio, municipiosEleicao,
  eleicoesDoPleito, boletimCompleto, buscarBoletim, candidatosCargo, fotoUrl, locaisVotacao, CODIGO_CARGO,
};
