const express = require('express');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const tse = require('../services/tse');
const votos = require('../services/votosSecao');

// Votos por seção — qualquer candidato, o estado inteiro. Arquivo próprio
// pelo mesmo motivo de apuracao.js: nada aqui mexe na pirâmide. Só candidato
// e admin: o cruzamento com a rede mostra quantos cadastrados votam em cada
// seção, e isso é a visão da campanha inteira.
const router = express.Router();
router.use(authRequired, resolveWorkspace, requireRole('candidato', 'admin'));

// As seções do estado inteiro passam de 1,5 MB em JSON (MS, 7 mil urnas); no
// 4G de campanha isso pesa. O servidor não tem compressão ligada para o resto
// da API, então só esta resposta sai em gzip (~8x menor).
const zlib = require('zlib');
function jsonComprimido(req, res, dados) {
  const corpo = Buffer.from(JSON.stringify(dados));
  if (corpo.length > 20000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.send(zlib.gzipSync(corpo));
  }
  return res.type('application/json').send(corpo);
}

const UFS = ['ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to'];
const MUNICIPAIS = [11, 13]; // prefeito, vereador: o número se repete em cada cidade

// Validação comum. Tudo que vai para URL do TSE passa por aqui — nada de
// texto livre do navegador montando caminho no servidor de outro órgão.
function params(q, { exigeCargo = false, exigeNumero = false } = {}) {
  const p = {
    ciclo: String(q.ciclo || '').toLowerCase(),
    pleito: String(q.pleito || ''),
    eleicao: String(q.eleicao || ''),
    uf: String(q.uf || '').toLowerCase(),
    cargo: q.cargo != null && q.cargo !== '' ? Number(q.cargo) : null,
    numero: String(q.numero || '').replace(/\D/g, ''),
    municipio: q.municipio ? String(q.municipio) : null,
  };
  if (!/^ele\d{4}$/.test(p.ciclo)) return { erro: 'Eleição inválida.' };
  if (p.pleito && !/^\d{1,6}$/.test(p.pleito)) return { erro: 'Turno inválido.' };
  if (p.eleicao && !/^\d{1,6}$/.test(p.eleicao)) return { erro: 'Eleição inválida.' };
  if (!UFS.includes(p.uf)) return { erro: 'Estado inválido.' };
  if (p.municipio && !/^\d{5}$/.test(p.municipio)) return { erro: 'Município inválido.' };
  if (exigeCargo && !(p.cargo >= 1 && p.cargo <= 99)) return { erro: 'Cargo inválido.' };
  if (exigeNumero && !/^\d{2,5}$/.test(p.numero)) return { erro: 'Número do candidato inválido.' };
  if (exigeCargo && MUNICIPAIS.includes(p.cargo) && !p.municipio) return { erro: 'Para prefeito e vereador, escolha o município.' };
  return p;
}

// Eleições publicadas pelo TSE, com os cargos de cada uma — é o que monta
// "Eleição › Cargo › Candidato" na tela sem ninguém precisar saber código.
router.get('/eleicoes', asyncHandler(async (req, res) => {
  try {
    const pleitos = await tse.listarPleitos();
    const out = [];
    for (const p of pleitos) {
      const eleicoes = await tse.eleicoesDoPleito(p.ciclo, p.pleito);
      if (eleicoes.length) out.push({ ciclo: p.ciclo, pleito: String(p.pleito), data: p.data, eleicoes });
    }
    // Mais recente primeiro; eleição geral/municipal (várias UFs) antes de suplementar.
    const dataNum = (d) => Number(String(d || '').split('/').reverse().join('')) || 0;
    out.sort((a, b) => dataNum(b.data) - dataNum(a.data));
    res.json({ pleitos: out });
  } catch (e) {
    res.json({ pleitos: [], erro: `TSE indisponível: ${e.message}` });
  }
}));

router.get('/municipios', asyncHandler(async (req, res) => {
  const p = params(req.query);
  if (p.erro || !p.eleicao) return res.status(400).json({ error: p.erro || 'Eleição inválida.' });
  res.json(await tse.municipiosEleicao(p.ciclo, p.eleicao, p.uf));
}));

router.get('/candidatos', asyncHandler(async (req, res) => {
  const p = params(req.query, { exigeCargo: true });
  if (p.erro || !p.eleicao) return res.status(400).json({ error: p.erro || 'Eleição inválida.' });
  const r = await tse.candidatosCargo(p);
  if (!r) return res.json({ candidatos: [], publicado: false });
  res.json({
    ...r, publicado: true,
    candidatos: r.candidatos.map((c) => ({ ...c, foto: tse.fotoUrl(p.ciclo, p.eleicao, p.uf, c.sq) })),
  });
}));

router.get('/coleta', asyncHandler(async (req, res) => {
  const p = params(req.query);
  if (p.erro || !p.pleito) return res.status(400).json({ error: p.erro || 'Turno inválido.' });
  res.json(await votos.statusColeta(p.ciclo, p.pleito, p.uf));
}));

// "Carregar o estado": baixa o boletim de todas as urnas da UF, uma vez.
// Público e igual para todo mundo — a próxima campanha do mesmo estado já
// encontra pronto.
router.post('/coleta', asyncHandler(async (req, res) => {
  const p = params(req.body || {});
  if (p.erro || !p.pleito) return res.status(400).json({ error: p.erro || 'Turno inválido.' });
  const refazer = req.body?.refazer === true;
  try {
    const st = await votos.iniciarColeta({ ...p, usuarioId: req.user.id, refazer });
    await registrar(req, { acao: 'votos.coletar', alvoTipo: 'config', detalhes: { ciclo: p.ciclo, pleito: p.pleito, uf: p.uf, refazer, urnas: st.total } });
    res.json(st);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.get('/resultado', asyncHandler(async (req, res) => {
  const p = params(req.query, { exigeCargo: true, exigeNumero: true });
  if (p.erro || !p.pleito || !p.eleicao) return res.status(400).json({ error: p.erro || 'Eleição inválida.' });
  const secoesDoMunicipio = req.query.secoesDoMunicipio && /^\d{5}$/.test(req.query.secoesDoMunicipio) ? req.query.secoesDoMunicipio : null;
  jsonComprimido(req, res, await votos.resultadoCandidato({ ...p, candidatoId: req.effectiveId, secoesDoMunicipio }));
}));

router.get('/lideres', asyncHandler(async (req, res) => {
  const p = params(req.query, { exigeCargo: false });
  if (p.erro || !p.pleito || !(p.cargo >= 1)) return res.status(400).json({ error: p.erro || 'Cargo inválido.' });
  res.json(await votos.lideresPorMunicipio(p));
}));

router.get('/malha/:uf', asyncHandler(async (req, res) => {
  const uf = String(req.params.uf || '').toLowerCase();
  if (!UFS.includes(uf)) return res.status(400).json({ error: 'Estado inválido.' });
  try {
    jsonComprimido(req, res, await votos.malhaEstado(uf));
  } catch (e) {
    res.status(502).json({ error: `Mapa do IBGE indisponível: ${e.message}` });
  }
}));

module.exports = router;
