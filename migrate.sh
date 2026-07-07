#!/bin/bash
# =============================================================
# migrate.sh — Migra os dados do Supabase para o Postgres novo
#
# Rode isso UMA ÚNICA VEZ, no servidor, depois que a stack "redeapoio"
# já estiver rodando no Portainer.
#
# Uso:
#   1. Copie .env.example para .env nesta pasta e preencha
#      SUPABASE_URL e SUPABASE_SERVICE_KEY (a service_role key antiga).
#   2. bash migrate.sh
# =============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
  # Lê o .env linha a linha em vez de dar "source" nele — "source" executa o
  # arquivo como script bash, e valores com caracteres especiais (/, {, }, $,
  # crase etc., comuns em senhas/segredos gerados aleatoriamente) quebram a
  # interpretação. Isso aqui só atribui KEY=VALUE literalmente, sem executar nada.
  while IFS='=' read -r key value; do
    key="${key%$'\r'}"; value="${value%$'\r'}"
    # remove espaços em volta da chave (ex: "SUPABASE_URL = valor" editado à mão)
    key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
    [[ -z "$key" || "$key" == \#* ]] && continue
    value="${value# }"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
  done < .env
fi

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_KEY" ]; then
  echo "❌ SUPABASE_URL e/ou SUPABASE_SERVICE_KEY não encontrados."
  echo ""
  if [ -f .env ]; then
    echo "   Chaves encontradas em .env (valores ocultos):"
    sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/  - \1/' .env | grep '^  -' || echo "   (nenhuma linha KEY=valor reconhecida)"
  else
    echo "   Nenhum arquivo .env encontrado nesta pasta ($SCRIPT_DIR)."
  fi
  echo ""
  echo "   Copie .env.example para .env e preencha SUPABASE_URL e SUPABASE_SERVICE_KEY,"
  echo "   ou exporte-os no terminal antes de rodar este script."
  exit 1
fi

CONTAINER=$(docker ps -q -f "name=redeapoio_redeapoio-app")
if [ -z "$CONTAINER" ]; then
  echo "❌ Container do app (redeapoio_redeapoio-app) não encontrado."
  echo "   Confirme que a stack 'redeapoio' está no ar no Portainer."
  exit 1
fi

echo "▶ Rodando migração dentro do container $CONTAINER..."
echo ""
docker exec \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
  "$CONTAINER" node scripts/migrate-from-supabase.js

echo ""
echo "✅ Migração concluída. Se apareceu uma senha temporária do admin acima, anote-a agora."
