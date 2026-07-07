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
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_KEY" ]; then
  echo "❌ SUPABASE_URL e/ou SUPABASE_SERVICE_KEY não encontrados."
  echo "   Copie .env.example para .env e preencha esses dois valores,"
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
