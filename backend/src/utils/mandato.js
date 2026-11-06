const crypto = require('crypto');
const pool = require('../db');

// Módulo Mandato (briefing de novembro/2026). Concentra aqui as três perguntas
// que toda rota do mandato faz antes de qualquer coisa:
//   1) de qual vereador (candidato) é o mandato que esta pessoa está vendo;
//   2) o módulo foi contratado (é cobrado à parte);
//   3) o que esta pessoa pode fazer nele.
//
// O briefing pedia isso como RLS do Supabase. Aqui não existe RLS: o servidor
// é a única porta para o banco, então a trava mora no servidor, como no resto
// do sistema. Nenhuma rota do mandato lê req.user.id para decidir de quem é o
// dado — sempre req.mandato.candidatoId.

const MODULOS = ['demandas', 'agenda', 'proposicoes', 'emendas', 'trabalhos', 'enquetes', 'prestacao_contas', 'pagina_publica'];
const VISIBILIDADES = ['interno', 'rede', 'publico'];

// Papéis dentro do mandato:
//   vereador → o próprio candidato, ou o admin/Coordenador Geral atuando como ele (?as=)
//   chefe    → Chefe de Gabinete: tudo o que a equipe faz + visibilidade e aprovação de minuta
//   equipe   → Equipe do Gabinete: atende demandas, agenda, cadastros do mandato
//   rede     → Líder, Coordenador e Mobilizador com login: só o que o vereador abriu para a rede
function papelDe(req) {
  if (req.effectivePerfil === 'candidato') return 'vereador';
  if (req.user.perfil === 'chefe_gabinete') return 'chefe';
  if (req.user.perfil === 'assessor') return 'equipe';
  if (req.user.perfil === 'lideranca' || req.user.perfil === 'apoiador') return 'rede';
  return null;
}

function candidatoDoPapel(req, papel) {
  if (papel === 'vereador') return req.effectiveId;
  // Equipe do gabinete e rede foram criadas pelo candidato (usuarios.criado_por).
  return req.user.criado_por || null;
}

async function moduloAtivo(candidatoId) {
  if (!candidatoId) return false;
  const { rows } = await pool.query(
    "SELECT modulo_mandato FROM usuarios WHERE id = $1 AND perfil = 'candidato'", [candidatoId]
  );
  return !!rows[0]?.modulo_mandato;
}

// Sem linha = interno, que é o padrão de todo módulo (regra 1 do briefing).
async function visibilidades(candidatoId) {
  const { rows } = await pool.query(
    'SELECT modulo, visibilidade, atualizado_em FROM mandato_visibilidade WHERE candidato_id = $1', [candidatoId]
  );
  const mapa = Object.fromEntries(MODULOS.map((m) => [m, 'interno']));
  for (const r of rows) mapa[r.modulo] = r.visibilidade;
  return mapa;
}

// Middleware das rotas autenticadas do mandato. Depois dele, req.mandato tem
// { candidatoId, papel, equipe, podeConfigurar, vis }.
async function contextoMandato(req, res, next) {
  const papel = papelDe(req);
  if (!papel) return res.status(403).json({ error: 'O Módulo Mandato não está disponível para o seu perfil.' });
  const candidatoId = candidatoDoPapel(req, papel);
  if (!(await moduloAtivo(candidatoId))) {
    return res.status(403).json({ error: 'O Módulo Mandato não foi contratado para este vereador. Fale com o suporte para ativar.', semModulo: true });
  }
  const vis = await visibilidades(candidatoId);
  req.mandato = {
    candidatoId,
    papel,
    equipe: papel !== 'rede',
    podeConfigurar: papel === 'vereador' || papel === 'chefe',
    // Aprovar minuta de IA é decisão de quem responde pelo mandato (regra 7).
    podeAprovar: papel === 'vereador' || papel === 'chefe',
    vis,
  };
  next();
}

// Só a equipe do gabinete (vereador, chefe, equipe).
function soEquipe(req, res, next) {
  if (!req.mandato?.equipe) return res.status(403).json({ error: 'Só a equipe do gabinete pode fazer isso.' });
  next();
}

// A rede só alcança um módulo se o vereador o abriu para a rede (ou para o
// público, que inclui a rede). Para a equipe, sempre passa.
function abertoParaRede(req, modulo) {
  return req.mandato.equipe || ['rede', 'publico'].includes(req.mandato.vis[modulo]);
}

function exigeAbertoParaRede(modulo) {
  return (req, res, next) => {
    if (!abertoParaRede(req, modulo)) {
      return res.status(403).json({ error: 'Este módulo do mandato não está aberto para a rede.' });
    }
    next();
  };
}

// Endereço curto da página pública (vai no QR Code). Sem 0/O/1/l/I para quem
// for digitar o endereço de um cartaz.
const LETRAS = 'abcdefghjkmnpqrstuvwxyz23456789';
function novoCodigoPublico() {
  const b = crypto.randomBytes(8);
  return [...b].map((x) => LETRAS[x % LETRAS.length]).join('');
}

// Linha de configuração, criada na primeira leitura (com o nome do candidato
// como nome público e um código de página).
async function configDoMandato(candidatoId) {
  const { rows } = await pool.query('SELECT * FROM mandato_config WHERE candidato_id = $1', [candidatoId]);
  if (rows[0]) return rows[0];
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      const { rows: novo } = await pool.query(
        `INSERT INTO mandato_config (candidato_id, codigo_publico, nome_publico)
         SELECT $1, $2, COALESCE(d.nome_urna, u.nome) FROM usuarios u
           LEFT JOIN candidato_dados d ON d.candidato_id = u.id
          WHERE u.id = $1
         ON CONFLICT (candidato_id) DO NOTHING RETURNING *`,
        [candidatoId, novoCodigoPublico()]
      );
      if (novo[0]) return novo[0];
      const { rows: outra } = await pool.query('SELECT * FROM mandato_config WHERE candidato_id = $1', [candidatoId]);
      if (outra[0]) return outra[0];
    } catch (err) {
      if (err.code !== '23505') throw err; // código repetido: sorteia outro
    }
  }
  throw new Error('Não foi possível criar a configuração do mandato.');
}

// Limite de pedidos por IP, em memória. Serve para o canal público (sem login)
// não virar porta de spam — o briefing pede limite por IP antes de abrir ao
// cidadão. Em memória basta: o app roda num container só, e reiniciar zera a
// contagem, o que é aceitável para um limite de minutos.
const janelas = new Map();
function limitarPorChave(chave, maximo, janelaMs) {
  const agora = Date.now();
  const lista = (janelas.get(chave) || []).filter((t) => agora - t < janelaMs);
  if (lista.length >= maximo) { janelas.set(chave, lista); return false; }
  lista.push(agora);
  janelas.set(chave, lista);
  if (janelas.size > 20000) {
    for (const [k, v] of janelas) if (!v.some((t) => agora - t < janelaMs)) janelas.delete(k);
  }
  return true;
}

// Captcha (Cloudflare Turnstile), quando configurado no Portainer. Sem a
// variável, o canal público fica só com limite por IP, campo-isca e tempo
// mínimo de preenchimento — a tela de visibilidade avisa que falta o captcha.
const captchaConfigurado = () => Boolean(process.env.TURNSTILE_SECRET && process.env.TURNSTILE_SITEKEY);
async function conferirCaptcha(token, ip) {
  if (!captchaConfigurado()) return true;
  if (!token) return false;
  try {
    const corpo = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET, response: String(token) });
    if (ip) corpo.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: corpo });
    const j = await r.json();
    return !!j.success;
  } catch {
    return false;
  }
}

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Texto livre que chega do navegador: corta no tamanho e tira espaço sobrando.
function texto(v, max) {
  if (v === undefined || v === null) return null;
  const t = String(v).replace(/\u0000/g, '').trim();
  return t ? t.slice(0, max) : null;
}

module.exports = {
  MODULOS, VISIBILIDADES, papelDe, moduloAtivo, visibilidades, contextoMandato, soEquipe,
  abertoParaRede, exigeAbertoParaRede, configDoMandato, novoCodigoPublico, limitarPorChave,
  captchaConfigurado, conferirCaptcha, sha256, texto,
};
