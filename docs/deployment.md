# Home server deployment and recovery

This guide targets Ubuntu 24.04/26.04, Docker Engine + Compose v2, and a single instance of the polling bot. Run commands from your Squad checkout. Do not run two bot instances with the same token. Production data is never used by automated tests. `.env`, backups and logs must not be committed or shared.

## Host and configuration

Install Docker using its [official Ubuntu apt repository instructions](https://docs.docker.com/engine/install/ubuntu/). Install `docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin` after configuring that repository, plus `git curl gzip util-linux`. Verify `docker compose version` and `docker info`. Run Docker commands as a trusted operator (membership in the Docker group grants powerful host access). Keep SSH keys and the host updated; do not publish database, Redis or API ports to the Internet.

For a fresh Ubuntu host without conflicting Docker/containerd packages, the repository setup is:

```sh
sudo apt update
sudo apt install -y ca-certificates curl git gzip util-linux openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
```

Clone the repository, create a private config, then edit it locally:

```sh
git clone https://github.com/ZaleshSultan/team.git squad
cd squad
umask 077
cp .env.example .env
chmod 600 .env
```

Generate a URL-safe 32-byte database password with `openssl rand -hex 32` in a private local terminal, put it in `POSTGRES_PASSWORD` and the host `DATABASE_URL`, and do not paste it into chat/logs. Set `BOT_TOKEN`, `BOT_USERNAME`, optional provider keys, numeric `ADMIN_TELEGRAM_IDS`, and `SUPPORT_CONTACT`. Empty admins disables administration; missing stats keys shows unavailable stats. Use a dedicated development bot for tests. In Compose the API/bot database and Redis addresses are overridden to internal service names; the password is required and must match the initialized PostgreSQL volume. Changing `.env` alone does not change the password in an existing DB role.

Use one HTTPS origin for `MINIAPP_URL`, `PUBLIC_API_URL`, `MINIAPP_ORIGIN`; no trailing path, credentials, query or fragment on the last two. Keep `VITE_API_BASE_URL` blank for same-origin requests. Keep app `PORT=3000`; nginx uses that internal API port. The external local listener is `127.0.0.1:8088` (`APP_PORT` can override it). Defaults and allowed settings are listed in [README](../README.md). Never run `docker compose config` without `--quiet` on a secret-bearing environment; rendered output expands secrets.

For a fresh installation use both Compose files. The production override assigns nginx a fixed private IP and trusts only it at the API. Check that subnet `172.30.75.0/24` does not conflict. If changing it, update the subnet/gateway, nginx fixed IP, API TRUST_PROXY and nginx `set_real_ip_from` together. An existing installation should retain its existing Compose file set until a separately planned network transition; never delete volumes to solve connectivity issues.

```sh
set -euo pipefail
dc() { docker compose -f compose.yaml -f compose.production.yaml "$@"; }
export COMPOSE_FILE=compose.yaml:compose.production.yaml
dc --profile app config --quiet
dc --profile app build api bot miniapp
dc up -d --no-recreate --wait --wait-timeout 120 postgres redis
dc --profile app run --rm --no-deps api pnpm db:migrate
dc --profile app run --rm --no-deps api pnpm db:seed
dc --profile app up -d --wait --wait-timeout 180 api bot miniapp
bash scripts/smoke.sh
docker compose exec -T api node scripts/check-security-headers.mjs http://miniapp
```

For an installation currently using only `compose.yaml`, define `dc() { docker compose -f compose.yaml "$@"; }` and `export COMPOSE_FILE=compose.yaml` instead. Backup/smoke scripts inherit `COMPOSE_FILE` to use the same configuration; set `COMPOSE_PROJECT_NAME` consistently if customized (default project name `squad`). The API hosts stats and request/moderation maintenance workers; the bot hosts notification delivery. Both have restart policies and health checks. API health checks `/ready`; bot health requires active polling plus DB/queue readiness and a fresh heartbeat. Docker marks unhealthy containers but does not itself restart a still-running unhealthy process; investigate health failures, and restart the affected service after correcting its dependency/configuration problem.

## HTTPS and changing a tunnel

For local development tunnel Vite port 5173; for Compose tunnel nginx port 8088:

```sh
cloudflared tunnel --url http://127.0.0.1:8088
# Alternative: ngrok http 8088
```

Use an assigned HTTPS URL in the three URL settings, restart/recreate API and bot, and rebuild the Mini App only if a VITE build setting changed. For Vite also set `DEV_TUNNEL_HOST` to the exact hostname and restart Vite. Quick tunnel URLs are temporary and change after restart; a named tunnel/domain is preferable for a persistent server. Use [Cloudflare's official tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). Cloudflare supplies `CF-Connecting-IP`; nginx accepts it only from the fixed host gateway and discards other forwarding chains. For another host proxy, overwrite `CF-Connecting-IP` with the actual client IP. Do not forward a user-supplied value. Example Caddy host route:

```caddyfile
your.example.com {
    reverse_proxy 127.0.0.1:8088 {
        header_up CF-Connecting-IP {remote_host}
    }
}
```

Do not enable full URL/query access logs on the tunnel/proxy: Steam links and callbacks contain one-time secrets. Set the final URL in BotFather's Mini App and menu settings. Close the old Mini App, send `/start` again, and use the new button; old message buttons can still contain an expired hostname. Steam links already created against an old origin expire; start a new link. The external-browser Steam flow uses a one-use code, hashed callback state and browser binding cookie, then status polling/deep link back; do not tunnel the API alone.

## Update an existing installation (backup first)

Run from a clean checkout on the server. The following example keeps the production override; use the single-file `dc` definition above if that matches your installation. It stops application writers during migration while keeping PostgreSQL/Redis volumes intact. Backup must succeed before updating. Images are built **before** migration so the new schema is applied using the new code.

```sh
set -euo pipefail
dc() { docker compose -f compose.yaml -f compose.production.yaml "$@"; }
test -z "$(git status --porcelain)"
export COMPOSE_FILE=compose.yaml:compose.production.yaml
if test -f scripts/backup.sh; then
    BACKUP_KEEP=14 bash scripts/backup.sh
else
    # First M6 -> M7 update: the new backup script is not in the old checkout.
    umask 077
    mkdir -p backups
    pre_m7_backup="backups/squad-pre-m7-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
    if ! dc exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump --no-password --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null | gzip -c > "$pre_m7_backup"; then
        rm -f -- "$pre_m7_backup"
        printf '%s\n' 'Backup failed; update stopped' >&2
        exit 1
    fi
    gzip -t -- "$pre_m7_backup"
fi
git pull --ff-only origin main
dc --profile app config --quiet
dc --profile app build api bot miniapp
dc up -d --no-recreate --wait --wait-timeout 120 postgres redis
dc --profile app stop bot api miniapp
dc --profile app run --rm --no-deps api pnpm db:migrate
dc --profile app run --rm --no-deps api pnpm db:seed
dc --profile app up -d --force-recreate --wait --wait-timeout 180 api bot miniapp
bash scripts/smoke.sh
dc exec -T api node scripts/check-security-headers.mjs http://miniapp
```

M7 adds migration `202610150001_m7_moderation`. It changes legacy report reason/comment fields and adds moderation/audit/confirmation/outbox data. Review [migration behavior](moderation.md#migration-and-review). If migration fails, stop and inspect the fixed error privately; do not continue application launch or run `migrate reset`. Never run `docker compose down -v`. A code-only rollback after a schema migration may be incompatible; restore the matching backup/code during a maintenance window instead. An unavailable API/DB (`P1001`) usually means wrong Compose file/network or mismatched credentials; see [connectivity recovery](feed.md#deployment-recovery-p1001).

## Backups and restore

`bash scripts/backup.sh` uses container `pg_dump`, compresses to a private temporary file, checks gzip, atomically publishes `backups/squad-<UTC>-<pid>.sql.gz`, then retains the newest `BACKUP_KEEP=14` matching files. `BACKUP_DIR` can choose a private mounted directory. Secrets are expanded only inside the PostgreSQL container; raw command errors and passwords are never printed. A file lock prevents overlap. Failed backups do not delete old backups. Gzip verification detects archive corruption, not logical restorability: periodically restore a copy into a separate disposable database and verify application data. Copy encrypted backups off the same disk/server; the included script does not provide encryption or off-site transfer. Backups contain private records, and retention/permissions apply independently of in-app deletion.

The optional [service](../deploy/squad-backup.service) and [timer](../deploy/squad-backup.timer) are examples, **not installed automatically**. Adjust `/opt/squad`, the operator user (with Docker access), backup path and keep count. Then install them under `/etc/systemd/system`, run `sudo systemctl daemon-reload`, `sudo systemctl enable --now squad-backup.timer`, and verify `systemctl list-timers squad-backup.timer` plus a manual service run. Script env settings in `.env` are documentation only: host scripts read their exported environment, without executing `.env`; put custom backup values in the unit's `Environment=` or prefix the command.

Restore is destructive to its chosen DB; first take and preserve a fresh backup, stop app writers and confirm the archive and matching code version. Do not restore over production as a test. For an intentional complete restore to this installation:

```sh
set -euo pipefail
dc() { docker compose -f compose.yaml -f compose.production.yaml "$@"; }
export COMPOSE_FILE=compose.yaml:compose.production.yaml
BACKUP_KEEP=10000 bash scripts/backup.sh
# Set this to the exact archive selected for recovery, keep it quoted.
archive=./backups/squad-REPLACE_WITH_EXACT_FILENAME.sql.gz
test -f "$archive"
gzip -t -- "$archive"
dc --profile app stop bot api miniapp
dc exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; dropdb --no-password --if-exists --force -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb --no-password -U "$POSTGRES_USER" "$POSTGRES_DB"'
gzip -dc -- "$archive" | dc exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql --no-password -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null
# Use the code version matching the restored archive. Build before restarting.
dc --profile app build api bot miniapp
dc --profile app up -d --force-recreate --wait --wait-timeout 180 api bot miniapp
bash scripts/smoke.sh
```

Before bringing up an older schema, use the matching Git commit (record it alongside backups in a private operations record). For a restore test, create a separate database with an `_test` suffix, restore there and point a separate test instance at it; never use the live bot token. After real recovery, revoke restored sessions and one-time links if the backup's security state is stale. Restore commands shown are for trusted terminals; do not share raw DB diagnostics externally.

## Health, logs and credential rotation

`/health` returns only `{"status":"ok"}`. `/ready` additionally checks PostgreSQL/Redis and returns fixed 503 errors on failure. `bash scripts/smoke.sh` checks both via nginx, frontend status and all five container health states. Set `SMOKE_ORIGIN` explicitly for a changed `APP_PORT`. `dc exec -T api node scripts/check-security-headers.mjs http://miniapp` checks actual HTML/asset/404 headers, Telegram framing, no inline scripts and no exposed source maps. The standalone `pnpm check:headers https://your-origin` may also be run from a trusted local checkout with Node.

Inspect `dc --profile app ps` and bounded `dc logs --tail 100 api bot miniapp`. Application logs use fixed error codes/types and nginx omits query strings. Keep logs private: hostnames, IPs and operational identifiers can still appear. Do not add request-body, raw exception, initData, OpenID URL or provider URL logging. Steam's `key` query parameter must never be logged.

To rotate a leaked bot token, revoke/regenerate it in BotFather, replace only the secret in the private `.env` editor and recreate API/bot. Token changes invalidate new initData validation and signed cursors, but stored bearer session hashes remain usable until expiry unless revoked. During a maintenance window revoke sessions and linking attempts without printing data:

```sh
dc --profile app stop bot api
dc exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql --no-password -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null <<'SQL'
BEGIN;
DELETE FROM sessions;
DELETE FROM steam_links;
DELETE FROM admin_action_confirmations;
COMMIT;
SQL
dc --profile app up -d --force-recreate --wait --wait-timeout 180 api bot
```

Rotate Steam/FACEIT keys at their providers, update private `.env` and recreate API; cached stats remain and missing/rejected keys degrade gracefully. Database password rotation requires changing the PostgreSQL role and `.env` consistently in a private interactive session (avoid secrets in command arguments/history), then recreate API/bot; restart alone does not modify PostgreSQL role credentials. After each change run smoke checks and [manual M7 review](moderation.md#migration-and-review).

Known dependency advisories and development/real-device boundaries are documented in [security audit](security-audit.md). Local passing tests do not substitute for the operator's HTTPS, Telegram and backup/restore checks on the destination host.
