# BCCI portal — server runbook

Everything runs on one Ubuntu VPS: **Caddy** (HTTPS) → **app** (Node) → **Postgres**.
Postgres holds all of it: applications, documents, events, applicant accounts,
sessions, OTP codes and rate limits. Email goes out through your own SMTP server.

```
visitors ──HTTPS──▶ caddy ──▶ app ──▶ db (Postgres)
                                │
                                └──▶ your SMTP server (OTP, approvals, tickets, alerts)
backups: bcci-backup.timer, every 6 h ──▶ /var/backups/bcci  (+ optional off-site copy)
```

Nothing needs doing day to day. Security updates install themselves, the HTTPS
certificate renews itself, containers restart themselves, and backups run on a
timer. You act when an alert email arrives (section 4).

---

## 1. First-time setup

### 1.1 Buy and reach the server

1. Buy a VPS with **Ubuntu 24.04 LTS** (2+ GB RAM, 40+ GB disk), in India if offered.
2. On your own computer, make an SSH key if you don't have one: `ssh-keygen -t ed25519`
3. Add the public key (`~/.ssh/id_ed25519.pub`) in the VPS provider's panel, or copy it:
   `ssh-copy-id root@<server-ip>`
4. Check you can log in **with the key**: `ssh root@<server-ip>`

### 1.2 Prepare the domain (a day before switching)

In your DNS provider:

- Lower the TTL of the `@` and `www` records to 300 seconds, so the switch later takes minutes, not hours.
- Add `new.bccibharuch.in` → A record → `<server-ip>`. You'll test the server on this name first.

### 1.3 Make a key for GitHub Actions deploys

On your computer:

```bash
ssh-keygen -t ed25519 -f bcci_deploy -N "" -C "github-actions-deploy"
```

You get `bcci_deploy` (private, goes to GitHub) and `bcci_deploy.pub` (public, goes to the server).

### 1.4 Run the setup script on the server

```bash
ssh root@<server-ip>
curl -fsSL https://raw.githubusercontent.com/bccibharuch/BCCI/main/deploy/setup-vps.sh -o setup-vps.sh
DEPLOY_PUBKEY="<paste the contents of bcci_deploy.pub>" bash setup-vps.sh
```

It installs Docker, the firewall, fail2ban, automatic updates and the backup
timer. It also generates the database password and internal secret, and stops
at the settings file.

### 1.5 Fill in the settings

```bash
nano /opt/bcci/.env
```

| Setting | Value |
|---|---|
| `SITE_DOMAIN` | `new.bccibharuch.in` for now; the real domain at switch-over |
| `ALLOWED_ORIGIN` | `https://bccibharuch.in,https://www.bccibharuch.in,https://new.bccibharuch.in` |
| `ADMIN_EMAILS` | Admin sign-in addresses, comma-separated. Alerts go here too. |
| `ADMIN_PASSWORD` | 20+ random characters: `openssl rand -base64 24` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Your SMTP server. Port 465 or 587. |

Start it, and send yourself one of every email to prove SMTP works:

```bash
sudo -u deploy /opt/bcci/deploy/deploy.sh
cd /opt/bcci && docker compose exec app node scripts/test-mail.mjs you@example.com
```

Open `https://new.bccibharuch.in`. The certificate appears within a minute of first start.

### 1.6 Turn on automatic deploys

In GitHub, under **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Variable | `VPS_HOST` | `<server-ip>` |
| Secret | `VPS_SSH_KEY` | contents of `bcci_deploy` (the private key) |
| Secret | `VPS_KNOWN_HOSTS` | output of `ssh-keyscan <server-ip>` run on your computer |

Also create an environment named `production` (Settings → Environments). You
can require an approval there before each deploy.

From now on, every push to `main` that passes the tests deploys itself.
Settings → Actions → "Deploy to VPS" shows each run.

---

## 2. Switching over from Vercel

Do this at a quiet time. It takes about 30 minutes.

1. Tell the secretariat to pause approvals and edits for 30 minutes.
2. Copy everything from Upstash. Take the two values from Vercel → Settings → Environment Variables:

   ```bash
   cd /opt/bcci
   docker compose run --rm -e UPSTASH_REDIS_REST_URL='<url>' -e UPSTASH_REDIS_REST_TOKEN='<token>' \
     app node scripts/migrate-redis-to-postgres.mjs
   ```

   It prints what it copied (applications, enquiries, events, attendees, membership types, accounts). It is safe to run twice.
3. Check a few records in the admin portal on `new.bccibharuch.in`: counts, documents, a member card.
4. Set `SITE_DOMAIN=bccibharuch.in` in `/opt/bcci/.env`, then `sudo -u deploy /opt/bcci/deploy/deploy.sh`.
5. In DNS, point `@` and `www` A records at `<server-ip>`. Remove any Vercel CNAME.
6. Within about 5 minutes, `https://bccibharuch.in` is served by the VPS. Check it shows a fresh certificate.
7. Run the migration command from step 2 once more. It catches anything submitted on Vercel during the switch.
8. In Vercel, disconnect the Git repository so pushes stop deploying there. Keep the Vercel project and Upstash, untouched, for 30 days as a fallback, then delete them.

Everyone will need to sign in again once: sessions are not copied.

---

## 3. Everyday commands

Run these on the server, inside `/opt/bcci`.

| Task | Command |
|---|---|
| Is everything up? | `docker compose ps` and `curl -s localhost:3000/api/health` |
| Live app log | `docker compose logs -f --tail 100 app` |
| Deploy latest main by hand | `sudo -u deploy deploy/deploy.sh` |
| Go back to an earlier version | `sudo -u deploy deploy/deploy.sh <commit>`; find commits with `git log --oneline -20 origin/main` |
| Back up now | `sudo deploy/backup.sh` |
| List backups | `ls -lh /var/backups/bcci` |
| When did the last backup succeed? | `cat /var/backups/bcci/last-success` |
| Backup timer schedule | `systemctl list-timers bcci-backup.timer` |
| Restore a backup | `sudo deploy/restore.sh /var/backups/bcci/<file>.dump`. It takes a safety backup first. |
| Restart everything | `docker compose restart` |
| Disk space | `df -h /` and `docker system df` |

Name the exact file when restoring. `latest` restores the newest backup, and
straight after a restore that is the safety copy.

---

## 4. When an alert email arrives

| Alert | What it means | What to do |
|---|---|---|
| **Site down** (from the uptime monitor) | `/api/health` is not answering 200 | See "Site is down" below. |
| **Database backup FAILED** | A 6-hourly backup did not complete; older backups are fine | `journalctl -u bcci-backup -n 50`. Usually the disk is full (`df -h /`) or the db container is down (`docker compose ps`). Fix it, then `sudo deploy/backup.sh` and check it prints `backup ok`. |
| **Deploy stopped before going live** | The new version failed its start-up check. The site was never affected. | Look at the failed run in GitHub Actions. Fix the code and push again. |
| **Deploy rolled back** | The new version went live, was unhealthy, and the server returned to the last good version within seconds | Same as above: read `docker compose logs app`, fix, push again. |
| **Deploy failed — site may be down** | No healthy version could be restored | Treat it as "Site is down". |

### Site is down

1. `ssh root@<server-ip>`. If you can't reach the server at all, check the VPS provider's status page or panel, and reboot from there.
2. `cd /opt/bcci && docker compose ps`. Each service should be `running` / `healthy`.
3. `curl -s localhost:3000/api/health`. The JSON names the failing part (`postgres`, `smtp`, `adminAuth`).
4. `docker compose logs --tail 100 app` and `docker compose logs --tail 50 db`.
5. Common fixes:
   - **Disk full:** `docker system prune -f`, then delete old files in `/var/backups/bcci` if needed.
   - **A container stopped:** `docker compose up -d`.
   - **Bad release:** `sudo -u deploy deploy/deploy.sh $(cat .last-good)`.
   - **Certificate problem:** `docker compose logs caddy`. Check that DNS still points at this server.

### The server is gone (provider failure, deleted by mistake)

1. Create a new VPS and run section 1.4 on it.
2. Copy `/opt/bcci/.env` back. Keep a copy of it in your password manager for exactly this.
3. Copy the newest backup to the new server: from the off-site copy (`rclone copy`), or from the VPS provider's own backup.
4. `sudo -u deploy deploy/deploy.sh`, then `sudo deploy/restore.sh <file>.dump`.
5. Point DNS at the new IP.

Expect about an hour. You lose at most the changes made since the last backup (up to 6 hours).

---

## 5. Recommended extras (free)

- **Uptime monitor.** UptimeRobot or similar, watching `https://bccibharuch.in/api/health` and alerting two people.
- **Off-site backups.** Without one, backups live on the same server they protect (plus the provider's weekly copy). Cloudflare R2's free tier holds 10 GB:
  1. Create an R2 bucket `bcci-backups` and an API token for it.
  2. `sudo rclone config`: new remote `r2`, type `s3`, provider `Cloudflare`, the token's keys and endpoint.
  3. Set `BACKUP_REMOTE=r2:bcci-backups` in `/opt/bcci/.env`.
  4. `sudo deploy/backup.sh` should now log `copying off-site`.
- **Password manager entry** holding `/opt/bcci/.env`, the server IP, and the provider login.

## 6. Monthly checklist (10 minutes)

- [ ] `cat /var/backups/bcci/last-success` is less than 6 hours old
- [ ] `df -h /` has more than 20% free
- [ ] Every quarter: restore the latest backup onto a scratch server (or locally with Docker) and open the admin portal. A backup only counts once it has been restored.
- [ ] Two people can still log in to the VPS provider, GitHub and the DNS provider
