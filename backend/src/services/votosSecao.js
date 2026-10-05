const pool = require('../db');
const tse = require('./tse');
const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');

// Votos por seção — o estado inteiro, qualquer candidato.
//
// A apuração ao vivo (services/apuracao.js) acompanha UM número, só nas zonas
// onde a rede tem gente, e guarda só os votos dele. Aqui é o contrário: o
// boletim de urna de cada urna do estado é baixado uma vez, com TODOS os cargos
// e candidatos, e a partir daí qualquer candidato se consulta na hora — o da
// campanha, um aliado de dobradinha, um adversário. O cruzamento com a rede
// (quantos cadastrados votam em cada seção) é feito na consulta, por campanha.
//
// O voto é secreto: o dado do TSE é o total da urna. Nada aqui diz em quem uma
// pessoa votou — a tela avisa isso ("indica a área de influência").

const PARALELO = 10;      // pedidos simultâneos ao TSE (cada urna = 2: aux.json + bu.dat)
const LOTE = 400;         // urnas por volta; entre voltas o laço respira e grava o andamento
const REPESCAR_MS = 3 * 60 * 1000; // urna sem BU publicado só é tentada de novo depois disso

const anoDoCiclo = (ciclo) => Number(String(ciclo).replace(/\D/g, '')) || null;

// ─── Locais de votação ──────────────────────────────────────────────────────
// Carregados uma vez por ano/UF. O TSE só publica o arquivo do ano depois de
// fechado o cadastro eleitoral; sem ele a tela funciona, só sem bairro/mapa.
const carregandoLocais = new Map();
// Ano/UF que o TSE não tem: não tenta baixar de novo a cada formulário aberto.
const semArquivoLocais = new Map();
async function garantirLocais(ano, uf) {
  if (semArquivoLocais.get(`${ano}|${uf}`) > Date.now() - 6 * 3600e3) return 0;
  const { rows } = await pool.query('SELECT linhas FROM tse_locais_carga WHERE ano = $1 AND uf = $2', [ano, uf]);
  if (rows.length) return rows[0].linhas;
  const chave = `${ano}|${uf}`;
  if (!carregandoLocais.has(chave)) {
    carregandoLocais.set(chave, (async () => {
      const locais = await tse.locaisVotacao(ano, uf);
      if (!locais || !locais.length) { semArquivoLocais.set(`${ano}|${uf}`, Date.now()); return 0; }
      // Em blocos: uma única instrução com 100 mil linhas (SP) estoura o
      // limite de parâmetros do Postgres (65 535).
      for (let i = 0; i < locais.length; i += 1000) {
        const bloco = locais.slice(i, i + 1000);
        const col = (f) => bloco.map(f);
        await pool.query(
          `INSERT INTO tse_locais (ano, uf, zona, secao, principal, municipio, local_numero, local_nome, endereco, bairro, cep, lat, lng, eleitores)
           SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::float8[], $13::float8[], $14::int[])
           ON CONFLICT (ano, uf, zona, secao) DO UPDATE SET principal = EXCLUDED.principal, municipio = EXCLUDED.municipio,
             local_numero = EXCLUDED.local_numero, local_nome = EXCLUDED.local_nome, endereco = EXCLUDED.endereco,
             bairro = EXCLUDED.bairro, cep = EXCLUDED.cep, lat = EXCLUDED.lat, lng = EXCLUDED.lng, eleitores = EXCLUDED.eleitores`,
          [ano, uf, col((l) => l.zona), col((l) => l.secao), col((l) => l.principal), col((l) => l.municipio),
            col((l) => l.local), col((l) => l.localNome), col((l) => l.endereco), col((l) => l.bairro), col((l) => l.cep),
            col((l) => l.lat), col((l) => l.lng), col((l) => l.eleitores)]
        );
      }
      await pool.query(
        `INSERT INTO tse_locais_carga (ano, uf, linhas) VALUES ($1,$2,$3)
         ON CONFLICT (ano, uf) DO UPDATE SET linhas = EXCLUDED.linhas, importado_em = now()`,
        [ano, uf, locais.length]
      );
      return locais.length;
    })().finally(() => carregandoLocais.delete(chave)));
  }
  return carregandoLocais.get(chave);
}

// Ano cujo cadastro de locais vale para uma eleição. O do próprio ano, quando
// o TSE tem; senão o mais próximo (escola e seção mudam pouco entre uma
// eleição e outra). Em out/2026 o arquivo de 2024 não estava mais no endereço
// de sempre, e uma campanha de vereador de 2024 ficava sem bairro e sem escola.
async function anoLocais(ano, uf) {
  for (const a of [ano, ano + 2, ano - 2, ano + 4]) {
    const n = await garantirLocais(a, uf).catch(() => 0);
    if (n) return a;
  }
  return null;
}

// ─── Varredura do estado ────────────────────────────────────────────────────

// Todas as urnas (seções principais) do estado, pela lista oficial do TSE.
async function urnasDoEstado(ciclo, pleito, uf) {
  const mapa = await tse.configSecoes(ciclo, pleito, uf);
  if (!mapa) return null;
  const urnas = new Map();
  for (const loc of mapa.secoes.values()) {
    const k = `${loc.zona}|${loc.principal}`;
    if (!urnas.has(k)) urnas.set(k, { municipio: loc.municipio, zona: loc.zona, secao: loc.principal });
  }
  return { urnas, mapa };
}

async function statusColeta(ciclo, pleito, uf) {
  const { rows } = await pool.query('SELECT * FROM tse_coletas WHERE ciclo = $1 AND pleito = $2 AND uf = $3', [ciclo, pleito, uf]);
  const c = rows[0];
  if (!c) {
    // Ainda não coletado: diz quantas urnas são, para a tela estimar o tempo.
    const u = await urnasDoEstado(ciclo, pleito, uf).catch(() => null);
    return { status: 'nunca', total: u ? u.urnas.size : null, coletadas: 0 };
  }
  return {
    status: c.status, total: c.total, coletadas: c.coletadas, semBu: c.sem_bu, erro: c.erro, municipios: c.municipios,
    iniciadoEm: c.iniciado_em, atualizadoEm: c.atualizado_em, concluidoEm: c.concluido_em,
  };
}

// municipios: lista de códigos TSE para baixar só eles (importação do
// candidato); sem lista, o estado inteiro. Se outra importação do mesmo
// estado ainda está em andamento com outros municípios, os dois se somam;
// fora isso vale o pedido de agora — nunca vira "estado inteiro" sem alguém
// ter pedido o estado inteiro.
async function iniciarColeta({ ciclo, pleito, uf, usuarioId, refazer = false, municipios = null }) {
  const u = await urnasDoEstado(ciclo, pleito, uf);
  if (!u) throw new Error('O TSE ainda não publicou a lista de seções desta eleição para este estado.');
  const { rows: atual } = await pool.query('SELECT municipios, status FROM tse_coletas WHERE ciclo = $1 AND pleito = $2 AND uf = $3', [ciclo, pleito, uf]);
  let escopo = municipios && municipios.length ? [...new Set(municipios)].sort() : null;
  if (escopo && atual[0] && atual[0].status === 'coletando' && atual[0].municipios) {
    escopo = [...new Set([...atual[0].municipios, ...escopo])].sort();
  }
  const total = escopo ? [...u.urnas.values()].filter((x) => escopo.includes(x.municipio)).length : u.urnas.size;
  await pool.query(
    `INSERT INTO tse_coletas (ciclo, pleito, uf, status, total, iniciado_por, refazer_desde, municipios)
     VALUES ($1,$2,$3,'coletando',$4,$5, CASE WHEN $6 THEN now() END, $7)
     ON CONFLICT (ciclo, pleito, uf) DO UPDATE SET status = 'coletando', total = EXCLUDED.total, erro = NULL,
       iniciado_por = EXCLUDED.iniciado_por, iniciado_em = now(), atualizado_em = now(), concluido_em = NULL,
       refazer_desde = CASE WHEN $6 THEN now() ELSE tse_coletas.refazer_desde END, municipios = EXCLUDED.municipios`,
    [ciclo, pleito, uf, total, usuarioId || null, !!refazer, escopo]
  );
  semBu.delete(`${ciclo}|${pleito}|${uf}`);
  acordar();
  return statusColeta(ciclo, pleito, uf);
}

// Urnas tentadas sem BU publicado, por coleta: "zona|secao" → quando.
const semBu = new Map();

async function umaVolta(col) {
  const chave = `${col.ciclo}|${col.pleito}|${col.uf}`;
  const ano = anoDoCiclo(col.ciclo);
  // Locais primeiro (meio segundo para MS). Falha aqui não para os votos.
  if (ano) await anoLocais(ano, col.uf).catch((e) => console.error('[votos] locais', col.uf, e.message));

  const u = await urnasDoEstado(col.ciclo, col.pleito, col.uf);
  if (!u) throw new Error('Lista de seções do TSE indisponível.');
  // Carga só de alguns municípios: as outras urnas do estado nem entram.
  if (col.municipios) {
    const so = new Set(col.municipios);
    u.urnas = new Map([...u.urnas].filter(([, x]) => so.has(x.municipio)));
  }
  const { rows } = await pool.query(
    `SELECT zona, secao FROM tse_urnas WHERE ciclo = $1 AND pleito = $2 AND uf = $3
       AND coletado_em >= COALESCE($4::timestamptz, '-infinity')`,
    [col.ciclo, col.pleito, col.uf, col.refazer_desde]
  );
  const prontas = new Set(rows.map((r) => `${r.zona}|${r.secao}`).filter((k) => u.urnas.has(k)));
  if (!semBu.has(chave)) semBu.set(chave, new Map());
  const tentadas = semBu.get(chave);
  const agora = Date.now();
  const pendentes = [...u.urnas.entries()].filter(([k]) => !prontas.has(k));
  const lote = pendentes.filter(([k]) => !(tentadas.get(k) > agora - REPESCAR_MS)).slice(0, LOTE);

  let novas = 0; let erros = 0; let ultimoErro = null;
  let i = 0;
  const trabalhador = async () => {
    while (i < lote.length) {
      const [k, urna] = lote[i++];
      try {
        const bu = await tse.buscarBoletim({ ciclo: col.ciclo, pleito: col.pleito, uf: col.uf, ...urna });
        if (!bu) { tentadas.set(k, Date.now()); continue; }
        await pool.query(
          `INSERT INTO tse_urnas (ciclo, pleito, uf, zona, secao, municipio, aptos, comparecimento, cargos)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (ciclo, pleito, uf, zona, secao) DO UPDATE SET municipio = EXCLUDED.municipio, aptos = EXCLUDED.aptos,
             comparecimento = EXCLUDED.comparecimento, cargos = EXCLUDED.cargos, coletado_em = now()`,
          [col.ciclo, col.pleito, col.uf, urna.zona, urna.secao, urna.municipio, bu.aptos, bu.comparecimento, JSON.stringify(bu.cargos)]
        );
        tentadas.delete(k);
        novas++;
      } catch (e) {
        erros++; ultimoErro = e.message;
        tentadas.set(k, Date.now());
      }
    }
  };
  await Promise.all(Array.from({ length: PARALELO }, trabalhador));

  const coletadas = prontas.size + novas;
  const faltam = u.urnas.size - coletadas;
  // Sem BU = já tentadas e o TSE ainda não tinha o boletim (não é o mesmo que
  // "faltam": no meio da varredura a maioria só não foi tentada ainda).
  const semBuQtd = [...tentadas.keys()].filter((k) => !prontas.has(k)).length;
  // Lote inteiro falhando = TSE fora do ar ou formato mudou: para e mostra o
  // erro, em vez de martelar o servidor do TSE para sempre.
  if (lote.length && erros === lote.length) {
    await pool.query(
      `UPDATE tse_coletas SET status = 'erro', erro = $4, coletadas = $5, atualizado_em = now()
        WHERE ciclo = $1 AND pleito = $2 AND uf = $3`,
      [col.ciclo, col.pleito, col.uf, ultimoErro, coletadas]
    );
    return false;
  }
  // Acabou quando não sobrou nada, ou quando o que sobrou é só urna sem BU
  // (urna não instalada, seção anulada): essas ficam contadas em sem_bu e o
  // botão "atualizar" tenta de novo depois.
  const concluida = faltam === 0 || (lote.length === 0 && pendentes.every(([k]) => tentadas.has(k)));
  await pool.query(
    `UPDATE tse_coletas SET coletadas = $4, sem_bu = $5, total = $6, atualizado_em = now(),
       status = CASE WHEN $7 THEN 'concluida' ELSE status END,
       concluido_em = CASE WHEN $7 THEN now() ELSE concluido_em END
     WHERE ciclo = $1 AND pleito = $2 AND uf = $3`,
    [col.ciclo, col.pleito, col.uf, coletadas, semBuQtd, u.urnas.size, concluida]
  );
  if (concluida) semBu.delete(chave);
  // Sobrou só urna esperando repescagem: dá um tempo antes da próxima volta.
  return lote.length > 0;
}

// Laço único para todas as coletas. Roda enquanto houver estado "coletando";
// dorme quando não há. Sobrevive a reinício: no boot, retoma o que ficou.
let laco = null;
function acordar() {
  if (laco) return;
  laco = (async () => {
    try {
      for (;;) {
        const { rows } = await pool.query(`SELECT * FROM tse_coletas WHERE status = 'coletando' ORDER BY iniciado_em`);
        if (!rows.length) break;
        let trabalhou = false;
        for (const col of rows) {
          try { if (await umaVolta(col)) trabalhou = true; } catch (e) {
            console.error('[votos]', col.uf, e.message);
            await pool.query(
              `UPDATE tse_coletas SET status = 'erro', erro = $4, atualizado_em = now() WHERE ciclo = $1 AND pleito = $2 AND uf = $3`,
              [col.ciclo, col.pleito, col.uf, e.message]
            );
          }
        }
        await new Promise((r) => setTimeout(r, trabalhou ? 300 : 30000));
      }
    } catch (e) {
      console.error('[votos] laço', e.message);
    } finally {
      laco = null;
    }
  })();
}

// ─── Consulta: um candidato no estado inteiro ───────────────────────────────

// Cadastrados da rede por urna ("zona|seção principal"). zona+seção basta para
// achar a urna dentro do estado — zona eleitoral não se repete na mesma UF.
async function redePorUrna(candidatoId, mapa, uf) {
  const vazio = { porUrna: new Map(), total: 0, comSecao: 0, foraDaUf: 0, semSecao: 0 };
  if (!candidatoId) return vazio;
  const { rows } = await pool.query(
    `SELECT id, nome, nivel, zona, secao, estado FROM (${SQL_ARVORE_CANDIDATO}) r`, [candidatoId]
  );
  const r = { ...vazio, porUrna: new Map(), total: rows.length };
  for (const a of rows) {
    const est = String(a.estado || '').trim().toLowerCase();
    if (est && est !== uf) { r.foraDaUf++; continue; }
    const z = tse.pad4(a.zona); const s = tse.pad4(a.secao);
    if (!z || !s) { r.semSecao++; continue; }
    const loc = mapa?.secoes.get(`${z}|${s}`);
    if (mapa && !loc) { r.semSecao++; continue; }
    const k = `${z}|${loc ? loc.principal : s}`;
    if (!r.porUrna.has(k)) r.porUrna.set(k, { cadastrados: 0, liderancas: [] });
    const item = r.porUrna.get(k);
    item.cadastrados++;
    // Líder, Coordenador e Mobilizador que votam ali: é quem responde pela seção.
    if (a.nivel >= 1 && a.nivel <= 3 && item.liderancas.length < 6) item.liderancas.push(a.nome);
    r.comSecao++;
  }
  return r;
}

const SOMAR = ['votos', 'vv', 'bn', 'tot', 'aptos', 'urnas', 'comVoto', 'rede', 'votosRede', 'primeiro'];
function acumular(alvo, s) {
  for (const k of SOMAR) alvo[k] = (alvo[k] || 0) + (s[k] || 0);
}

// Seções a devolver por inteiro numa resposta. Acima disso (capital grande,
// estado grande) a tela pede as seções de uma cidade por vez.
const MAX_SECOES = 12000;

// Um minuto de memória por consulta: ir e voltar entre candidatos (ou várias
// pessoas da campanha olhando o mesmo) não refaz a soma de milhares de urnas.
// Curto de propósito — durante a carga do estado os números mudam.
// A chave inclui o andamento da carga do estado: sem isso, um resultado
// parcial (calculado no meio da carga) era servido como final no minuto
// seguinte — no teste do AC, 17.806 votos em vez dos 18.149 oficiais.
const cacheResultado = new Map();
async function resultadoCandidato(p) {
  const { rows } = await pool.query(
    'SELECT coletadas, atualizado_em FROM tse_coletas WHERE ciclo = $1 AND pleito = $2 AND uf = $3', [p.ciclo, p.pleito, p.uf]
  );
  const andamento = rows[0] ? `${rows[0].coletadas}|${rows[0].atualizado_em.toISOString()}` : '';
  const chave = JSON.stringify(p) + andamento;
  const c = cacheResultado.get(chave);
  if (c && c.expira > Date.now()) return c.valor;
  const valor = await calcularResultado(p);
  if (cacheResultado.size > 40) cacheResultado.delete(cacheResultado.keys().next().value);
  cacheResultado.set(chave, { valor, expira: Date.now() + 60 * 1000 });
  return valor;
}

async function calcularResultado({ ciclo, pleito, eleicao, uf, cargo, numero, municipio, candidatoId, secoesDoMunicipio }) {
  const cod = String(cargo);
  const ano = (await anoLocais(anoDoCiclo(ciclo), uf)) || anoDoCiclo(ciclo);
  const cand = await tse.candidatosCargo({ ciclo, eleicao, uf, municipio, cargo }).catch(() => null);
  // Na urna, todo número digitado que existia na tela é voto nominal. O TSE
  // depois separa: voto em candidato anulado — ou com registro negado antes da
  // eleição, que nem aparece na lista — vira nulo ("nulo técnico"); anulado
  // sub judice fica à parte (nem válido, nem nulo) até a Justiça decidir.
  // Aqui: válido é só o número que está na lista oficial como válido; o resto
  // vai para nulos, e o sub judice sai dos dois. Conferido em MS e AC, 5
  // cargos: válidos e brancos+nulos iguais aos do TSE. Sem a lista (TSE fora
  // do ar), fica o BU cru (null = sem ajuste).
  const lista = cand?.candidatos || null;
  const validos = lista && lista.filter((c) => c.valido).map((c) => c.numero);
  const subJudice = lista ? lista.filter((c) => c.subJudice).map((c) => c.numero) : [];
  const [u, municipios, rows] = await Promise.all([
    urnasDoEstado(ciclo, pleito, uf).catch(() => null),
    tse.municipiosEleicao(ciclo, eleicao, uf).catch(() => []),
    pool.query(
      // O LATERAL tira o cargo do JSON uma vez por urna: com u.cargos->$4
      // repetido em cada coluna, o Postgres descompactava o boletim inteiro
      // seis vezes por linha. O OFFSET 0 impede o planejador de "achatar" o
      // LATERAL de volta nas colunas (o que desfaria o ganho).
      `SELECT u.municipio, u.zona, u.secao, u.aptos,
              x.votos,
              COALESCE((c.j->>'vv')::int, 0) - a.anul - a.sj AS vv,
              COALESCE((c.j->>'b')::int, 0) + COALESCE((c.j->>'n')::int, 0) + a.anul AS bn,
              (c.j IS NOT NULL) AS tem_cargo,
              -- Posição do candidato na urna: quantos tiveram mais votos que ele, +1.
              -- jsonb_path em vez de jsonb_each_text: mesmo resultado (conferido
              -- nas 7.106 urnas de MS), 2,4x mais rápido.
              COALESCE(jsonb_array_length(jsonb_path_query_array(c.j->'v', '$.* ? (@ > $x)', jsonb_build_object('x', x.votos))), 0) + 1 AS posicao,
              l.local_numero, l.local_nome, l.endereco, l.bairro, l.lat, l.lng
         FROM tse_urnas u
         CROSS JOIN LATERAL (SELECT u.cargos->$4 AS j OFFSET 0) c
         CROSS JOIN LATERAL (SELECT COALESCE((c.j->'v'->>$5)::int, 0) AS votos) x
         -- "jsonb - text[]" tira da urna os números válidos e os sub judice; o
         -- que sobra (zero a dois números, quase sempre) é o nulo técnico.
         CROSS JOIN LATERAL (SELECT
             CASE WHEN $8::text[] IS NULL THEN 0 ELSE COALESCE((SELECT sum(x::int) FROM jsonb_array_elements_text(
               jsonb_path_query_array((c.j->'v') - $8::text[] - $9::text[], '$.*')) x), 0)::int END AS anul,
             COALESCE((SELECT sum((c.j->'v'->>k)::int) FROM unnest($9::text[]) k), 0)::int AS sj) a
         LEFT JOIN tse_locais l ON l.ano = $6 AND l.uf = u.uf AND l.zona = u.zona AND l.secao = u.secao
        WHERE u.ciclo = $1 AND u.pleito = $2 AND u.uf = $3 AND ($7::text IS NULL OR u.municipio = $7)`,
      [ciclo, pleito, uf, cod, String(numero), ano, municipio || null, validos, subJudice]
    ).then((r) => r.rows),
  ]);
  const rede = await redePorUrna(candidatoId, u?.mapa, uf);
  const munInfo = new Map(municipios.map((m) => [m.codigo, m]));
  const candidato = cand?.candidatos.find((c) => c.numero === String(numero)) || null;

  const porMun = new Map(); const porLocal = new Map(); const porBairro = new Map();
  const secoes = [];
  const total = {};
  let comCargo = 0;
  for (const r of rows) {
    if (!r.tem_cargo) continue; // urna de outro município numa eleição municipal, ou cargo que não houve ali
    comCargo++;
    const k = `${r.zona}|${r.secao}`;
    const rd = rede.porUrna.get(k);
    const tot = r.vv + r.bn;
    const s = {
      votos: r.votos, vv: r.vv, bn: r.bn, tot, aptos: r.aptos || 0, urnas: 1, comVoto: r.votos > 0 ? 1 : 0,
      rede: rd ? rd.cadastrados : 0, votosRede: rd ? r.votos : 0, primeiro: r.votos > 0 && Number(r.posicao) === 1 ? 1 : 0,
    };
    acumular(total, s);

    if (!porMun.has(r.municipio)) {
      const mi = munInfo.get(r.municipio);
      porMun.set(r.municipio, { codigo: r.municipio, nome: mi?.nome || r.municipio, ibge: mi?.ibge || null, bairros: new Set(), _lat: 0, _lng: 0, _n: 0 });
    }
    const m = porMun.get(r.municipio);
    acumular(m, s);
    if (r.lat != null) { m._lat += r.lat; m._lng += r.lng; m._n++; }

    const bairro = r.bairro || 'Bairro não informado';
    m.bairros.add(bairro);
    const kb = `${r.municipio}|${bairro}`;
    if (!porBairro.has(kb)) porBairro.set(kb, { municipio: r.municipio, bairro, locais: new Set() });
    const b = porBairro.get(kb);
    acumular(b, s);

    const kl = `${r.municipio}|${r.local_numero || r.zona}`;
    if (!porLocal.has(kl)) {
      porLocal.set(kl, {
        id: kl, municipio: r.municipio, nome: r.local_nome || `Zona ${r.zona}`, endereco: r.endereco, bairro,
        lat: r.lat, lng: r.lng, liderancas: new Set(),
      });
    }
    const l = porLocal.get(kl);
    acumular(l, s);
    b.locais.add(kl);
    if (rd) rd.liderancas.forEach((n) => l.liderancas.add(n));

    secoes.push({
      municipio: r.municipio, zona: r.zona, secao: r.secao, local: kl, bairro,
      votos: r.votos, vv: r.vv, bn: r.bn, tot, aptos: r.aptos, posicao: r.votos > 0 ? Number(r.posicao) : null,
      rede: s.rede, liderancas: rd ? rd.liderancas : [],
    });
  }

  const municipiosOut = [...porMun.values()].map(({ _lat, _lng, _n, bairros, ...m }) => ({
    ...m, bairros: bairros.size, lat: _n ? _lat / _n : null, lng: _n ? _lng / _n : null,
  })).sort((a, b) => b.votos - a.votos);
  const locaisOut = [...porLocal.values()].map((l) => ({ ...l, liderancas: [...l.liderancas] })).sort((a, b) => b.votos - a.votos);
  const bairrosOut = [...porBairro.values()].map((b) => ({ ...b, locais: b.locais.size })).sort((a, b) => b.votos - a.votos);

  // Seções: tudo, se couber; senão as da rede + as mais votadas, e a tela
  // pede a cidade inteira quando a pessoa entra nela.
  secoes.sort((a, b) => b.votos - a.votos);
  let secoesOut = secoes; let secoesParciais = false;
  if (secoesDoMunicipio) secoesOut = secoes.filter((s) => s.municipio === secoesDoMunicipio);
  else if (secoes.length > MAX_SECOES) {
    secoesParciais = true;
    const daRede = secoes.filter((s) => s.rede > 0);
    const resto = secoes.filter((s) => !s.rede).slice(0, Math.max(0, MAX_SECOES - daRede.length));
    secoesOut = [...daRede, ...resto];
  }

  return {
    candidato: candidato && {
      ...candidato, foto: tse.fotoUrl(ciclo, eleicao, uf, candidato.sq),
    },
    cargo: { totalizacao: cand && { secoesTotalizadas: cand.secoesTotalizadas, secoesTotal: cand.secoesTotal, final: cand.final, atualizadoEm: cand.atualizadoEm, vagas: cand.vagas } },
    resumo: {
      ...total,
      urnasDoEstado: u ? u.urnas.size : null, urnasColetadas: comCargo,
      municipiosComVoto: municipiosOut.filter((m) => m.votos > 0).length,
      bairrosComVoto: bairrosOut.filter((b) => b.votos > 0).length,
      locaisComVoto: locaisOut.filter((l) => l.votos > 0).length,
      locaisSemCoordenada: locaisOut.filter((l) => l.lat == null).length,
    },
    rede: { total: rede.total, comSecao: rede.comSecao, foraDaUf: rede.foraDaUf, semSecao: rede.semSecao, secoes: rede.porUrna.size },
    municipios: municipiosOut, bairros: bairrosOut, locais: locaisOut,
    secoes: secoesOut, secoesParciais, secoesTotal: secoes.length,
  };
}

// Quem venceu cada município (e cada local) num cargo — o "mapa da disputa",
// como o do eleicoes2026. Pesado em estado grande (soma todos os candidatos de
// todas as urnas), por isso feito no Postgres e guardado 10 minutos.
const cacheLideres = new Map();
async function lideresPorMunicipio({ ciclo, pleito, uf, cargo }) {
  // Mesmo cuidado do resultadoCandidato: a chave muda quando a carga avança.
  const { rows: and } = await pool.query(
    'SELECT coletadas, atualizado_em FROM tse_coletas WHERE ciclo = $1 AND pleito = $2 AND uf = $3', [ciclo, pleito, uf]
  );
  const chave = `${ciclo}|${pleito}|${uf}|${cargo}|${and[0] ? `${and[0].coletadas}|${and[0].atualizado_em.toISOString()}` : ''}`;
  const c = cacheLideres.get(chave);
  if (c && c.expira > Date.now()) return c.valor;
  const { rows } = await pool.query(
    `WITH v AS (
       SELECT u.municipio, e.key AS numero, sum(e.value::int) AS votos
         FROM tse_urnas u, jsonb_each_text(u.cargos->$4->'v') e
        WHERE u.ciclo = $1 AND u.pleito = $2 AND u.uf = $3
        GROUP BY u.municipio, e.key
     ), r AS (
       SELECT municipio, numero, votos,
              row_number() OVER (PARTITION BY municipio ORDER BY votos DESC) AS pos,
              sum(votos) OVER (PARTITION BY municipio) AS nominais
         FROM v
     )
     SELECT municipio, numero, votos, pos, nominais FROM r WHERE pos <= 2`,
    [ciclo, pleito, uf, String(cargo)]
  );
  const porMun = {};
  for (const r of rows) {
    if (!porMun[r.municipio]) porMun[r.municipio] = { nominais: Number(r.nominais) };
    porMun[r.municipio][Number(r.pos) === 1 ? 'lider' : 'segundo'] = { numero: r.numero, votos: Number(r.votos) };
  }
  cacheLideres.set(chave, { valor: porMun, expira: Date.now() + 10 * 60 * 1000 });
  return porMun;
}

// Malha dos municípios do estado (IBGE), para o mapa. Mesma fonte do
// eleicoes2026. Não muda: guardada em memória por um dia.
const COD_IBGE_UF = {
  ac: 12, al: 27, ap: 16, am: 13, ba: 29, ce: 23, df: 53, es: 32, go: 52, ma: 21, mt: 51, ms: 50, mg: 31, pa: 15, pb: 25,
  pr: 41, pe: 26, pi: 22, rj: 33, rn: 24, rs: 43, ro: 11, rr: 14, sc: 42, sp: 35, se: 28, to: 17,
};
const cacheMalha = new Map();
async function malhaEstado(uf) {
  const c = cacheMalha.get(uf);
  if (c && c.expira > Date.now()) return c.valor;
  const cod = COD_IBGE_UF[uf];
  if (!cod) return null;
  const resp = await fetch(`https://servicodados.ibge.gov.br/api/v3/malhas/estados/${cod}?formato=application/vnd.geo%2Bjson&qualidade=minima&intrarregiao=municipio`,
    { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`IBGE respondeu ${resp.status}`);
  const valor = await resp.json();
  cacheMalha.set(uf, { valor, expira: Date.now() + 24 * 3600e3 });
  return valor;
}

module.exports = { statusColeta, iniciarColeta, acordar, resultadoCandidato, lideresPorMunicipio, malhaEstado, COD_IBGE_UF, garantirLocais, anoLocais, urnasDoEstado, anoDoCiclo };
