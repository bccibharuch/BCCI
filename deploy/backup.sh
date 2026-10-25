#!/usr/bin/env bash
# deploy/backup.sh — one database backup, checked before it is kept.
#
# Writes a compressed pg_dump of the whole portal database (records,
# documents, accounts) to BACKUP_DIR, confirms it can be read back, keeps
# BACKUP_KEEP_DAYS of them, and copies it off this server when BACKUP_REMOTE
# names an rclone remote (e.g. "r2:bcci-backups"). Any failure emails the
# admins. The bcci-backup.timer runs it every 6 hours.
#
#   sudo /opt/bcci/deploy/backup.sh

set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"

BACKUP_DIR="$(envval BACKUP_DIR)"; BACKUP_DIR="${BACKUP_DIR:-/var/backups/bcci}"
KEEP_DAYS="$(envval BACKUP_KEEP_DAYS)"; KEEP_DAYS="${KEEP_DAYS:-14}"
REMOTE="$(envval BACKUP_REMOTE)"
REMOTE_KEEP_DAYS="$(envval BACKUP_REMOTE_KEEP_DAYS)"; REMOTE_KEEP_DAYS="${REMOTE_KEEP_DAYS:-30}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/bcci-$stamp.dump"
partial="$out.partial"

on_error() {
  rm -f "$partial"
  notify "Database backup FAILED" "The backup at $stamp did not complete (line $1). The previous backups are untouched. See: journalctl -u bcci-backup"
}
trap 'on_error $LINENO' ERR

umask 077
mkdir -p "$BACKUP_DIR"

log "dumping database to $out"
compose exec -T db pg_dump -U bcci -d bcci --format=custom --compress=9 > "$partial"

# A dump that pg_restore cannot list is not a backup.
compose exec -T db pg_restore --list < "$partial" > /dev/null
[[ -s "$partial" ]] || { log "dump is empty"; false; }
mv "$partial" "$out"
log "backup ok: $(du -h "$out" | cut -f1)"

find "$BACKUP_DIR" -maxdepth 1 -name 'bcci-*.dump' -mtime +"$KEEP_DAYS" -delete

if [[ -n "$REMOTE" ]]; then
  log "copying off-site to $REMOTE"
  rclone copyto "$out" "$REMOTE/$(basename "$out")"
  rclone delete --min-age "${REMOTE_KEEP_DAYS}d" --include 'bcci-*.dump' "$REMOTE"
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/last-success"
