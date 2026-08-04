#!/bin/bash
# =============================================================
# restore-db.sh — Restaura um backup do RedeApoio no Postgres
#
# USE COM ATENÇÃO: isso APAGA os dados atuais do banco e coloca os do
# arquivo no lugar. É o script usado tanto para "voltar no tempo" quanto
# para levar os dados de um servidor para outro.
#
# Uso:
#   bash scripts/restore-db.sh /var/backups/redeapoio/redeapoio-2026-08-04_0300.dump
#
# O que ele faz, nesta ordem:
#   1. Confere que o arquivo é um dump válido do Postgres
#   2. Tira o app do ar (escala para 0) — ninguém escreve durante a restauração
#   3. Faz um backup de segurança do estado ATUAL, antes de sobrescrever
#   4. Restaura o arquivo (--clean --if-exists derruba e recria cada objeto)
#   5. Sobe o app de volta e confere as contagens
# =============================================================

set -euo pipefail

ARQUIVO="${1:-}"
SERVICE_DB="${SERVICE_DB:-redeapoio_redeapoio-postgres}"
SERVICE_APP="${SERVICE_APP:-redeapoio_redeapoio-app}"
DB_NAME="${DB_NAME:-redeapoio}"
DB_USER="${DB_USER:-redeapoio}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

if [ -z "$ARQUIVO" ]; then
  echo "Uso: bash scripts/restore-db.sh <arquivo.dump>"
  echo ""
  echo "Backups disponíveis:"
  ls -lh /var/backups/redeapoio/*.dump 2>/dev/null || echo "  (nenhum em /var/backups/redeapoio)"
  exit 1
fi

[ -f "$ARQUIVO" ] || { echo "ERRO: arquivo não encontrado: $ARQUIVO"; exit 1; }

CID="$(docker ps -q -f "name=${SERVICE_DB}" 2>/dev/null | head -n1 || true)"
if [ -z "$CID" ]; then
  echo "ERRO: container do Postgres ($SERVICE_DB) não encontrado."
  exit 1
fi

# Valida ANTES de destruir qualquer coisa. Restaurar um arquivo corrompido
# depois de já ter apagado o banco é o pior desfecho possível.
log "Verificando o arquivo..."
if ! docker exec -i "$CID" pg_restore -l > /dev/null < "$ARQUIVO"; then
  echo "ERRO: '$ARQUIVO' não é um dump válido do Postgres (ou está corrompido)."
  exit 1
fi
TABELAS="$(docker exec -i "$CID" pg_restore -l < "$ARQUIVO" | grep -c 'TABLE DATA' || true)"
log "Arquivo válido — $TABELAS tabelas com dados."

echo ""
echo "  ⚠  Isto vai APAGAR os dados atuais do banco '$DB_NAME' e substituí-los"
echo "     pelo conteúdo de: $ARQUIVO"
echo ""
read -r -p "  Digite RESTAURAR (em maiúsculas) para confirmar: " CONFIRMA
[ "$CONFIRMA" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }

# ── 1. Tira o app do ar ─────────────────────────────────────
log "Parando o app (escalando para 0)..."
docker service scale "${SERVICE_APP}=0" >/dev/null
sleep 5

# ── 2. Rede de segurança ────────────────────────────────────
SEGURANCA="/var/backups/redeapoio/ANTES-DA-RESTAURACAO-$(date +%Y-%m-%d_%H%M).dump"
mkdir -p "$(dirname "$SEGURANCA")"
log "Guardando o estado atual em $SEGURANCA ..."
docker exec "$CID" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$SEGURANCA" || {
  log "AVISO: não consegui salvar o estado atual. Abortando por segurança."
  docker service scale "${SERVICE_APP}=1" >/dev/null
  exit 1
}

# ── 3. Restaura ─────────────────────────────────────────────
# --clean --if-exists: derruba cada objeto antes de recriar, sem reclamar dos
# que não existem. --no-owner: ignora o dono gravado no dump (o papel do banco
# é o mesmo nos dois servidores, mas isso evita erro se algum dia mudar).
# pg_restore devolve código != 0 até por avisos inofensivos, então a saída é
# guardada e conferida depois, em vez de derrubar o script na hora.
log "Restaurando... (avisos de 'does not exist' aqui são normais)"
set +e
docker exec -i "$CID" pg_restore -U "$DB_USER" -d "$DB_NAME" \
  --clean --if-exists --no-owner < "$ARQUIVO" 2>/tmp/restore-erros.txt
CODIGO=$?
set -e
if [ $CODIGO -ne 0 ]; then
  log "pg_restore terminou com avisos (código $CODIGO). Últimas linhas:"
  tail -n 15 /tmp/restore-erros.txt || true
fi

# ── 4. Confere o resultado ──────────────────────────────────
CONTAGENS="$(docker exec "$CID" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT (SELECT count(*) FROM usuarios) || ' usuários / ' ||
          (SELECT count(*) FROM apoiadores) || ' apoiadores / ' ||
          (SELECT count(*) FROM termos_aceite) || ' aceites de termo'" 2>/dev/null || echo "não foi possível contar")"

# ── 5. Sobe o app ───────────────────────────────────────────
log "Subindo o app de volta..."
docker service scale "${SERVICE_APP}=1" >/dev/null

echo ""
echo "✅ Restauração concluída."
echo "   Banco agora tem: $CONTAGENS"
echo "   Backup do estado anterior: $SEGURANCA"
echo ""
echo "   Confira o app no navegador. Se algo estiver errado, dá para voltar com:"
echo "   bash scripts/restore-db.sh $SEGURANCA"
