#!/usr/bin/env bash
# deploy/restore.sh — replaces the database with a backup.
#
#   sudo /opt/bcci/deploy/restore.sh /var/backups/bcci/bcci-20261025T060000Z.dump
#   sudo /opt/bcci/deploy/restore.sh latest
#
# Takes a fresh safety backup first, stops the app so nothing writes during
# the restore, restores, starts the app and waits for it to report healthy.

set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"

BACKUP_DIR="$(envval BACKUP_DIR)"; BACKUP_DIR="${BACKUP_DIR:-/var/backups/bcci}"
file="${1:-}"
[[ -n "$file" ]] || die "usage: restore.sh <backup.dump | latest>"
if [[ "$file" == latest ]]; then
  file="$(find "$BACKUP_DIR" -maxdepth 1 -name 'bcci-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2- || true)"
  [[ -n "$file" ]] || die "no backups found in $BACKUP_DIR"
fi
[[ -f "$file" ]] || die "backup not found: $file"
compose exec -T db pg_restore --list < "$file" > /dev/null || die "$file is not a readable pg_dump archive"

if [[ "${RESTORE_CONFIRM:-}" != yes ]]; then
  read -r -p "Replace the live database with $(basename "$file")? Type 'yes': " answer
  [[ "$answer" == yes ]] || die "cancelled, nothing changed"
fi

log "taking a safety backup of the current database first"
"$(dirname "$0")/backup.sh"

log "stopping the app"
compose stop app

log "restoring $file"
compose exec -T db pg_restore -U bcci -d bcci --clean --if-exists --no-owner --single-transaction < "$file"

log "starting the app"
compose start app
wait_healthy 120 || die "the app did not become healthy after the restore — check: docker compose logs app"
log "restore complete"
