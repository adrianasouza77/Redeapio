#!/bin/bash
# =============================================================
# diagnostico-nivel.sh — Por que o link de fulano cadastrou no nível errado?
#
# SÓ LÊ o banco, não altera nada. Pode rodar em produção com tranquilidade.
#
# Uso (no servidor, a partir de /opt/redeapoiopolitico):
#   bash scripts/diagnostico-nivel.sh c57080f7-83ea-489d-b781-9a8d5de3b6bd
#
# O nível de quem se cadastra por um link pessoal é SEMPRE "o nível de quem
# enviou + 1", e o nível de quem enviou é lido da ficha dele em "apoiadores"
# (a linha cujo id é igual ao id do usuário). Quando essa ficha não existe, o
# sistema não tem como saber a posição da pessoa na pirâmide. Este script
# mostra exatamente qual dos dois casos aconteceu.
# =============================================================

set -euo pipefail

SERVICE="${SERVICE:-redeapoio_redeapoio-postgres}"
DB_NAME="${DB_NAME:-redeapoio}"
DB_USER="${DB_USER:-redeapoio}"

ID="${1:-}"
if [ -z "$ID" ]; then
  echo "Uso: bash scripts/diagnostico-nivel.sh <id-de-quem-enviou-o-link>"
  echo "     (é o valor que aparece depois de 'lideranca=' na URL do link)"
  exit 1
fi

CID="$(docker ps -q -f "name=${SERVICE}" 2>/dev/null | head -n1 || true)"
if [ -z "$CID" ]; then
  echo "ERRO: container do Postgres ($SERVICE) não encontrado."
  echo "      Confirme com: docker service ls | grep redeapoio"
  exit 1
fi

docker exec -i "$CID" psql -U "$DB_USER" -d "$DB_NAME" -v ID="'$ID'" <<'SQL'
\echo '══════════════════════════════════════════════════════════'
\echo ' 1) QUEM ENVIOU O LINK — cadastro de acesso (tabela usuarios)'
\echo '══════════════════════════════════════════════════════════'
SELECT id, nome, login, perfil, criado_por, created_at
FROM usuarios WHERE id = :ID::uuid;

\echo ''
\echo '══════════════════════════════════════════════════════════'
\echo ' 2) A FICHA DELE NA PIRAMIDE (apoiadores com o MESMO id)'
\echo '    Nenhuma linha aqui = a causa do problema.'
\echo '══════════════════════════════════════════════════════════'
SELECT id, nome, nivel, parent_id, cadastrado_por, created_at
FROM apoiadores WHERE id = :ID::uuid;

\echo ''
\echo '══════════════════════════════════════════════════════════'
\echo ' 3) DIAGNOSTICO'
\echo '══════════════════════════════════════════════════════════'
SELECT
  u.nome,
  a.nivel                                   AS nivel_na_ficha,
  COALESCE(a.nivel, 2) + 1                  AS nivel_que_o_link_esta_dando,
  CASE
    WHEN a.id IS NULL THEN
      'FICHA AUSENTE: o sistema nao sabe o nivel dessa pessoa e assume 2, '
      || 'entao o link dela cadastra todo mundo no nivel 3.'
    WHEN u.perfil = 'lideranca' AND a.nivel <> 1 THEN
      'INCOERENTE: perfil lideranca (nivel 1) mas a ficha diz nivel ' || a.nivel || '.'
    ELSE
      'Ficha OK: o link dessa pessoa cadastra no nivel ' || (a.nivel + 1) || '.'
  END AS conclusao
FROM usuarios u
LEFT JOIN apoiadores a ON a.id = u.id
WHERE u.id = :ID::uuid;

\echo ''
\echo '══════════════════════════════════════════════════════════'
\echo ' 4) QUEM JA ENTROU POR ESSE LINK (e em que nivel ficou)'
\echo '══════════════════════════════════════════════════════════'
SELECT nome, nivel, created_at, (parent_id = :ID::uuid) AS pendurado_nele
FROM apoiadores
WHERE parent_id = :ID::uuid OR cadastrado_por = :ID::uuid
ORDER BY created_at DESC LIMIT 20;

\echo ''
\echo '══════════════════════════════════════════════════════════'
\echo ' 5) O PROBLEMA E GERAL? Usuarios com login e SEM ficha na piramide.'
\echo '    Todo mundo desta lista tem um link que cadastra no nivel errado.'
\echo '══════════════════════════════════════════════════════════'
SELECT u.id, u.nome, u.login, u.perfil, u.created_at
FROM usuarios u
LEFT JOIN apoiadores a ON a.id = u.id
WHERE u.perfil IN ('lideranca','apoiador') AND a.id IS NULL
ORDER BY u.created_at;

\echo ''
\echo '══════════════════════════════════════════════════════════'
\echo ' 6) FICHAS COM NIVEL INCOERENTE COM O RESPONSAVEL'
\echo '    (filho tem que ser exatamente 1 nivel abaixo do pai)'
\echo '══════════════════════════════════════════════════════════'
SELECT f.id, f.nome, f.nivel AS nivel_filho, p.nome AS responsavel, p.nivel AS nivel_pai
FROM apoiadores f
JOIN apoiadores p ON p.id = f.parent_id
WHERE f.nivel <> p.nivel + 1
ORDER BY f.created_at DESC LIMIT 50;
SQL
