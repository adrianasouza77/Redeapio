#!/bin/bash
# =============================================================
# migrate.sh — Migra os dados do Supabase para o Postgres novo
#
# Rode isso UMA ÚNICA VEZ, no servidor, depois que a stack "redeapoio"
# já estiver rodando no Portainer.
#
# Pré-requisito: SUPABASE_URL e SUPABASE_SERVICE_KEY precisam estar
# cadastradas nas Environment Variables da stack no Portainer (junto com
# DOMAIN/DB_PASSWORD/JWT_SECRET) — não precisa de nenhum arquivo .env aqui,
# o container já recebe tudo do Portainer.
#
# Uso:
#   bash migrate.sh
#
# Depois de rodar com sucesso: remova SUPABASE_URL/SUPABASE_SERVICE_KEY das
# variáveis da stack no Portainer e rotacione a service_role key no Supabase
# — elas não servem para mais nada depois da migração.
# =============================================================

set -e

CONTAINER=$(docker ps -q -f "name=redeapoio_redeapoio-app")
if [ -z "$CONTAINER" ]; then
  echo "❌ Container do app (redeapoio_redeapoio-app) não encontrado."
  echo "   Confirme que a stack 'redeapoio' está no ar no Portainer."
  exit 1
fi

FALTANDO=$(docker exec "$CONTAINER" sh -c '[ -z "$SUPABASE_URL" ] && echo SUPABASE_URL; [ -z "$SUPABASE_SERVICE_KEY" ] && echo SUPABASE_SERVICE_KEY; true')
if [ -n "$FALTANDO" ]; then
  echo "❌ Variável(is) ausente(s) no container: $FALTANDO"
  echo "   Adicione em Portainer → Stacks → redeapoio → Editor → Environment variables,"
  echo "   depois clique em 'Update the stack' antes de rodar este script de novo."
  exit 1
fi

echo "▶ Rodando migração dentro do container $CONTAINER..."
echo ""
docker exec "$CONTAINER" node scripts/migrate-from-supabase.js

echo ""
echo "✅ Migração concluída. Se apareceu uma senha temporária do admin acima, anote-a agora."
echo "   Próximo passo: remova SUPABASE_URL/SUPABASE_SERVICE_KEY da stack no Portainer"
echo "   e rotacione a service_role key no Supabase."
