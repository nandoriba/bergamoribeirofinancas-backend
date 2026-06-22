#!/usr/bin/env bash
# Backup diário do Postgres do sistema financeiro.
# Instalar em /app/financeiro/scripts/backup-postgres.sh e agendar via cron:
#   0 3 * * * APP_DIR=/app/financeiro /app/financeiro/scripts/backup-postgres.sh >> /var/log/financas-backup.log 2>&1
set -euo pipefail

APP_DIR="${APP_DIR:-/app/financeiro}"
BACKUP_DIR="${APP_DIR}/backups"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DB_CONTAINER="${DB_CONTAINER:-postgres_db}"

# Carrega variáveis (POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD) do .env
set -a
# shellcheck disable=SC1091
source "${APP_DIR}/.env"
set +a

mkdir -p "${BACKUP_DIR}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
FILE="${BACKUP_DIR}/financas-${TIMESTAMP}.sql.gz"

echo "[$(date -Iseconds)] Iniciando backup -> ${FILE}"

docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" "${DB_CONTAINER}" \
  pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --no-owner --clean --if-exists \
  | gzip > "${FILE}"

# Retenção
find "${BACKUP_DIR}" -name 'financas-*.sql.gz' -type f -mtime +"${RETENTION_DAYS}" -delete

echo "[$(date -Iseconds)] Backup concluído. Arquivos atuais:"
ls -lh "${BACKUP_DIR}" | tail -n +2
