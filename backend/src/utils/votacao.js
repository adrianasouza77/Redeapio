// Onde a pessoa VOTA (briefing "Votos por seção" v2, item 2): município de
// votação pelo código do TSE — pode ser outra cidade da que ela mora — e,
// opcional, o local de votação (escola), escolhido numa lista depois da zona.
// Zona e seção continuam nas colunas de sempre.
//
// Gravado num UPDATE à parte, logo depois do INSERT/UPDATE de cada caminho de
// cadastro, para não mexer na lista de colunas de cada um deles.

const CAMPOS = ['municipio_votacao', 'municipio_votacao_nome', 'local_votacao', 'local_votacao_nome'];

// undefined = o formulário não mandou o campo (tela antiga em cache): não mexe.
function lerVotacao(b = {}) {
  if (!CAMPOS.some((c) => b[c] !== undefined)) return undefined;
  const cod = String(b.municipio_votacao || '').trim();
  const local = String(b.local_votacao || '').trim();
  const temMun = /^\d{5}$/.test(cod);
  const temLocal = /^\d{1,6}$/.test(local);
  return {
    municipio_votacao: temMun ? cod : null,
    municipio_votacao_nome: temMun ? String(b.municipio_votacao_nome || '').trim().slice(0, 80) || null : null,
    local_votacao: temLocal ? local : null,
    local_votacao_nome: temLocal ? String(b.local_votacao_nome || '').trim().slice(0, 160) || null : null,
  };
}

async function gravarVotacao(db, apoiadorId, v) {
  if (!v || !apoiadorId) return;
  await db.query(
    `UPDATE apoiadores SET municipio_votacao = $2, municipio_votacao_nome = $3, local_votacao = $4, local_votacao_nome = $5
      WHERE id = $1`,
    [apoiadorId, v.municipio_votacao, v.municipio_votacao_nome, v.local_votacao, v.local_votacao_nome]
  );
}

module.exports = { lerVotacao, gravarVotacao, CAMPOS_VOTACAO: CAMPOS };
