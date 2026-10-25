#!/usr/bin/env bash
# deploy/setup-vps.sh — turns a fresh Ubuntu 24.04 VPS into the portal's server.
#
#   curl -fsSL https://raw.githubusercontent.com/bccibharuch/BCCI/main/deploy/setup-vps.sh -o setup-vps.sh
#   sudo bash setup-vps.sh
#
# Safe to run again: every step checks before it changes anything.
#
# Installs Docker, a firewall (SSH, HTTP, HTTPS only), fail2ban, automatic
# security updates, swap, the 6-hourly backup timer, and a `deploy` user for
# GitHub Actions. Password SSH login is switched off only when a key login
# already exists, so this script cannot lock you out.
#
# Options (environment variables):
#   REPO_URL       git URL to clone          (default: the BCCI GitHub repo)
#   APP_DIR        where the portal lives    (default: /opt/bcci)
#   DEPLOY_PUBKEY  SSH public key GitHub Actions deploys with (optional)

set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/bccibharuch/BCCI.git}"
APP_DIR="${APP_DIR:-/opt/bcci}"
DEPLOY_USER=deploy

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash setup-vps.sh"
. /etc/os-release
[[ "$ID" == ubuntu ]] || die "this script is for Ubuntu (found $PRETTY_NAME)"

log "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq --no-install-recommends \
  ca-certificates curl git jq rclone ufw fail2ban unattended-upgrades \
  docker.io docker-compose-v2
systemctl enable --now docker

log "Setting the clock to India time"
timedatectl set-timezone Asia/Kolkata

log "Swap"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "2 GB swap file added"
else
  echo "swap already present"
fi

log "Automatic security updates"
cat > /etc/apt/apt.conf.d/52bcci-unattended <<'EOF'
// Security updates install nightly. When one needs a reboot, it happens at
// 03:30 India time; Docker brings the portal back up on its own.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades

log "Firewall: SSH, HTTP and HTTPS only"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed -n '1,12p'

log "fail2ban (blocks repeated SSH password guesses)"
systemctl enable --now fail2ban

log "Deploy user for GitHub Actions"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
if [[ -n "${DEPLOY_PUBKEY:-}" ]]; then
  keys="/home/$DEPLOY_USER/.ssh/authorized_keys"
  touch "$keys"
  grep -qxF "$DEPLOY_PUBKEY" "$keys" || echo "$DEPLOY_PUBKEY" >> "$keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$keys"
  chmod 600 "$keys"
  echo "deploy key installed"
fi

log "SSH hardening"
has_key=false
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [[ -s "$f" ]] && has_key=true
done
if $has_key; then
  cat > /etc/ssh/sshd_config.d/60-bcci.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  if sshd -t; then
    systemctl reload ssh
    echo "password logins disabled (key logins only)"
  else
    rm -f /etc/ssh/sshd_config.d/60-bcci.conf
    echo "sshd rejected the change; left SSH settings as they were"
  fi
else
  echo "WARNING: no SSH key login found, so password login stays ON."
  echo "         Add your public key to ~/.ssh/authorized_keys and run this script again."
fi

log "Portal code in $APP_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone --quiet "$REPO_URL" "$APP_DIR"
else
  echo "already cloned"
fi
git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$APP_DIR" \
  || git config --system --add safe.directory "$APP_DIR"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
chmod +x "$APP_DIR"/deploy/*.sh

log "Settings file $APP_DIR/.env"
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/deploy/env.example" "$APP_DIR/.env"
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" "$APP_DIR/.env"
  sed -i "s|^INTERNAL_API_SECRET=.*|INTERNAL_API_SECRET=$(openssl rand -hex 32)|" "$APP_DIR/.env"
  echo "created with fresh database and internal secrets"
else
  echo "kept the existing file"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

log "Backups every 6 hours"
install -d -m 700 /var/backups/bcci
install -m 644 "$APP_DIR/deploy/systemd/bcci-backup.service" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/systemd/bcci-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bcci-backup.timer
systemctl list-timers bcci-backup.timer --no-pager | sed -n '1,3p'

missing=()
for key in SITE_DOMAIN ADMIN_EMAILS ADMIN_PASSWORD SMTP_HOST SMTP_USER SMTP_PASS; do
  grep -qE "^$key=.+" "$APP_DIR/.env" || missing+=("$key")
done

if (( ${#missing[@]} )); then
  log "Almost done"
  echo "Fill in these settings in $APP_DIR/.env: ${missing[*]}"
  echo "  sudo nano $APP_DIR/.env"
  echo "Then start the portal:"
  echo "  sudo -u $DEPLOY_USER env APP_DIR=$APP_DIR $APP_DIR/deploy/deploy.sh"
else
  log "Starting the portal"
  sudo -u "$DEPLOY_USER" env APP_DIR="$APP_DIR" "$APP_DIR/deploy/deploy.sh"
fi

log "Server setup complete"
