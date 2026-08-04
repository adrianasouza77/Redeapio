#!/bin/bash
# =============================================================
# backup-db.sh — Backup do Postgres do RedeApoio
#
# Roda NO HOST (não dentro de container). Gera um dump no formato custom
# do Postgres (-Fc), que já vem comprimido e permite restaurar tabelas
# separadamente se precisar.
#
# Uso manual:
#   bash scripts/backup-db.sh
#
# Uso no cron (todo dia às 3h da manhã):
#   sudo crontab -e
#   0 3 * * * /opt/redeapoiopolitico/scripts/backup-db.sh >> /var/log/redeapoio-backup.log 2>&1
#
# Variáveis que dá para sobrescrever:
#   DEST            pasta dos backups          (padrão /var/backups/redeapoio)
#   RETENCAO_DIAS   dias de retenção do diário (padrão 30)
#   SERVICE         nome do serviço no Swarm   (padrão redeapoio_redeapoio-postgres)
#   DB_NAME/DB_USER                            (padrão redeapoio/redeapoio)
# =============================================================

set -euo pipefail

DEST="${DEST:-/var/backups/redeapoio}"
RETENCAO_DIAS="${RETENCAO_DIAS:-30}"
SERVICE="${SERVICE:-redeapoio_redeapoio-postgres}"
DB_NAME="${DB_NAME:-redeapoio}"
DB_USER="${DB_USER:-redeapoio}"

CARIMBO="$(date +%Y-%m-%d_%H%M)"
ARQUIVO="$DEST/redeapoio-$CARIMBO.dump"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "=== Backup RedeApoio iniciado ==="

mkdir -p "$DEST"

# Em Swarm o container real se chama <stack>_<servico>.1.<hash>, então o filtro
# por prefixo do nome resolve. head -n1 protege contra sobras de containers
# antigos ainda listados durante um redeploy.
CID="$(docker ps -q -f "name=${SERVICE}" 2>/dev/null | head -n1 || true)"
if [ -z "$CID" ]; then
  log "ERRO: container do Postgres ($SERVICE) não encontrado."
  log "      Confirme com: docker service ls | grep redeapoio"
  exit 1
fi
log "Container do Postgres: $CID"

# O dump sai pela stdout do container e é gravado direto no host — não ocupa
# espaço dentro do container nem depende de volume compartilhado.
if ! docker exec "$CID" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$ARQUIVO"; then
  log "ERRO: pg_dump falhou. Backup incompleto removido."
  rm -f "$ARQUIVO"
  exit 1
fi

# Um pg_dump que "funcionou" mas gerou um arquivo vazio/truncado é pior que
# nenhum backup, porque passa a falsa sensação de estar protegido. Duas
# verificações: tamanho mínimo plausível e o próprio Postgres conseguir ler o
# índice do arquivo.
TAMANHO="$(stat -c%s "$ARQUIVO")"
if [ "$TAMANHO" -lt 2048 ]; then
  log "ERRO: dump com apenas ${TAMANHO} bytes — algo deu errado. Arquivo removido."
  rm -f "$ARQUIVO"
  exit 1
fi

if ! docker exec -i "$CID" pg_restore -l > /dev/null < "$ARQUIVO"; then
  log "ERRO: o dump gerado não passou na verificação de integridade. Arquivo removido."
  rm -f "$ARQUIVO"
  exit 1
fi

TABELAS="$(docker exec -i "$CID" pg_restore -l < "$ARQUIVO" | grep -c 'TABLE DATA' || true)"
log "OK: $ARQUIVO ($(numfmt --to=iec "$TAMANHO" 2>/dev/null || echo "${TAMANHO}B"), $TABELAS tabelas com dados)"

# Arquivo do dia 1º de cada mês vira cópia mensal permanente — protege contra o
# caso em que um problema só é percebido meses depois (ex: exclusão em massa
# feita por engano que ninguém notou na hora).
if [ "$(date +%d)" = "01" ]; then
  MENSAL="$DEST/mensal"
  mkdir -p "$MENSAL"
  cp "$ARQUIVO" "$MENSAL/redeapoio-$(date +%Y-%m).dump"
  log "Cópia mensal guardada em $MENSAL/redeapoio-$(date +%Y-%m).dump"
fi

# Retenção: só limpa os diários da pasta raiz. A pasta mensal/ nunca é tocada.
APAGADOS="$(find "$DEST" -maxdepth 1 -name 'redeapoio-*.dump' -mtime "+$RETENCAO_DIAS" -print -delete 2>/dev/null | wc -l || true)"
[ "$APAGADOS" -gt 0 ] && log "Removidos $APAGADOS backups com mais de $RETENCAO_DIAS dias."

log "=== Backup concluído ==="

# ── Cópia para fora do servidor (RECOMENDADO) ────────────────────────────
# Backup que só existe no mesmo servidor do banco não protege contra o cenário
# mais comum de perda total: o servidor em si morrer ou ser apagado. Descomente
# UMA das opções abaixo depois de configurar a credencial correspondente.
#
# Opção A — outro servidor via SSH (precisa de chave SSH sem senha):
#   scp "$ARQUIVO" usuario@ip-do-outro-servidor:/backups/redeapoio/
#
# Opção B — storage compatível com S3 / Google Drive / OneDrive via rclone
#   (instale com: curl https://rclone.org/install.sh | sudo bash; depois: rclone config):
#   rclone copy "$ARQUIVO" remoto:backups/redeapoio/
