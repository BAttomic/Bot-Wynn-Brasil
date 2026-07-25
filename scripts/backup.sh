#!/bin/sh
# Backup do MongoDB via mongodump. Agende no Easypanel (Scheduled Task / cron),
# ex.: diariamente às 03:00. Requer as variáveis MONGO_URI e MONGO_DB.
#
# Uso: MONGO_URI=... MONGO_DB=wynn_guild BACKUP_DIR=/backups sh scripts/backup.sh

set -e

: "${MONGO_URI:?defina MONGO_URI}"
: "${MONGO_DB:=wynn_guild}"
: "${BACKUP_DIR:=/backups}"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/${MONGO_DB}-${STAMP}"

mkdir -p "$OUT"
mongodump --uri="$MONGO_URI" --db="$MONGO_DB" --gzip --out="$OUT"

# Mantém apenas os 14 backups mais recentes.
ls -1dt "${BACKUP_DIR}/${MONGO_DB}-"* | tail -n +15 | xargs -r rm -rf

echo "Backup concluído em $OUT"
