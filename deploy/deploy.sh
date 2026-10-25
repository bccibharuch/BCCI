#!/usr/bin/env bash
# deploy/deploy.sh — updates the running portal to a git ref, safely.
#
#   /opt/bcci/deploy/deploy.sh              # latest origin/main
#   /opt/bcci/deploy/deploy.sh <commit>     # a specific version (e.g. to roll back)
#
# 1. Builds the new version while the current one keeps serving.
# 2. Boots it in a throwaway container; if it crashes or is unhealthy it is
#    never switched in, and the live site is untouched.
# 3. Swaps it in. If it is not healthy within 90 seconds, the server goes
#    back to the last version that was healthy (recorded in .last-good).
# Any failure emails the admins.

set -Eeuo pipefail

# git checkout below rewrites this very file, and bash reads a script as it
# runs it. Run from a private copy so the checkout cannot pull the script out
# from under itself.
if [[ -z "${BCCI_DEPLOY_COPY:-}" ]]; then
  copy="$(mktemp -d)"
  cp "$(dirname "$0")/deploy.sh" "$(dirname "$0")/lib.sh" "$copy/"
  BCCI_DEPLOY_COPY="$copy" exec bash "$copy/deploy.sh" "$@"
fi
trap 'rm -rf "$BCCI_DEPLOY_COPY"' EXIT

source "$BCCI_DEPLOY_COPY/lib.sh"
cd "$APP_DIR"

exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || die "another deploy is already running"

target="${1:-origin/main}"
good_file="$APP_DIR/.last-good"
last_good="$(cat "$good_file" 2>/dev/null || true)"
[[ -n "$last_good" ]] && git cat-file -e "$last_good^{commit}" 2>/dev/null || last_good=""
running="${last_good:0:7}"; running="${running:-the previous version}"

log "fetching"
git fetch --quiet origin
git checkout --quiet --detach "$target"
current="$(git rev-parse HEAD)"
log "building $(git log -1 --format='%h %s')"
compose build app

# Puts the server back on the last healthy version (or reports that there is none).
back_to_last_good() {
  if [[ -z "$last_good" ]]; then
    log "no earlier healthy version is recorded to go back to"
    return 1
  fi
  git checkout --quiet --detach "$last_good"
  compose build app
  compose up -d --remove-orphans
  wait_healthy 90
}

log "smoke-testing the new build"
compose up -d --wait db
if ! compose run --rm --no-deps -T -e PORT=3999 app sh -c '
    node server.js & pid=$!
    for i in $(seq 1 30); do
      sleep 2
      if wget -qO- http://127.0.0.1:3999/api/health >/dev/null 2>&1; then kill $pid; exit 0; fi
      kill -0 $pid 2>/dev/null || exit 1
    done
    kill $pid; exit 1'; then
  if [[ -n "$last_good" ]]; then
    git checkout --quiet --detach "$last_good"
    compose build app >/dev/null
  fi
  notify "Deploy stopped before going live" "Version ${current:0:7} failed its start-up check, so it was never switched in. The site kept running $running the whole time. Check the build before trying again."
  die "${current:0:7} failed the smoke test; the live site was not touched"
fi

# Healthy within SECONDS, giving up at once if the app container crashes —
# a restart loop will not heal itself, so waiting it out is only downtime.
live_healthy() {
  local deadline=$((SECONDS + $1)) id state
  id="$(compose ps -q app)"
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 5 "$APP_URL/api/health" >/dev/null 2>&1; then return 0; fi
    state="$(docker inspect -f '{{.RestartCount}} {{.State.Status}}' "$id" 2>/dev/null || echo "0 missing")"
    if [[ "${state%% *}" != 0 || "${state#* }" == exited || "${state#* }" == missing ]]; then
      log "app container is crashing ($state)"
      return 1
    fi
    sleep 2
  done
  return 1
}

log "switching to ${current:0:7}"
compose up -d --remove-orphans

if live_healthy 90; then
  echo "$current" > "$good_file"
  log "healthy at ${current:0:7}"
  docker image prune -f >/dev/null
  exit 0
fi

log "new version unhealthy after the switch — going back to ${last_good:0:7}"
compose logs --tail 80 app >&2 || true
if back_to_last_good; then
  notify "Deploy rolled back" "Version ${current:0:7} passed its start-up check but was unhealthy once live, so the server went back to ${last_good:0:7}, which is running normally. Check the app log before trying again."
  die "deploy of ${current:0:7} failed; back on ${last_good:0:7}"
fi
notify "Deploy failed — site may be down" "Version ${current:0:7} is unhealthy and no healthy earlier version could be restored. See deploy/RUNBOOK.md, section 'Site is down'."
die "${current:0:7} is unhealthy and nothing healthy could be restored"
