const pool = require('../db');
const tse = require('./tse');

// Dados do candidato (briefing "Votos por seção" v2, de 05/10/2026, item 1).
// O candidato é cadastrado UMA vez com o que identifica a votação dele no TSE;
// a importação, o relatório Prometido × Entregue e a apuração ao vivo leem
// daqui. O número sozinho não identifica ninguém — repete entre cargos, anos e
// municípios —, por isso a chave é ano + turno + cargo + UF + município + número.

// Cargos que o briefing lista, pelo código do TSE.
const CARGOS = {
  13: 'Vereador',
  11: 'Prefeito',
  7: 'Deputado Estadual',
  6: 'Deputado Federal',
  5: 'Senador',
  3: 'Governador',
};
// Título do cargo como aparece no boletim de urna (é o que a apuração ao vivo usa).
const CARGO_BU = { 13: 'VEREADOR', 11: 'PREFEITO', 7: 'DEPUTADO ESTADUAL', 6: 'DEPUTADO FEDERAL', 5: 'SENADOR', 3: 'GOVERNADOR' };
const MUNICIPAIS = [11, 13];

// Validação do briefing: vereador e dep. estadual = 5 dígitos; dep. federal =
// 4; prefeito, governador e senador = 2 ou 3. (Na urna, senador tem 3 e
// prefeito/governador 2 — o briefing aceita os dois para os três, e assim fica.)
const DIGITOS = { 13: [5], 7: [5], 6: [4], 11: [2, 3], 3: [2, 3], 5: [2, 3] };

function erroNumero(cargo, numero) {
  const ok = DIGITOS[cargo];
  if (!ok) return 'Cargo inválido.';
  if (!/^\d+$/.test(numero) || !ok.includes(numero.length)) {
    const txt = ok.length === 1 ? `${ok[0]} dígitos` : `${ok.join(' ou ')} dígitos`;
    return `Para ${CARGOS[cargo]}, o número do candidato tem ${txt}.`;
  }
  return null;
}

// Abrangência: vereador e prefeito são sempre município único (automático,
// como pede o briefing); os outros cargos escolhem entre municípios-alvo e o
// estado todo.
function abrangenciaValida(cargo, abrangencia) {
  if (MUNICIPAIS.includes(cargo)) return 'municipio';
  return abrangencia === 'municipios' ? 'municipios' : 'estado';
}

// Eleições ordinárias que o TSE publicou, com os cargos do briefing. Ano e
// turno é o que o candidato informa; ciclo/pleito/eleição são os códigos do
// TSE que a importação precisa — resolvidos aqui, para ninguém digitar código.
async function eleicoesOrdinarias() {
  const pleitos = await tse.listarPleitos();
  const out = [];
  for (const p of pleitos) {
    if (!p.eleicoes.some((e) => /ordin/i.test(e.nome))) continue;
    const eleicoes = await tse.eleicoesDoPleito(p.ciclo, p.pleito);
    const ordin = eleicoes.filter((e) => /ordin/i.test(e.nome));
    if (!ordin.length) continue;
    const cargos = [];
    for (const e of ordin) {
      for (const c of e.cargos) {
        if (CARGOS[c.cod]) cargos.push({ cod: c.cod, nome: CARGOS[c.cod], eleicao: e.codigo, municipal: MUNICIPAIS.includes(c.cod) });
      }
    }
    if (!cargos.length) continue;
    out.push({
      ano: Number(String(p.ciclo).replace(/\D/g, '')), turno: ordin[0].turno,
      ciclo: p.ciclo, pleito: String(p.pleito), data: p.data, cargos,
    });
  }
  out.sort((a, b) => b.ano - a.ano || a.turno - b.turno);
  return out;
}

async function resolverEleicao(ano, turno, cargo) {
  const lista = await eleicoesOrdinarias().catch(() => []);
  const p = lista.find((x) => x.ano === ano && x.turno === turno && x.cargos.some((c) => c.cod === cargo));
  if (!p) return null;
  const c = p.cargos.find((x) => x.cod === cargo);
  return { ciclo: p.ciclo, pleito: p.pleito, eleicao: c.eleicao };
}

async function carregarDados(candidatoId) {
  const { rows } = await pool.query(
    `SELECT d.*, u.nome AS nome_candidato FROM candidato_dados d JOIN usuarios u ON u.id = d.candidato_id
      WHERE d.candidato_id = $1`, [candidatoId]
  );
  if (!rows[0]) return null;
  const { rows: mun } = await pool.query(
    'SELECT cod_municipio_tse AS codigo, nome FROM candidato_municipios WHERE candidato_id = $1 ORDER BY nome', [candidatoId]
  );
  return { ...rows[0], municipios: mun, cargo_nome: CARGOS[rows[0].cargo] || String(rows[0].cargo) };
}

// O candidato "dono" de uma pessoa da rede: quem tem login foi criado direto
// pelo candidato (criado_por), e quem não tem foi cadastrado por alguém com
// login (cadastrado_por) — que é o candidato ou foi criado por ele.
async function candidatoDaPessoa(apoiadorId) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN c.perfil = 'candidato' THEN c.id ELSE c.criado_por END AS candidato_id
       FROM apoiadores a
       JOIN usuarios c ON c.id = COALESCE((SELECT criado_por FROM usuarios WHERE id = a.id), a.cadastrado_por)
      WHERE a.id = $1`, [apoiadorId]
  );
  return rows[0]?.candidato_id || null;
}

// Candidato da rede de quem está logado (o próprio, o do workspace aberto, ou
// o que criou a liderança/apoiador).
function candidatoDoPedido(req) {
  if (req.effectivePerfil === 'candidato') return req.effectiveId;
  if (req.user.perfil === 'lideranca' || req.user.perfil === 'apoiador') return req.user.criado_por;
  return null;
}

module.exports = {
  CARGOS, CARGO_BU, MUNICIPAIS, DIGITOS, erroNumero, abrangenciaValida,
  eleicoesOrdinarias, resolverEleicao, carregarDados, candidatoDaPessoa, candidatoDoPedido,
};
