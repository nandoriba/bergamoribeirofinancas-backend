#!/usr/bin/env bash
# Backup diário do Postgres do sistema financeiro.
# Instalar em /app/scripts/backup-postgres.sh e agendar via cron:
#   0 3 * * * /app/scripts/backup-postgres.sh >> /var/log/financas-backup.log 2>&1
set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
BACKUP_DIR="${APP_DIR}/backups"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
COMPOSE_FILE="${APP_DIR}/docker-compose.yml"

# Carrega variáveis (POSTGRES_DB, POSTGRES_USER) do .env do compose
set -a
# shellcheck disable=SC1091
source "${APP_DIR}/.env"
set +a

mkdir -p "${BACKUP_DIR}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
FILE="${BACKUP_DIR}/financas-${TIMESTAMP}.sql.gz"

echo "[$(date -Iseconds)] Iniciando backup -> ${FILE}"

docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --no-owner --clean --if-exists \
  | gzip > "${FILE}"

# Retenção
find "${BACKUP_DIR}" -name 'financas-*.sql.gz' -type f -mtime +"${RETENTION_DAYS}" -delete

echo "[$(date -Iseconds)] Backup concluído. Arquivos atuais:"
ls -lh "${BACKUP_DIR}" | tail -n +2
