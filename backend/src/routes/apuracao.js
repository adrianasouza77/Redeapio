const express = require('express');
const pool = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const resolveWorkspace = require('../middleware/workspace');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const tse = require('../services/tse');
const apuracao = require('../services/apuracao');

// Apuração ao vivo. Arquivo próprio pelo mesmo motivo de mapas.js: nada aqui
// mexe na pirâmide, e apoiadores.js é o arquivo mais delicado do sistema.
// Só candidato (e o admin dentro do workspace dele) — é a visão da campanha
// inteira, e liderança não enxerga a rede toda.
const router = express.Router();
router.use(authRequired, resolveWorkspace, requireRole('candidato', 'admin'));

const UFS = ['ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to'];
// Títulos exatamente como aparecem no cabeçalho de cada bloco do BU.
const CARGOS = ['PRESIDENTE','GOVERNADOR','SENADOR','DEPUTADO FEDERAL','DEPUTADO ESTADUAL','DEPUTADO DISTRITAL','PREFEITO','VEREADOR'];

router.get('/', asyncHandler(async (req, res) => {
  res.json(await apuracao.painel(req.effectiveId));
}));

// Eleições que o TSE já publicou, para a tela oferecer em lista em vez de
// pedir ao candidato um código que ele não tem como saber.
router.get('/pleitos', asyncHandler(async (req, res) => {
  try {
    res.json({ pleitos: await tse.listarPleitos(), cargos: CARGOS });
  } catch (e) {
    res.json({ pleitos: [], cargos: CARGOS, erro: `TSE indisponível: ${e.message}` });
  }
}));

router.get('/municipios', asyncHandler(async (req, res) => {
  const { ciclo, pleito, uf } = req.query;
  if (!/^ele\d{4}$/.test(ciclo || '') || !/^\d{1,6}$/.test(pleito || '') || !UFS.includes(uf)) {
    return res.status(400).json({ error: 'Eleição ou estado inválido.' });
  }
  const mapa = await tse.configSecoes(ciclo, pleito, uf).catch(() => null);
  res.json(mapa ? mapa.municipios : []);
}));

router.put('/config', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const ciclo = String(b.ciclo || '').trim().toLowerCase();
  const pleito = String(b.pleito || '').trim();
  const uf = String(b.uf || '').trim().toLowerCase();
  const municipio = b.municipio ? String(b.municipio).trim() : null;
  const cargo = String(b.cargo || '').trim().toUpperCase();
  const numero = String(b.numero || '').replace(/\D/g, '');
  if (!/^ele\d{4}$/.test(ciclo) || !/^\d{1,6}$/.test(pleito)) return res.status(400).json({ error: 'Escolha a eleição.' });
  if (!UFS.includes(uf)) return res.status(400).json({ error: 'Estado inválido.' });
  if (municipio && !/^\d{5}$/.test(municipio)) return res.status(400).json({ error: 'Município inválido.' });
  if (!CARGOS.includes(cargo)) return res.status(400).json({ error: 'Cargo inválido.' });
  // Número do candidato: 2 dígitos (majoritário) a 5 (deputado estadual/vereador).
  if (!/^\d{2,5}$/.test(numero)) return res.status(400).json({ error: 'Número do candidato inválido.' });
  // Vereador e prefeito repetem número de cidade para cidade: sem o município,
  // os votos do "11123" de outra cidade da mesma zona entrariam na conta.
  if ((cargo === 'PREFEITO' || cargo === 'VEREADOR') && !municipio) {
    return res.status(400).json({ error: 'Para prefeito e vereador, escolha o município.' });
  }
  const ativo = b.ativo !== false;

  const antes = await apuracao.carregarConfig(req.effectiveId);
  await pool.query(
    `INSERT INTO apuracao_config (candidato_id, ciclo, pleito, uf, municipio, cargo, numero, ativo, ultimo_erro, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,now())
     ON CONFLICT (candidato_id) DO UPDATE SET ciclo = EXCLUDED.ciclo, pleito = EXCLUDED.pleito, uf = EXCLUDED.uf,
       municipio = EXCLUDED.municipio, cargo = EXCLUDED.cargo, numero = EXCLUDED.numero, ativo = EXCLUDED.ativo,
       ultimo_erro = NULL, atualizado_em = now()`,
    [req.effectiveId, ciclo, pleito, uf, municipio, cargo, numero, ativo]
  );
  // Trocar número, cargo ou município invalida o que já foi apurado com a
  // configuração antiga — inclusive o que foi colado à mão: aqueles votos eram
  // de outra pessoa. Eleição diferente não precisa apagar nada, porque
  // ciclo/pleito já fazem parte da chave.
  let rowCount = 0;
  if (antes && (antes.numero !== numero || antes.cargo !== cargo || (antes.municipio || null) !== municipio)) {
    ({ rowCount } = await pool.query(
      `DELETE FROM apuracao_secoes WHERE candidato_id = $1 AND ciclo = $2 AND pleito = $3`,
      [req.effectiveId, ciclo, pleito]
    ));
  }
  await registrar(req, { acao: 'apuracao.configurar', alvoTipo: 'config', detalhes: { ciclo, pleito, uf, municipio, cargo, numero, ativo, resultados_descartados: rowCount } });
  res.json(await apuracao.painel(req.effectiveId));
}));

// "Buscar agora": a mesma rodada do laço de fundo, sem esperar o minuto.
router.post('/buscar', asyncHandler(async (req, res) => {
  const r = await apuracao.rodada(req.effectiveId);
  res.json({ ...r, painel: await apuracao.painel(req.effectiveId) });
}));

router.post('/manual', asyncHandler(async (req, res) => {
  const r = await apuracao.importarManual(req.effectiveId, req.body?.texto);
  if (r.erro) return res.status(400).json({ error: r.erro });
  await registrar(req, { acao: 'apuracao.importar', alvoTipo: 'config', detalhes: { importadas: r.importadas, recusadas: r.recusadas.length } });
  res.json(r);
}));

module.exports = router;