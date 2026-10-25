# shellcheck shell=bash
# deploy/lib.sh — helpers shared by the server scripts. Sourced, not run.
#
# Every script runs from the app directory (APP_DIR, default /opt/bcci) and
# reads its settings from the same .env file docker compose uses.

APP_DIR="${APP_DIR:-/opt/bcci}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
# Where the app answers on this server (compose publishes it on localhost only).
APP_URL="${APP_URL:-http://127.0.0.1:3000}"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# envval KEY — one value from .env, surrounding quotes removed. Reads the
# file rather than sourcing it, so a value containing $ or spaces is never
# executed as shell.
envval() {
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%$'\r'}"
  if [[ "$line" == \"*\" || "$line" == \'*\' ]]; then line="${line:1:${#line}-2}"; fi
  printf '%s' "$line"
}

compose() { docker compose --project-directory "$APP_DIR" "$@"; }

# notify TITLE MESSAGE — emails ADMIN_EMAILS through the portal's own mail
# settings. Never fails the caller: an alert that cannot be sent is logged.
notify() {
  local title="$1" message="$2" secret admins payload
  secret="$(envval INTERNAL_API_SECRET)"
  admins="$(envval ADMIN_EMAILS)"
  if [[ -z "$secret" || -z "$admins" ]]; then
    log "alert not emailed (INTERNAL_API_SECRET or ADMIN_EMAILS missing): $title — $message" >&2
    return 0
  fi
  payload="$(jq -n --arg title "$title" --arg message "$message" --arg host "$(hostname)" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg to "$admins" \
    '{type: "ops_alert", to: ($to | split(",") | map(gsub("^\\s+|\\s+$"; ""))), data: {title: $title, message: $message, host: $host, at: $at}}')"
  if ! curl -fsS --max-time 20 -X POST "$APP_URL/api/send-email" \
      -H "Authorization: Bearer $secret" -H 'Content-Type: application/json' \
      --data "$payload" >/dev/null; then
    log "alert email failed to send: $title — $message" >&2
  fi
  return 0
}

# wait_healthy SECONDS — polls /api/health until it answers 200.
wait_healthy() {
  local deadline=$((SECONDS + ${1:-90}))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 5 "$APP_URL/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}
