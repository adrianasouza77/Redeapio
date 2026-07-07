#!/bin/bash
# =============================================================
# build.sh — Builda a imagem Docker no servidor
# Execute via SSH no servidor antes de subir a stack no Portainer
#
# Uso: bash build.sh
# =============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== RedeApoio — Build da Imagem ==="
echo ""

echo "▶ Buildando app (backend + frontend)..."
docker build -t redeapoio-app:latest -f backend/Dockerfile .
echo "✓ Imagem pronta"
echo ""

echo "✅ Imagem buildada com sucesso!"
echo ""
docker images | grep redeapoio-app
echo ""

# O Swarm compara pela tag ("latest"), não pelo conteúdo da imagem — se o
# serviço já estiver rodando, "Update the stack" sozinho NÃO troca o container
# por um com a imagem nova. É preciso forçar.
if docker service ls --format '{{.Name}}' 2>/dev/null | grep -qx "redeapoio_redeapoio-app"; then
  echo "▶ Serviço já está rodando — forçando ele a usar a imagem que acabou de ser buildada..."
  docker service update --force redeapoio_redeapoio-app
  echo "✓ Serviço reiniciado com a imagem nova"
else
  echo "Próximo passo: suba a stack pelo Portainer usando o docker-compose.yml"
  echo "Não esqueça de configurar as variáveis de ambiente no Portainer:"
  echo "  DOMAIN      = app.redeapoiopolitico.com.br"
  echo "  DB_PASSWORD = (senha forte)"
  echo "  JWT_SECRET  = (string aleatória longa, mínimo 32 caracteres — gere com: openssl rand -hex 32)"
fi
