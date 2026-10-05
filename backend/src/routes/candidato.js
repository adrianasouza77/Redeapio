const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const tse = require('../services/tse');
const votos = require('../services/votosSecao');
const campanha = require('../services/campanha');
const importacao = require('../services/importacao');

// Aba Candidato (briefing "Votos por seção" v2, itens 1 e 4): os dados que
// identificam a votação do candidato no TSE e o botão "Importar votos do TSE".
const router = express.Router();
router.use(authRequired, resolveWorkspace);

const UFS = ['ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to'];
const soCandidato = requireRole('candidato', 'admin');

router.get('/', soCandidato, asyncHandler(async (req, res) => {
  const dados = await campanha.carregarDados(req.effectiveId);
  const { rows: rede } = await pool.query(
    `SELECT r.id, r.nome, cg.nome AS coordenador_geral FROM usuarios u
       LEFT JOIN redes r ON r.id = u.rede_id LEFT JOIN usuarios cg ON cg.id = r.coordenador_geral_id
      WHERE u.id = $1`, [req.effectiveId]
  );
  res.json({ dados, cargos: campanha.CARGOS, digitos: campanha.DIGITOS, rede: rede[0] || null });
}));

// Eleições ordinárias publicadas pelo TSE (ano, turno, cargos) — monta o
// formulário sem ninguém precisar saber código do TSE.
router.get('/eleicoes', soCandidato, asyncHandler(async (req, res) => {
  try {
    res.json({ eleicoes: await campanha.eleicoesOrdinarias() });
  } catch (e) {
    res.json({ eleicoes: [], erro: `TSE indisponível: ${e.message}` });
  }
}));

function eleicaoDoPedido(q) {
  const ciclo = String(q.ciclo || '').toLowerCase();
  const eleicao = String(q.eleicao || '');
  const uf = String(q.uf || '').toLowerCase();
  if (!/^ele\d{4}$/.test(ciclo) || !/^\d{1,6}$/.test(eleicao) || !UFS.includes(uf)) return null;
  return { ciclo, eleicao, uf };
}

// Municípios do estado com o código do TSE (que é diferente do IBGE).
router.get('/municipios', soCandidato, asyncHandler(async (req, res) => {
  const p = eleicaoDoPedido(req.query);
  if (!p) return res.status(400).json({ error: 'Eleição ou estado inválido.' });
  res.json(await tse.municipiosEleicao(p.ciclo, p.eleicao, p.uf).catch(() => []));
}));

// Lista oficial de candidatos do cargo: é digitando o NOME que se escolhe o
// candidato; número, partido e nome de urna vêm daqui.
router.get('/candidatos', soCandidato, asyncHandler(async (req, res) => {
  const p = eleicaoDoPedido(req.query);
  const cargo = Number(req.query.cargo);
  const municipio = req.query.municipio && /^\d{5}$/.test(req.query.municipio) ? req.query.municipio : null;
  if (!p || !campanha.CARGOS[cargo]) return res.status(400).json({ error: 'Eleição ou cargo inválido.' });
  if (campanha.MUNICIPAIS.includes(cargo) && !municipio) return res.json({ candidatos: [], publicado: false });
  const r = await tse.candidatosCargo({ ...p, municipio, cargo }).catch(() => null);
  if (!r) return res.json({ candidatos: [], publicado: false });
  res.json({
    publicado: true, final: r.final,
    candidatos: r.candidatos.map((c) => ({
      numero: c.numero, nome: c.nome, nomeCompleto: c.nomeCompleto, partido: c.partido, votos: c.votos,
      situacao: c.situacao, foto: tse.fotoUrl(p.ciclo, p.eleicao, p.uf, c.sq),
    })),
  });
}));

router.put('/', soCandidato, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const ano = Number(b.ano);
  const turno = Number(b.turno) || 1;
  const cargo = Number(b.cargo);
  const numero = String(b.numero || '').replace(/\D/g, '');
  const partido = String(b.partido || '').trim().toUpperCase();
  const uf = String(b.uf || '').trim().toLowerCase();
  const nomeUrna = String(b.nome_urna || '').trim() || null;
  const verde = b.faixa_verde == null || b.faixa_verde === '' ? 80 : Number(b.faixa_verde);
  const amarela = b.faixa_amarela == null || b.faixa_amarela === '' ? 50 : Number(b.faixa_amarela);

  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return res.status(400).json({ error: 'Informe o ano da eleição.' });
  if (![1, 2].includes(turno)) return res.status(400).json({ error: 'Turno deve ser 1 ou 2.' });
  if (!campanha.CARGOS[cargo]) return res.status(400).json({ error: 'Escolha o cargo.' });
  const erroNum = campanha.erroNumero(cargo, numero);
  if (erroNum) return res.status(400).json({ error: erroNum });
  if (!/^[A-Z0-9 ]{2,20}$/.test(partido)) return res.status(400).json({ error: 'Informe a sigla do partido.' });
  if (!UFS.includes(uf)) return res.status(400).json({ error: 'Escolha o estado (UF).' });
  if (!Number.isInteger(verde) || !Number.isInteger(amarela) || amarela < 0 || verde <= amarela || verde > 1000) {
    return res.status(400).json({ error: 'Faixas do sinal inválidas: o verde precisa ser maior que o amarelo.' });
  }

  const abrangencia = campanha.abrangenciaValida(cargo, b.abrangencia);
  const municipios = (Array.isArray(b.municipios) ? b.municipios : [])
    .map((m) => ({ codigo: String(m.codigo || '').trim(), nome: String(m.nome || '').trim() }))
    .filter((m) => /^\d{5}$/.test(m.codigo) && m.nome);
  const unicos = [...new Map(municipios.map((m) => [m.codigo, m])).values()];
  if (abrangencia === 'municipio' && unicos.length !== 1) return res.status(400).json({ error: 'Para vereador e prefeito, escolha o município.' });
  if (abrangencia === 'municipios' && !unicos.length) return res.status(400).json({ error: 'Marque pelo menos um município-alvo, ou escolha "Estado todo".' });
  const lista = abrangencia === 'estado' ? [] : unicos;

  // Códigos do TSE da eleição. Sem eles (eleição futura, TSE fora do ar) o
  // cadastro salva do mesmo jeito: a importação tenta resolver de novo.
  const cod = await campanha.resolverEleicao(ano, turno, cargo);
  // Município com o código do TSE: quando a lista oficial está disponível,
  // o código precisa estar nela (não pode ser o do IBGE).
  if (cod && lista.length) {
    const oficiais = await tse.municipiosEleicao(cod.ciclo, cod.eleicao, uf).catch(() => []);
    if (oficiais.length) {
      const porCod = new Map(oficiais.map((m) => [m.codigo, m]));
      const fora = lista.find((m) => !porCod.has(m.codigo));
      if (fora) return res.status(400).json({ error: `Município ${fora.nome} não encontrado no TSE para ${uf.toUpperCase()}. Escolha da lista.` });
      lista.forEach((m) => { m.nome = porCod.get(m.codigo).nome; });
    }
  }

  const antes = await campanha.carregarDados(req.effectiveId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO candidato_dados (candidato_id, ano, turno, cargo, numero, partido, uf, abrangencia, nome_urna,
         ciclo, pleito, eleicao, faixa_verde, faixa_amarela, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (candidato_id) DO UPDATE SET ano = EXCLUDED.ano, turno = EXCLUDED.turno, cargo = EXCLUDED.cargo,
         numero = EXCLUDED.numero, partido = EXCLUDED.partido, uf = EXCLUDED.uf, abrangencia = EXCLUDED.abrangencia,
         nome_urna = EXCLUDED.nome_urna, ciclo = EXCLUDED.ciclo, pleito = EXCLUDED.pleito, eleicao = EXCLUDED.eleicao,
         faixa_verde = EXCLUDED.faixa_verde, faixa_amarela = EXCLUDED.faixa_amarela, atualizado_em = now()`,
      [req.effectiveId, ano, turno, cargo, numero, partido, uf, abrangencia, nomeUrna,
        cod?.ciclo || null, cod?.pleito || null, cod?.eleicao || null, verde, amarela]
    );
    await client.query('DELETE FROM candidato_municipios WHERE candidato_id = $1', [req.effectiveId]);
    for (const m of lista) {
      await client.query(
        'INSERT INTO candidato_municipios (candidato_id, cod_municipio_tse, nome) VALUES ($1,$2,$3)',
        [req.effectiveId, m.codigo, m.nome]
      );
    }
    // A apuração ao vivo passa a ler o mesmo cadastro: um lugar só para o
    // candidato informar quem ele é. Trocar número, cargo ou município apaga o
    // que já tinha sido apurado com a configuração antiga (era outra pessoa).
    if (cod) {
      const municipioAp = campanha.MUNICIPAIS.includes(cargo) ? lista[0].codigo : null;
      const { rows: apAntes } = await client.query('SELECT numero, cargo, municipio FROM apuracao_config WHERE candidato_id = $1', [req.effectiveId]);
      await client.query(
        `INSERT INTO apuracao_config (candidato_id, ciclo, pleito, uf, municipio, cargo, numero, ativo, ultimo_erro, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,NULL,now())
         ON CONFLICT (candidato_id) DO UPDATE SET ciclo = EXCLUDED.ciclo, pleito = EXCLUDED.pleito, uf = EXCLUDED.uf,
           municipio = EXCLUDED.municipio, cargo = EXCLUDED.cargo, numero = EXCLUDED.numero, ultimo_erro = NULL, atualizado_em = now()`,
        [req.effectiveId, cod.ciclo, cod.pleito, uf, municipioAp, campanha.CARGO_BU[cargo], numero]
      );
      const a = apAntes[0];
      if (a && (a.numero !== numero || a.cargo !== campanha.CARGO_BU[cargo] || (a.municipio || null) !== municipioAp)) {
        await client.query('DELETE FROM apuracao_secoes WHERE candidato_id = $1 AND ciclo = $2 AND pleito = $3', [req.effectiveId, cod.ciclo, cod.pleito]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await registrar(req, {
    acao: 'candidato.dados', alvoTipo: 'config', alvoId: req.effectiveId, alvoNome: 'Dados do candidato',
    detalhes: { ano, turno, cargo: campanha.CARGOS[cargo], numero, partido, uf, abrangencia, municipios: lista.map((m) => m.nome), antes: antes && { numero: antes.numero, cargo: antes.cargo, ano: antes.ano } },
  });
  res.json({ dados: await campanha.carregarDados(req.effectiveId), tsePublicado: !!cod });
}));

router.post('/importar', soCandidato, asyncHandler(async (req, res) => {
  try {
    const r = await importacao.iniciar(req.effectiveId, req.user);
    await registrar(req, { acao: 'candidato.importar', alvoTipo: 'config', alvoId: req.effectiveId, alvoNome: 'Importar votos do TSE', detalhes: { status: r.status, erro: r.erro || null } });
    res.json({ ...r, ...(await importacao.situacao(req.effectiveId)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.get('/importacao', soCandidato, asyncHandler(async (req, res) => {
  res.json(await importacao.situacao(req.effectiveId));
}));

// ─── Município, zona, seção e escola de quem vota (cadastros) ───────────────
// Qualquer perfil que cadastra gente usa (candidato, liderança, apoiador): os
// municípios e as escolas são da eleição do candidato da rede.

async function eleicaoDaRede(req) {
  const id = campanha.candidatoDoPedido(req);
  if (!id) return null;
  return campanha.carregarDados(id);
}

router.get('/votacao/municipios', asyncHandler(async (req, res) => {
  const d = await eleicaoDaRede(req);
  res.json(await municipiosDeVotacao(d));
}));

router.get('/votacao/locais', asyncHandler(async (req, res) => {
  const d = await eleicaoDaRede(req);
  res.json(await locaisDaZona(d, req.query.zona, req.query.municipio));
}));

// Lista de municípios em que se vota no estado da campanha (código TSE).
async function municipiosDeVotacao(d) {
  if (!d || !d.ciclo) return { uf: d?.uf || null, municipios: [] };
  const mapa = await tse.configSecoes(d.ciclo, d.pleito, d.uf).catch(() => null);
  return { uf: d.uf, municipios: mapa ? mapa.municipios : [] };
}

// Escolas (locais de votação) de uma zona, com as seções de cada uma — "escolhido
// numa lista após informar a zona". Carrega os locais do estado na primeira vez.
async function locaisDaZona(d, zonaTxt, municipio) {
  const zona = tse.pad4(zonaTxt);
  if (!d || !zona) return { locais: [] };
  // O cadastro de locais do ano da eleição, ou o mais próximo que o TSE tiver.
  const ano = await votos.anoLocais(d.ano, d.uf);
  if (!ano) return { locais: [] };
  const mun = municipio && /^\d{5}$/.test(municipio) ? municipio : null;
  const { rows: locais } = await pool.query(
    `SELECT local_numero AS numero, max(local_nome) AS nome, max(bairro) AS bairro, max(endereco) AS endereco,
            array_agg(secao ORDER BY secao) AS secoes
       FROM tse_locais WHERE ano = $1 AND uf = $2 AND zona = $3 AND ($4::text IS NULL OR municipio = $4)
      GROUP BY local_numero ORDER BY max(local_nome)`,
    [ano, d.uf, zona, mun]
  );
  return { ano, locais };
}

module.exports = router;
module.exports.municipiosDeVotacao = municipiosDeVotacao;
module.exports.locaisDaZona = locaisDaZona;
