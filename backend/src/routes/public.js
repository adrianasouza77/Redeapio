const express = require('express');
const pool = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { validarTituloEleitoral } = require('../utils/tituloEleitoral');
const { buscarDuplicidade } = require('../utils/duplicidade');
const { limitesDoCandidato } = require('../utils/limites');
const { hash } = require('../utils/password');
const { termoVersaoAtual } = require('../config');

const router = express.Router();

// Nível de quem enviou o link (liderança = 1; apoiador = nível da ficha-espelho,
// que pode ser 2 ou 3). O novo cadastrado entra um nível abaixo. Enquanto houver
// nível abaixo dele para recrutar (novo nível 2 ou 3), ele vira usuário com
// login; no nível 4 (base) é só um contato, sem login.
async function contextoConvite(liderancaId) {
  const { rows } = await pool.query(
    "SELECT u.id, u.nome, u.perfil, u.criado_por, a.nivel FROM usuarios u LEFT JOIN apoiadores a ON a.id = u.id WHERE u.id = $1 AND u.perfil IN ('lideranca','apoiador')",
    [liderancaId]
  );
  const conv = rows[0];
  if (!conv) return null;
  const nivelConvite = conv.perfil === 'lideranca' ? 1 : (conv.nivel ?? 2);
  const novoNivel = nivelConvite + 1;
  return { conv, nivelConvite, novoNivel, criaLogin: novoNivel <= 3 };
}

router.get('/lideranca/:id', asyncHandler(async (req, res) => {
  const ctx = await contextoConvite(req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Link inválido.' });
  res.json({ nome: ctx.conv.nome, versaoTermo: termoVersaoAtual, criaLogin: ctx.criaLogin, novoNivel: ctx.novoNivel });
}));

router.post('/autocadastro', asyncHandler(async (req, res) => {
  const { lideranca_id, nome, telefone, nascimento, endereco, regiao, cidade, estado, titulo, zona, secao, lgpd_aceite, login, senha } = req.body || {};

  if (!lgpd_aceite) {
    return res.status(400).json({ error: 'É necessário aceitar o termo de consentimento LGPD.' });
  }
  if (!nome || !telefone || !nascimento || !regiao) {
    return res.status(400).json({ error: 'Preencha nome, telefone, nascimento e bairro.' });
  }
  if (!titulo || !zona || !secao) {
    return res.status(400).json({ error: 'Título, zona e seção eleitoral são obrigatórios.' });
  }
  if (!validarTituloEleitoral(titulo)) {
    return res.status(400).json({ error: 'Título de eleitor inválido. Confira os 12 números do seu título.' });
  }
  if (!lideranca_id) return res.status(400).json({ error: 'Link de cadastro inválido.' });

  const ctx = await contextoConvite(lideranca_id);
  if (!ctx) return res.status(400).json({ error: 'Link de cadastro inválido.' });
  const { conv, nivelConvite, novoNivel, criaLogin } = ctx;

  // criado_por de qualquer usuário-com-login é sempre o candidato dono da rede —
  // tanto lideranças quanto apoiadores (inclusive os autocadastrados) guardam
  // o id do candidato aqui, o que resolverCandidatoId/duplicidade/limites já usam.
  const candidatoId = conv.criado_por;

  // Impede a mesma pessoa se autocadastrar duas vezes na rede desse candidato
  // (por engano ou por má-fé) — checa telefone e título de eleitor.
  const dup = await buscarDuplicidade({ candidatoId, telefone, titulo });
  if (dup) {
    return res.status(409).json({ error: `Já existe um cadastro com esse ${dup.campo} nesta rede (${dup.nome}). Se você acha que isso é um engano, fale com quem enviou o link.` });
  }

  // Respeita o limite de indicados que o candidato configurou para o nível de
  // quem enviou o link (mesma regra do cadastro autenticado).
  const limites = await limitesDoCandidato(candidatoId);
  const limite = limites[nivelConvite];
  const { rows: countRows } = await pool.query('SELECT count(*)::int AS c FROM apoiadores WHERE parent_id = $1', [conv.id]);
  if (limite && countRows[0].c >= limite) {
    return res.status(400).json({ error: `Quem enviou este link já atingiu o limite de ${limite} indicações. Fale com a equipe da campanha.` });
  }

  const loginLimpo = (login || '').trim().toLowerCase();
  if (criaLogin) {
    if (!loginLimpo || !senha) {
      return res.status(400).json({ error: 'Crie um login e uma senha para acessar o sistema.' });
    }
    if (!/^[a-z0-9._-]+$/.test(loginLimpo)) {
      return res.status(400).json({ error: 'Login deve conter apenas letras, números, ponto, hífen ou underline — sem espaços.' });
    }
    if (senha.length < 4) return res.status(400).json({ error: 'A senha precisa ter pelo menos 4 caracteres.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let novoId;
    if (criaLogin) {
      // Vira usuário-com-login (perfil apoiador) que poderá acessar o sistema e
      // recrutar o nível de baixo. A ficha-espelho em "apoiadores" usa o MESMO id
      // do usuário (é o que os indicados dele usarão como parent_id) e fica
      // pendurada sob quem o convidou (parent_id = id de quem enviou o link).
      const senhaHash = await hash(senha);
      const { rows: uRows } = await client.query(
        `INSERT INTO usuarios (nome, login, senha_hash, perfil, criado_por, telefone, regiao, endereco, cidade, estado, titulo, zona, secao, senha_temporaria, termo_versao_aceita)
         VALUES ($1,$2,$3,'apoiador',$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13) RETURNING id`,
        [nome, loginLimpo, senhaHash, candidatoId, telefone, regiao, endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, termoVersaoAtual]
      );
      novoId = uRows[0].id;
      await client.query(
        `INSERT INTO apoiadores (id, nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, zona, secao, nivel, parent_id, cadastrado_por, lgpd_aceite, lgpd_aceite_em, lgpd_versao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,now(),$15)`,
        [novoId, nome, telefone, nascimento, regiao, endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, novoNivel, conv.id, candidatoId, termoVersaoAtual]
      );
      await client.query(
        `INSERT INTO termos_aceite (usuario_id, versao_termo, ip, user_agent) VALUES ($1,$2,$3,$4)`,
        [novoId, termoVersaoAtual, req.ip, req.headers['user-agent'] || null]
      );
    } else {
      // Nível 4 (base): só um contato na pirâmide, sem login.
      const { rows: aRows } = await client.query(
        `INSERT INTO apoiadores (nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, zona, secao, nivel, parent_id, cadastrado_por, lgpd_aceite, lgpd_aceite_em, lgpd_versao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,true,now(),$13) RETURNING id`,
        [nome, telefone, nascimento, regiao, endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, novoNivel, conv.id, termoVersaoAtual]
      );
      novoId = aRows[0].id;
      await client.query(
        `INSERT INTO termos_aceite (apoiador_id, versao_termo, ip, user_agent) VALUES ($1,$2,$3,$4)`,
        [novoId, termoVersaoAtual, req.ip, req.headers['user-agent'] || null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: novoId, criouLogin: criaLogin, login: criaLogin ? loginLimpo : null });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Esse login já está em uso. Escolha outro.' });
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
