const pool = require('../db');
const tse = require('./tse');
const { SQL_ARVORE_CANDIDATO } = require('../routes/apoiadores');

// Apuração ao vivo — cruza o total de votos do candidato em cada seção (dado
// público do BU) com quantos apoiadores a rede cadastrou naquela seção.
// Nada aqui identifica voto de ninguém: só entram totais por seção.

// Quantas seções buscar por rodada, e quantas em paralelo. Uma rodada roda a
// cada minuto; campanha estadual pode ter dezenas de milhares de seções nas
// zonas onde tem gente, e não dá para varrer tudo de uma vez sem o TSE
// começar a recusar. O que não coube numa rodada entra na seguinte.
const POR_RODADA = 600;
const PARALELO = 8;
const INTERVALO_MS = 60 * 1000;

async function carregarConfig(candidatoId) {
  const { rows } = await pool.query('SELECT * FROM apuracao_config WHERE candidato_id = $1', [candidatoId]);
  return rows[0] || null;
}

// Monta o universo da apuração: onde está cada cadastrado e quais seções
// precisam de BU. "Zonas da rede" = zonas onde há pelo menos um cadastrado;
// todas as seções delas entram, não só as que têm cadastrado, para o painel
// poder comparar os cadastrados com o voto da ZONA inteira.
async function montarUniverso(cfg) {
  const { rows: rede } = await pool.query(
    `SELECT id, nome, nivel, parent_id, cadastrado_por, meta_votos, zona, secao, estado FROM (${SQL_ARVORE_CANDIDATO}) r`, [cfg.candidato_id]
  );
  const mapa = await tse.configSecoes(cfg.ciclo, cfg.pleito, cfg.uf);

  const secoesRede = new Map();   // "zona|principal" → { cadastrados, agregadas }
  const onde = new Map();         // id da pessoa → { zona, urna } (quem entra na conta)
  const zonas = new Map();        // zona → { cadastrados, secoes: Set de principais }
  const alertas = { semZona: 0, semSecao: 0, foraDaUf: 0, foraDoMunicipio: 0, secaoInexistente: 0 };

  const zonaDe = (z) => {
    if (!zonas.has(z)) zonas.set(z, { cadastrados: 0, secoes: new Set() });
    return zonas.get(z);
  };

  for (const a of rede) {
    // Quem mora em outro estado vota lá: não entra na conta desta apuração.
    const uf = String(a.estado || '').trim().toLowerCase();
    if (uf && uf !== cfg.uf) { alertas.foraDaUf++; continue; }
    const z = tse.pad4(a.zona);
    if (!z) { alertas.semZona++; continue; }
    const s = tse.pad4(a.secao);
    const local = s && mapa ? mapa.secoes.get(`${z}|${s}`) : null;
    if (local && cfg.municipio && local.municipio !== cfg.municipio) { alertas.foraDoMunicipio++; continue; }
    zonaDe(z).cadastrados++;
    onde.set(a.id, { zona: z, urna: null });
    if (!s) { alertas.semSecao++; continue; }
    // Seção que não existe na lista oficial é erro de digitação no cadastro:
    // conta na zona, mas não vira linha de seção que nunca vai ser apurada.
    if (mapa && !local) { alertas.secaoInexistente++; continue; }
    const principal = local ? local.principal : s;
    const chave = `${z}|${principal}`;
    if (!secoesRede.has(chave)) {
      secoesRede.set(chave, { zona: z, secao: principal, municipio: local?.municipio || null, cadastrados: 0, agregadas: new Set() });
    }
    const item = secoesRede.get(chave);
    item.cadastrados++;
    onde.get(a.id).urna = chave;
    if (principal !== s) item.agregadas.add(s);
  }

  // Todas as urnas (seções principais) das zonas da rede.
  const urnas = new Map();
  if (mapa) {
    for (const loc of mapa.secoes.values()) {
      if (!zonas.has(loc.zona)) continue;
      if (cfg.municipio && loc.municipio !== cfg.municipio) continue;
      const chave = `${loc.zona}|${loc.principal}`;
      if (!urnas.has(chave)) urnas.set(chave, { zona: loc.zona, secao: loc.principal, municipio: loc.municipio });
      zonas.get(loc.zona).secoes.add(loc.principal);
    }
  } else {
    for (const [chave, it] of secoesRede) {
      urnas.set(chave, { zona: it.zona, secao: it.secao, municipio: it.municipio });
      zonas.get(it.zona).secoes.add(it.secao);
    }
  }
  return { rede, onde, secoesRede, zonas, urnas, alertas, mapaPublicado: !!mapa, municipios: mapa ? mapa.municipios : [] };
}

async function resultados(cfg) {
  const { rows } = await pool.query(
    `SELECT zona, secao, votos, fonte, aptos FROM apuracao_secoes
      WHERE candidato_id = $1 AND ciclo = $2 AND pleito = $3`,
    [cfg.candidato_id, cfg.ciclo, cfg.pleito]
  );
  return new Map(rows.map((r) => [`${r.zona}|${r.secao}`, r]));
}

function publicarConfig(cfg, municipios = []) {
  const mun = cfg.municipio && municipios.find((m) => m.codigo === cfg.municipio);
  return {
    ciclo: cfg.ciclo, pleito: cfg.pleito, uf: cfg.uf, municipio: cfg.municipio, municipioNome: mun ? mun.nome : null, cargo: cfg.cargo,
    numero: cfg.numero, ativo: cfg.ativo, ultimaBusca: cfg.ultima_busca, ultimoErro: cfg.ultimo_erro,
  };
}

// O painel inteiro, já cruzado. A cobertura média (soma dos votos das seções
// apuradas ÷ soma dos cadastrados dessas MESMAS seções) é feita no navegador
// a partir daqui, porque muda com o filtro de zona.
async function painel(candidatoId) {
  const cfg = await carregarConfig(candidatoId);
  if (!cfg) return { config: null };
  let u;
  try {
    u = await montarUniverso(cfg);
  } catch (e) {
    // TSE fora do ar não pode deixar a tela em branco: mostra a configuração
    // e o erro; o que já foi apurado continua no banco.
    return { config: publicarConfig(cfg), erro: `Não foi possível falar com o TSE: ${e.message}`, secoes: [], zonas: [], alertas: null };
  }
  const res = await resultados(cfg);

  const secoes = [...u.secoesRede.values()].map((s) => {
    const r = res.get(`${s.zona}|${s.secao}`);
    return {
      zona: s.zona, secao: s.secao, agregadas: [...s.agregadas].sort(), cadastrados: s.cadastrados,
      status: r ? 'apurado' : 'aguardando', votos: r ? r.votos : null, fonte: r?.fonte || null,
    };
  }).sort((a, b) => a.zona.localeCompare(b.zona) || a.secao.localeCompare(b.secao));

  const zonas = [...u.zonas.entries()].map(([zona, z]) => {
    let votosZona = 0; let apuradas = 0; let aptos = 0;
    for (const s of z.secoes) {
      const r = res.get(`${zona}|${s}`);
      if (r) { votosZona += r.votos; apuradas++; aptos += r.aptos || 0; }
    }
    return { zona, cadastrados: z.cadastrados, secoesTotal: z.secoes.size, secoesApuradas: apuradas, votosZona, aptos };
  }).sort((a, b) => a.zona.localeCompare(b.zona));

  return { config: publicarConfig(cfg, u.municipios), mapaPublicado: u.mapaPublicado, alertas: u.alertas, secoes, zonas, metas: calcularMetas(u, res, zonas) };
}

// Meta prometida × resultado (Telas 3 e 4 da especificação).
//  - Por zona: soma das metas de quem mora na zona × votos do candidato na zona inteira.
//  - Por responsável: a meta da pessoa × votos nas urnas onde ela e toda a
//    equipe abaixo dela votam. É a leitura mais justa possível sem saber em
//    quem cada um votou (e isso ninguém sabe: o voto é secreto). A mesma urna
//    conta uma vez só, mesmo com várias pessoas da equipe nela.
function calcularMetas(u, res, zonas) {
  const comMeta = (a) => a.nivel >= 1 && a.nivel <= 3;
  const porZona = zonas.map((z) => {
    let meta = 0; let pessoas = 0;
    for (const a of u.rede) {
      if (!comMeta(a) || a.meta_votos == null) continue;
      if (u.onde.get(a.id)?.zona !== z.zona) continue;
      meta += a.meta_votos; pessoas++;
    }
    return { zona: z.zona, meta, pessoasComMeta: pessoas, votosZona: z.votosZona, secoesApuradas: z.secoesApuradas, secoesTotal: z.secoesTotal };
  }).filter((z) => z.pessoasComMeta > 0);

  // Filhos na pirâmide: mesma regra da árvore do sistema (parent_id, ou quem
  // cadastrou quando o cadastro ficou sem responsável).
  const filhos = new Map();
  for (const a of u.rede) {
    const pai = a.parent_id || a.cadastrado_por;
    if (!pai || pai === a.id) continue;
    if (!filhos.has(pai)) filhos.set(pai, []);
    filhos.get(pai).push(a.id);
  }
  const porResponsavel = u.rede.filter(comMeta).map((a) => {
    const vistos = new Set([a.id]);
    const pilha = [a.id];
    while (pilha.length) {
      for (const f of filhos.get(pilha.pop()) || []) {
        if (!vistos.has(f)) { vistos.add(f); pilha.push(f); }
      }
    }
    const urnas = new Set();
    for (const id of vistos) { const o = u.onde.get(id); if (o && o.urna) urnas.add(o.urna); }
    let votos = 0; let apuradas = 0; let aptos = 0;
    for (const k of urnas) { const r = res.get(k); if (r) { votos += r.votos; apuradas++; aptos += r.aptos || 0; } }
    return {
      id: a.id, nome: a.nome, nivel: a.nivel, zona: u.onde.get(a.id)?.zona || null, meta: a.meta_votos,
      equipe: vistos.size - 1, urnasTotal: urnas.size, urnasApuradas: apuradas, votos,
      // Eleitores aptos nas seções da equipe — é o teto da meta ("meta
      // prometida maior que o total de votantes da seção" = meta irrealista).
      aptosSecoes: apuradas === urnas.size ? aptos : null,
      secoes: [...urnas].map((k) => k.split('|')[1]).sort(),
    };
  });
  return { porZona, porResponsavel };
}

// Uma rodada de busca no TSE para um candidato. Primeiro as seções que têm
// cadastrado (é o que o painel mostra linha a linha), depois o resto das
// zonas. Cursor em memória: se a lista não couber numa rodada, a próxima
// continua de onde esta parou em vez de repetir sempre o começo.
const cursores = new Map();
const rodando = new Set();

async function rodada(candidatoId) {
  if (rodando.has(candidatoId)) return { emAndamento: true };
  rodando.add(candidatoId);
  try {
    const cfg = await carregarConfig(candidatoId);
    if (!cfg) return { tentadas: 0, novas: 0 };
    let novas = 0; let tentadas = 0; let erro = null;
    try {
      const u = await montarUniverso(cfg);
      if (!u.mapaPublicado) throw new Error('O TSE ainda não publicou a lista de seções desta eleição.');
      const res = await resultados(cfg);
      const pendentes = [...u.urnas.entries()].filter(([k]) => !res.has(k));
      pendentes.sort(([a], [b]) => (u.secoesRede.has(b) ? 1 : 0) - (u.secoesRede.has(a) ? 1 : 0));

      const inicio = (cursores.get(candidatoId) || 0) % Math.max(pendentes.length, 1);
      const lote = pendentes.slice(inicio, inicio + POR_RODADA);
      cursores.set(candidatoId, inicio + lote.length);
      tentadas = lote.length;

      let i = 0;
      const trabalhador = async () => {
        while (i < lote.length) {
          const [, urna] = lote[i++];
          const bu = await tse.buscarSecao({ ...cfg, ...urna });
          if (bu === null) continue;
          // DO NOTHING: resultado colado à mão (plano B) não é sobrescrito.
          await pool.query(
            `INSERT INTO apuracao_secoes (candidato_id, ciclo, pleito, zona, secao, municipio, votos, fonte, aptos)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'tse',$8)
             ON CONFLICT (candidato_id, ciclo, pleito, zona, secao) DO NOTHING`,
            [candidatoId, cfg.ciclo, cfg.pleito, urna.zona, urna.secao, urna.municipio, bu.votos, bu.aptos]
          );
          novas++;
        }
      };
      await Promise.all(Array.from({ length: PARALELO }, trabalhador));
    } catch (e) {
      erro = e.message;
    }
    await pool.query(
      'UPDATE apuracao_config SET ultima_busca = now(), ultimo_erro = $2 WHERE candidato_id = $1',
      [candidatoId, erro]
    );
    return { tentadas, novas, erro };
  } finally {
    rodando.delete(candidatoId);
  }
}

// Laço de fundo: a tela precisa atualizar sozinha na noite da eleição, sem
// ninguém apertar botão. Nunca derruba o servidor — o erro de uma campanha
// vai para o ultimo_erro dela e as outras seguem.
function iniciar() {
  const volta = async () => {
    try {
      const { rows } = await pool.query('SELECT candidato_id FROM apuracao_config WHERE ativo');
      for (const r of rows) await rodada(r.candidato_id);
    } catch (e) {
      console.error('[apuracao]', e.message);
    }
    setTimeout(volta, INTERVALO_MS);
  };
  setTimeout(volta, 15 * 1000);
}

// Plano B, para o caso de o TSE mudar o formato na noite da eleição: colar o
// resultado por seção ("zona;seção;votos"), tirado de qualquer fonte oficial.
async function importarManual(candidatoId, texto) {
  const cfg = await carregarConfig(candidatoId);
  if (!cfg) return { erro: 'Configure a eleição antes de importar.' };
  const mapa = await tse.configSecoes(cfg.ciclo, cfg.pleito, cfg.uf).catch(() => null);
  const linhas = String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (linhas.length > 20000) return { erro: 'Máximo de 20.000 linhas por importação.' };
  const validas = []; const recusadas = [];
  for (const [n, linha] of linhas.entries()) {
    const partes = linha.split(/[;,\t ]+/);
    const z = tse.pad4(partes[0]); const s = tse.pad4(partes[1]);
    const v = /^\d+$/.test(partes[2] || '') ? Number(partes[2]) : null;
    // Cabeçalho ("zona;secao;votos") e linha torta são pulados, não abortam tudo.
    if (!z || !s || v === null) { recusadas.push(n + 1); continue; }
    const local = mapa?.secoes.get(`${z}|${s}`);
    validas.push({ zona: z, secao: local ? local.principal : s, municipio: local?.municipio || null, votos: v });
  }
  for (const r of validas) {
    await pool.query(
      `INSERT INTO apuracao_secoes (candidato_id, ciclo, pleito, zona, secao, municipio, votos, fonte)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual')
       ON CONFLICT (candidato_id, ciclo, pleito, zona, secao)
       DO UPDATE SET votos = EXCLUDED.votos, fonte = 'manual', apurado_em = now()`,
      [candidatoId, cfg.ciclo, cfg.pleito, r.zona, r.secao, r.municipio, r.votos]
    );
  }
  return { importadas: validas.length, recusadas };
}

module.exports = { painel, rodada, iniciar, importarManual, carregarConfig };