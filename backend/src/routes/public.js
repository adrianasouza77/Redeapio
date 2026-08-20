const express = require('express');
const pool = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { registrar } = require('../utils/auditoria');
const { validarTituloEleitoral } = require('../utils/tituloEleitoral');
const { buscarDuplicidade } = require('../utils/duplicidade');
const { limitesDoCandidato } = require('../utils/limites');
const { hash } = require('../utils/password');
const { termoVersaoAtual } = require('../config');

const router = express.Router();

// O contexto do convite é normalizado nestes campos para os dois modos de link:
//   nomeRede      nome exibido no formulário público (nome de quem convida / da rede)
//   candidatoId   dono da rede (duplicidade, limites, criado_por)
//   parentId      onde o novo cadastro fica pendurado na pirâmide (null = topo)
//   emissorId     id contra o qual se conta o limite de indicados diretos (null = sem limite)
//   nivelConvite  nível de quem convida (usado só para achar o limite do emissor)
//   novoNivel     nível do novo cadastro (1..4)
//   perfilNovo    'lideranca' (nível 1) ou 'apoiador' (níveis 2..4)
//   cadastradoPor cadastrado_por da ficha em "apoiadores"
//   criaLogin     nível ≤ 3 vira usuário-com-login; nível 4 é só contato

// Modo PESSOAL: link que uma liderança/apoiador compartilha. O novo cadastrado
// entra um nível ABAIXO de quem enviou e fica pendurado nele, respeitando o
// limite de indicados diretos do emissor.
async function contextoConvitePessoal(emissorId) {
  const { rows } = await pool.query(
    "SELECT u.id, u.nome, u.perfil, u.criado_por, a.nivel FROM usuarios u LEFT JOIN apoiadores a ON a.id = u.id WHERE u.id = $1 AND u.perfil IN ('lideranca','apoiador')",
    [emissorId]
  );
  const conv = rows[0];
  if (!conv) return null;

  // O nível de quem convida sai da ficha dele em "apoiadores" (a linha com o
  // MESMO id do usuário). Aqui existia um "?? 2": quando a ficha não existia, o
  // sistema chutava nível 2 e cadastrava todo mundo no nível 3 — inclusive pelo
  // link de quem era nível 3, que deveria gerar nível 4. O chute era invisível
  // (nenhum erro, nenhum aviso) e enchia a pirâmide de gente pendurada num
  // responsável do mesmo nível, o que a própria tela de reorganização recusa
  // depois ("o responsável precisa estar exatamente um nível acima").
  //
  // Sem a ficha não há como saber a posição da pessoa na pirâmide, então o link
  // é recusado com uma mensagem clara em vez de adivinhar. Para descobrir quem
  // está nessa situação: bash scripts/diagnostico-nivel.sh <id>
  const nivelConvite = conv.perfil === 'lideranca' ? 1 : conv.nivel;
  if (!nivelConvite) return { erroFicha: true, nomeRede: conv.nome };

  const novoNivel = nivelConvite + 1;
  if (novoNivel > 4) return { erroNivelMaximo: true, nomeRede: conv.nome };

  return {
    nomeRede: conv.nome,
    candidatoId: conv.criado_por,
    parentId: conv.id,
    emissorId: conv.id,
    nivelConvite,
    novoNivel,
    perfilNovo: 'apoiador',
    cadastradoPor: conv.id,
    criaLogin: novoNivel <= 3,
  };
}

// Modo CANDIDATO: link que o PRÓPRIO candidato gera para um nível específico
// (1 = liderança … 4 = base). O cadastrado entra SEM responsável (topo) e o
// candidato reorganiza a pirâmide depois. Só o candidato cria nível 1.
async function contextoConviteCandidato(candidatoId, nivel) {
  const novoNivel = Number(nivel);
  if (![1, 2, 3, 4].includes(novoNivel)) return null;
  const { rows } = await pool.query(
    "SELECT id, nome FROM usuarios WHERE id = $1 AND perfil = 'candidato'",
    [candidatoId]
  );
  const cand = rows[0];
  if (!cand) return null;
  return {
    nomeRede: cand.nome,
    candidatoId: cand.id,
    parentId: null,
    emissorId: null,
    nivelConvite: novoNivel - 1,
    novoNivel,
    perfilNovo: novoNivel === 1 ? 'lideranca' : 'apoiador',
    cadastradoPor: cand.id,
    criaLogin: novoNivel <= 3,
  };
}

// Resolve o contexto a partir do corpo/params: candidato_id + nivel (modo
// candidato) tem prioridade; senão cai no id de quem enviou (modo pessoal).
async function resolverContexto({ candidatoId, nivel, emissorId }) {
  if (candidatoId) return contextoConviteCandidato(candidatoId, nivel);
  if (emissorId) return contextoConvitePessoal(emissorId);
  return null;
}

// Mensagem única para os dois pontos em que o link pessoal pode estar quebrado,
// escrita para quem vai lê-la no celular: diz o que fazer, não o que houve.
function erroDoContexto(ctx) {
  if (ctx.erroFicha) {
    return `O link de ${ctx.nomeRede} está com um problema de cadastro e não pode ser usado agora `
      + '— quem se cadastrasse por ele entraria no nível errado da rede. '
      + 'Peça o link a outra pessoa da campanha ou avise a coordenação.';
  }
  if (ctx.erroNivelMaximo) {
    return `${ctx.nomeRede} já está no último nível da rede e não pode indicar mais ninguém por link.`;
  }
  return null;
}

router.get('/lideranca/:id', asyncHandler(async (req, res) => {
  const ctx = await contextoConvitePessoal(req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Link inválido.' });
  const erro = erroDoContexto(ctx);
  if (erro) return res.status(409).json({ error: erro });
  res.json({ nome: ctx.nomeRede, versaoTermo: termoVersaoAtual, criaLogin: ctx.criaLogin, novoNivel: ctx.novoNivel });
}));

router.get('/convite', asyncHandler(async (req, res) => {
  const ctx = await contextoConviteCandidato(req.query.candidato, req.query.nivel);
  if (!ctx) return res.status(404).json({ error: 'Link inválido.' });
  res.json({ nome: ctx.nomeRede, versaoTermo: termoVersaoAtual, criaLogin: ctx.criaLogin, novoNivel: ctx.novoNivel });
}));

router.post('/autocadastro', asyncHandler(async (req, res) => {
  const { lideranca_id, candidato_id, nivel, nome, telefone, nascimento, endereco, regiao, cidade, estado, titulo, zona, secao, lgpd_aceite, login, senha } = req.body || {};

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
  if (!lideranca_id && !candidato_id) return res.status(400).json({ error: 'Link de cadastro inválido.' });

  const ctx = await resolverContexto({ candidatoId: candidato_id, nivel, emissorId: lideranca_id });
  if (!ctx) return res.status(400).json({ error: 'Link de cadastro inválido.' });
  // Trava aqui também, e não só na abertura do formulário: quem já estava com a
  // página aberta quando o problema apareceu não pode conseguir gravar.
  const erroCtx = erroDoContexto(ctx);
  if (erroCtx) return res.status(409).json({ error: erroCtx });
  const { candidatoId, parentId, emissorId, nivelConvite, novoNivel, perfilNovo, cadastradoPor, criaLogin } = ctx;

  // Impede a mesma pessoa se autocadastrar duas vezes na rede desse candidato
  // (por engano ou por má-fé) — checa telefone e título de eleitor.
  const dup = await buscarDuplicidade({ candidatoId, telefone, titulo });
  if (dup) {
    return res.status(409).json({ error: `Já existe um cadastro com esse ${dup.campo} nesta rede (${dup.nome}). Se você acha que isso é um engano, fale com quem enviou o link.` });
  }

  // No modo pessoal, respeita o limite de indicados que o candidato configurou
  // para o nível de quem enviou o link (mesma regra do cadastro autenticado).
  // No modo candidato não há um pai único para contar — o limite é aplicado
  // depois, quando o candidato pendura cada cadastro sob um responsável.
  if (emissorId) {
    const limites = await limitesDoCandidato(candidatoId);
    const limite = limites[nivelConvite];
    const { rows: countRows } = await pool.query('SELECT count(*)::int AS c FROM apoiadores WHERE parent_id = $1', [emissorId]);
    if (limite && countRows[0].c >= limite) {
      return res.status(400).json({ error: `Quem enviou este link já atingiu o limite de ${limite} indicações. Fale com a equipe da campanha.` });
    }
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
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,$14) RETURNING id`,
        [nome, loginLimpo, senhaHash, perfilNovo, candidatoId, telefone, regiao, endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, termoVersaoAtual]
      );
      novoId = uRows[0].id;
      // cadastrado_por = QUEM ENVIOU O LINK (ctx.cadastradoPor), não o candidato.
      // Estava gravando candidatoId: o único registro de quem realmente recrutou
      // a pessoa se perdia, e quando alguém repassava o link de outro (erro comum
      // no WhatsApp) não sobrava nenhum rastro para descobrir o pai correto —
      // parent_id já apontava para o dono do link. No modo candidato os dois
      // valores são iguais, então nada muda por lá.
      await client.query(
        `INSERT INTO apoiadores (id, nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, zona, secao, nivel, parent_id, cadastrado_por, lgpd_aceite, lgpd_aceite_em, lgpd_versao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,now(),$15)`,
        [novoId, nome, telefone, nascimento, regiao, endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, novoNivel, parentId, cadastradoPor, termoVersaoAtual]
      );
      await client.query(
        `INSERT INTO termos_aceite (usuario_id, versao_termo, ip, user_agent) VALUES ($1,$2,$3,$4)`,
        [novoId, termoVersaoAtual, req.ip, req.headers['user-agent'] || null]
      );
    } else {
      // Nível 4 (base): só um contato na pirâmide, sem login.
      const { rows: aRows } = await client.query(
        `INSERT INTO apoiadores (nome, telefone, nascimento, regiao, endereco, cidade, estado, titulo, zona, secao, nivel, parent_id, cadastrado_por, lgpd_aceite, lgpd_aceite_em, lgpd_versao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,now(),$14) RETURNING id`,
        [nome, telefone, nascimento, regiao, endereco || null, cidade || null, estado || null, titulo || null, zona || null, secao || null, novoNivel, parentId, cadastradoPor, termoVersaoAtual]
      );
      novoId = aRows[0].id;
      await client.query(
        `INSERT INTO termos_aceite (apoiador_id, versao_termo, ip, user_agent) VALUES ($1,$2,$3,$4)`,
        [novoId, termoVersaoAtual, req.ip, req.headers['user-agent'] || null]
      );
    }

    await client.query('COMMIT');
    // O "ator" aqui é a própria pessoa que preencheu o formulário — não há
    // sessão. O candidato do workspace vem do link, não do contexto da
    // requisição, por isso é passado explicitamente.
    await registrar(req, {
      acao: 'apoiador.autocadastro',
      alvoTipo: criaLogin ? 'usuario' : 'apoiador',
      alvoId: novoId,
      alvoNome: nome,
      detalhes: {
        nivel: novoNivel, criou_login: criaLogin, login: criaLogin ? loginLimpo : null,
        convite_de_id: cadastradoPor, convite_de_nome: ctx.nomeRede, responsavel_id: parentId, versao_termo: termoVersaoAtual,
      },
      ator: { id: novoId, nome, perfil: criaLogin ? perfilNovo : null },
      candidatoId,
    });
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
