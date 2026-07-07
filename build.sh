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
echo "Próximo passo: suba a stack pelo Portainer usando o docker-compose.yml"
echo "Não esqueça de configurar as variáveis de ambiente no Portainer:"
echo "  DOMAIN      = app.redeapoiopolitico.com.br"
echo "  DB_PASSWORD = (senha forte)"
echo "  JWT_SECRET  = (string aleatória longa, mínimo 32 caracteres — gere com: openssl rand -hex 32)"
