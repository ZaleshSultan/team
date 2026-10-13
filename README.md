# Squad — Telegram CS2 teammates

TypeScript MVP built in reviewable milestones. **M1–M7 are implemented; stopped for review.** Telegram authentication, consent, external Steam linking, cached Steam/FACEIT stats, CS2 profile editor, filtered feed, teammate requests and accepted contact exchange now include reports, reversible automatic hiding, block management and private bot administration. See [M7 moderation](docs/moderation.md), [home server deployment](docs/deployment.md), [dependency audit and limits](docs/security-audit.md), [M6 requests and contacts](docs/requests.md), [notification operations](docs/notifications.md), [M5 feed and performance](docs/feed.md), [M4 profiles and privacy](docs/profile.md), [M3 stats and operations](docs/stats.md) and [API mapping verification limits](docs/api-mappings.md).

## Requirements

- Node.js 22.13+ and pnpm 10 (`corepack enable` or install pnpm separately). ESLint 10 is development tooling; the Docker images use the current Node 22 release.
- Docker Desktop / Docker Engine with Compose running.
- A development Telegram bot from [BotFather](https://t.me/BotFather).
- For Telegram: an HTTPS Cloudflare Tunnel or ngrok URL pointing to Vite port 5173. Vite forwards `/api` to Fastify port 3000.

## Local setup

```sh
cp .env.example .env
pnpm install
docker compose up -d --wait
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

On PowerShell, copy with `Copy-Item .env.example .env`. Set `BOT_TOKEN`, `BOT_USERNAME`, `MINIAPP_URL`, `PUBLIC_API_URL`, `MINIAPP_ORIGIN`, and `DEV_TUNNEL_HOST` in `.env`. The URL values can all use the same HTTPS tunnel origin. `DEV_TUNNEL_HOST` is only the hostname, without a scheme. Never commit `.env`. Local PostgreSQL uses port **55433** to avoid existing databases; change both `POSTGRES_PORT` and `DATABASE_URL` if needed. Redis defaults to port 6379.

Use `pnpm dev:api` and `pnpm dev:miniapp` independently while configuring Telegram. `GET http://localhost:3000/health` is liveness; `/ready` checks DB/Redis. Startup fails if dependencies are unavailable. Open the app using the bot's launch button. Outside Telegram, the UI provides launch instructions and no login bypass.

Start a tunnel in another terminal:

```sh
cloudflared tunnel --url http://localhost:5173
# Alternatively: ngrok http 5173
```

Copy the assigned HTTPS origin into the URL variables, set its hostname in `DEV_TUNNEL_HOST`, and restart development processes. Vite forwards `/api` and `/health` to Fastify; never tunnel port 3000 as the Mini App frontend. In BotFather create a dedicated test bot and configure the Mini App/menu URL. Send `/start` in the bot's private chat; it also installs the chat menu button.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:validate
```

Real PostgreSQL integration tests are separate and require a database name ending `_test`. They delete only test-created identities. With the default local settings, create it once and migrate it:

```powershell
docker compose exec -T postgres psql -U squad -d postgres -c "CREATE DATABASE squad_test"
$env:TEST_DATABASE_URL = 'postgresql://squad:squad_local_only@localhost:55433/squad_test?schema=public'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
pnpm db:migrate
pnpm db:seed
pnpm test:integration
Remove-Item Env:DATABASE_URL
Remove-Item Env:TEST_DATABASE_URL
```

In bash, use `export TEST_DATABASE_URL='...'`, `DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate`, the same form for seed, then `pnpm test:integration`. If `squad_test` already exists, skip creation. Unit tests never require a DB, Redis, or external provider credentials.

`pnpm db:dev --name description` is for creating future migrations locally; use `pnpm db:migrate` to apply checked-in migrations. The seed is idempotent and inserts CS2 only. Playtimes are integer minutes. Steam/Telegram IDs are database `BIGINT` values serialized as strings at API boundaries.

## Project layout

```text
apps/api       Fastify, validated config, Prisma schema/migrations
apps/bot       grammY launcher, private moderation commands, notification worker
apps/miniapp   React/Vite, Russian default and English translations
packages/shared Zod schemas and API types shared by clients and server
docs/          Database and authentication design notes
```

Game logic belongs behind `GameProvider`, not inside generic search/request code. All user-facing strings live in translation files. `user_games` caches **all accessible owned games**, including titles outside the catalog; the M5 feed searches CS2 profiles only. Clusters are schema-only.

`GET /api/feed/cs2` requires current onboarding consent, linked Steam and, by default, a published CS2 profile. `FEED_REQUIRES_PUBLISHED_PROFILE=true` and `FEED_RATE_LIMIT_PER_MINUTE=60` are the defaults. The Mini App provides Profile/Feed/Requests navigation, remembered filters, invitations, an incoming badge and paginated incoming/outgoing requests. Synthetic seed, cleanup and benchmark commands require explicit opt-in, a local disposable database and a development/test environment; they never load `.env`. See [feed tooling and measurements](docs/feed.md#synthetic-data-and-benchmark-safety) before running them. Leave `ALLOW_SYNTHETIC_SEED=0` on real installations.

M6 defaults: `REQUESTS_PER_DAY=10` in a rolling 24-hour window, `REQUEST_TTL_DAYS=7`, `REQUESTS_RATE_LIMIT_PER_MINUTE=60`, `NOTIFICATION_CONCURRENCY=3`, `NOTIFICATION_RATE_LIMIT_PER_SECOND=25`, `NOTIFICATION_MAX_ATTEMPTS=5`, `NOTIFICATION_BACKOFF_MS=1000`, and `TELEGRAM_CONTACT_TIMEOUT_MS=5000`. The bot now also needs `DATABASE_URL` and `REDIS_URL`; Compose supplies its internal service addresses. The API's maintenance worker expires requests and dispatches a durable database outbox to BullMQ's `notifications` queue; the bot process delivers messages. See [request deployment instructions](docs/requests.md#deployment).

## Keys and privacy

Steam OpenID verifies identity and needs no Steam API key. `STEAM_WEB_API_KEY` and `FACEIT_API_KEY` enable their respective cached stats providers, sourced from [Steam](https://steamcommunity.com/dev/apikey) and [FACEIT developers](https://developers.faceit.com/). Missing keys disable only that provider; the app shows stats unavailable. No Steam/FACEIT passwords or session tokens are accepted or stored. Onboarding requires a Telegram username, age confirmation (default 18, configurable), and community rules consent; no birth date is stored. The age threshold is a product setting, not a claim about jurisdiction-specific age eligibility.

`share_steam_activity` defaults to false. The strict public player card always omits account identifiers and the library; exact CS2 hours appear only when sharing is enabled. The owner can always inspect their cache. Session/start-link/state/browser secrets are stored only as hashes; session tokens stay in client memory. Health responses expose no credentials. API logs exclude authorization and URLs, including provider URLs with Steam keys. [Authentication and external Steam flow](docs/authentication.md) describes the protocol, endpoints, state transitions, and test boundaries.

Request lists and new-request notifications contain public card data and no Telegram username/ID. Acceptance re-checks both current usernames with Telegram `getChat`; an unavailable contact leaves the request pending. The two participants can obtain the other participant's current username on an accepted request, with another live check each time. Configured moderators have a separate, audited Show contact action in the private bot. Usernames are never stored in request/outbox records or Redis jobs, and blocks revoke access to accepted contacts. Declining sends no notification. See [contact visibility and limitations](docs/requests.md#contact-visibility).

## Deployment approach

The complete [deployment guide](docs/deployment.md) covers first start, backup-first M6→M7 update commands, migrations, HTTPS/tunnel changes, restore, token rotation and smoke/header checks. [Manual M7 review](docs/moderation.md#migration-and-review) uses two test players and one configured admin. No automatic production deployment is performed.

Target: a single HTTPS server using Docker Compose. Set real HTTPS origins and credentials in the server's `.env`, use a strong URL-safe database password (e.g. generated hex), and keep DB/cache ports bound to loopback. The full app uses three images from the Dockerfile: API, bot and static Mini App/nginx. Build and migrate before launch:

```sh
docker compose -f compose.yaml -f compose.production.yaml --profile app build &&
docker compose -f compose.yaml -f compose.production.yaml up -d --wait --wait-timeout 120 postgres redis &&
docker compose -f compose.yaml -f compose.production.yaml --profile app run --rm --no-deps api pnpm db:migrate &&
docker compose -f compose.yaml -f compose.production.yaml --profile app run --rm --no-deps api pnpm db:seed &&
docker compose -f compose.yaml -f compose.production.yaml --profile app up -d
```

The `&&` chain stops on failure, so application launch requires successful dependency health checks, migrations and seeding. For updates to an existing installation, keep its current Compose file set and follow the [update and database-connectivity recovery instructions](docs/feed.md#deployment-recovery-p1001).

Use these production files together from the first server launch: the override allocates a fixed private subnet and trusts only nginx's IP. If moving an existing dev stack to that subnet, stop its containers with `docker compose down` **without `-v`** first; volumes remain. If `172.30.75.0/24` conflicts with the server, change the subnet, gateway, trusted proxy IP and nginx `set_real_ip_from` together.

The frontend listens at `127.0.0.1:8088`. Put an HTTPS proxy on the host in front of it and **overwrite** `X-Forwarded-For` with the real client IP. For example, a Caddy host config:

```caddyfile
your.example.com {
    reverse_proxy 127.0.0.1:8088 {
        header_up X-Forwarded-For {remote_host}
        header_up CF-Connecting-IP {remote_host}
    }
    # Avoid access logging full query strings containing one-time secrets.
}
```

nginx trusts only the host gateway, replaces the forwarding chain with the sanitized client IP, and the API trusts only nginx. `TRUST_PROXY` accepts explicit IPs/CIDRs or `false`; it rejects trust-all booleans. For local tunnels keep it false. Authenticated request limits use the validated session user ID; public/anonymous requests use the IP quota. Do not publish the API separately with trusted proxy headers enabled. Keep TLS and DNS configured, register the final URL in BotFather, and back up persistent volumes. The sample API/bot images retain workspace development tooling for straightforward migrations; prune them in a later deployment hardening milestone. [Account deletion and hardening](docs/hardening.md) covers confirmation, cascades and the required database password.

## M2 real-device review

1. Set your bot token and HTTPS tunnel, run the stack, then open `/start` → Mini App on Telegram mobile and desktop.
2. Verify Russian default/English toggle, age/rules consent and optional activity sharing. Try an account without a username; set one in Telegram settings and press Check again.
3. Create a Steam link, then press Open Steam. Confirm it opens an external browser, complete Valve sign-in, and return to the Mini App. Polling should show Steam connected; reopen the Mini App to confirm persistence.
4. Cancel sign-in, retry, let a link expire, reuse a launch URL, and open a callback in another browser. None should attach an account incorrectly.
5. Try linking the same Steam account to another Telegram identity: ownership must remain with the first one. Verify `/ready` and bot launch behavior.

Automated provider responses are injected for repeatable tests. Live Telegram/Steam validation still requires the real bot and your HTTPS endpoint; no credentials are included in this repository.

## Milestones

- M1: repo, infrastructure, DB schema/migration and seed.
- M2: Telegram login, onboarding consent/username, external-browser Steam OpenID and polling.
- M3: Steam/FACEIT cached sync, all owned games, six-hour refresh.
- M4: CS2 profile editor, publication checklist, badges, privacy-safe preview and account deletion UI.
- M5: implemented — CS2 feed, provider-validated filters, signed cursor pagination, privacy-safe cards and guarded performance tooling.
- M6: implemented — teammate requests, rolling daily quota, expiry, queued notifications, fresh accepted contacts, minimal blocks and requests UI.
- M7: implemented — private reports, reversible auto-hide, paginated blocks, private bot admin/confirmations/audit, retention, security headers, backups, deployment guide and final validation.

## Environment settings

All app settings are parsed at startup, with RU as the default language. Keep real values only in private `.env`; `.env.example` documents every variable. Compose requires a nonempty database password. Provider keys are optional.

| Setting | Default / purpose |
| --- | --- |
| `BOT_TOKEN`, `BOT_USERNAME` | Required BotFather secret and username without `@` |
| `DATABASE_URL`, `REDIS_URL` | Required connections; Compose uses internal addresses |
| `POSTGRES_PASSWORD` | Required, strong URL-safe secret; must match existing DB role |
| `POSTGRES_USER`, `POSTGRES_DB` | `squad`, `squad` |
| `POSTGRES_PORT`, `REDIS_PORT`, `APP_PORT` | Loopback `55433`, `6379`, `8088` |
| `NODE_ENV`, `LOG_LEVEL`, `HOST`, `PORT` | `development`, `info`, `0.0.0.0`, `3000`; Compose sets production |
| `MINIAPP_URL`, `PUBLIC_API_URL`, `MINIAPP_ORIGIN` | Required HTTPS app URL/API origin/CORS origin |
| `VITE_API_BASE_URL`, `DEV_TUNNEL_HOST` | Blank same-origin API; exact Vite tunnel hostname |
| `TRUST_PROXY` | `false`; production override trusts only nginx's fixed IP |
| `SESSION_TTL_SECONDS`, `TELEGRAM_AUTH_MAX_AGE_SECONDS`, `STEAM_LINK_TTL_SECONDS` | `3600`, `300`, `600` |
| `AGE_MINIMUM`, `RULES_VERSION` | `18`, `2026-10-07`; changes require fresh consent |
| `STEAM_WEB_API_KEY`, `FACEIT_API_KEY` | Optional cached stats credentials |
| `STATS_REFRESH_HOURS`, `STATS_WORKER_CONCURRENCY` | `6`, `3` |
| `STATS_MANUAL_COOLDOWN_SECONDS` | `300` |
| `STATS_STEAM_INTERVAL_MS`, `STATS_FACEIT_INTERVAL_MS` | `1000`, `1000`; shared provider spacing |
| `FEED_REQUIRES_PUBLISHED_PROFILE`, `FEED_RATE_LIMIT_PER_MINUTE` | `true`, `60` |
| `REQUESTS_PER_DAY`, `REQUEST_TTL_DAYS`, `REQUESTS_RATE_LIMIT_PER_MINUTE` | `10` rolling daily, `7`, `60` |
| `NOTIFICATION_CONCURRENCY`, `NOTIFICATION_RATE_LIMIT_PER_SECOND` | `3`, `25` |
| `NOTIFICATION_MAX_ATTEMPTS`, `NOTIFICATION_BACKOFF_MS`, `TELEGRAM_CONTACT_TIMEOUT_MS` | `5`, `1000`, `5000` |
| `ADMIN_TELEGRAM_IDS` | Empty disables admins; comma-separated positive numeric IDs, never usernames |
| `SUPPORT_CONTACT` | Empty fallback, or `@username` / `https://t.me/username` |
| `REPORTS_PER_DAY` | `10` rolling 24-hour reports per user |
| `REPORTS_AUTO_HIDE_THRESHOLD` | `3` distinct established Steam-linked reporters within seven days |
| `REPORTS_RATE_LIMIT_PER_MINUTE` | `10` per authenticated user |
| `REPORT_RETENTION_DAYS` | `180` after resolution; request retention fixed at 90 days |
| `ALLOW_SYNTHETIC_SEED` | `0`; never enable against real data |
| `BACKUP_KEEP`, `BACKUP_DIR`, `SMOKE_ORIGIN` | Host script env: `14`, `./backups`, `http://127.0.0.1:8088`; export explicitly, scripts do not source `.env` |

New M7 runtime settings: `SUPPORT_CONTACT`, `REPORTS_PER_DAY`, `REPORTS_AUTO_HIDE_THRESHOLD`, `REPORTS_RATE_LIMIT_PER_MINUTE`, `REPORT_RETENTION_DAYS`. `ADMIN_TELEGRAM_IDS` existed as a placeholder and is now strictly validated/enforced. There are no new runtime packages. The remaining five dependency advisory entries require separately reviewed major tooling upgrades; see [audit details](docs/security-audit.md).
