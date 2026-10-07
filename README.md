# Squad — Telegram CS2 teammates

TypeScript MVP built in reviewable milestones. **Current scope: M1 infrastructure.** No teammate search, stats sync, requests or moderation yet; those are M3–M7.

## Requirements

- Node.js 22.12+ and pnpm 10 (`corepack enable` or install pnpm separately).
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

On PowerShell, copy with `Copy-Item .env.example .env`. Set `BOT_TOKEN`, `BOT_USERNAME`, `MINIAPP_URL`, `PUBLIC_API_URL`, `MINIAPP_ORIGIN`, and `DEV_TUNNEL_HOST` in `.env`. The URL values can all use the same HTTPS tunnel origin. Never commit `.env`.

Use `pnpm dev:api` and `pnpm dev:miniapp` independently while configuring Telegram. `GET http://localhost:3000/health` is a liveness endpoint. Open the app using the bot's launch button; the ordinary browser shell is for setup only.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm db:validate
```

`pnpm db:dev --name description` is for creating future migrations locally; use `pnpm db:migrate` to apply checked-in migrations. The seed is idempotent and inserts CS2 only. Playtimes are integer minutes. Steam/Telegram IDs are database `BIGINT` values serialized as strings at API boundaries.

## Project layout

```text
apps/api       Fastify, validated config, Prisma schema/migrations
apps/bot       grammY launcher; moderation and notifications in later milestones
apps/miniapp   React/Vite, Russian default and English translations
packages/shared Zod schemas and API types shared by clients and server
docs/          Database and authentication design notes
```

Game logic belongs behind `GameProvider`, not inside generic search/request code. All user-facing strings live in translation files. `user_games` is ready for **all owned games** in M3; search remains CS2-only. Clusters are schema-only.

## Keys and privacy

Steam OpenID will verify identity in M2 and needs no Steam API key. `STEAM_WEB_API_KEY` and `FACEIT_API_KEY` are required for stats in M3, sourced from [Steam](https://steamcommunity.com/dev/apikey) and [FACEIT developers](https://developers.faceit.com/). No Steam/FACEIT passwords or session tokens are accepted or stored. The planned onboarding requires a Telegram username, an age confirmation (default 18, configurable), and community rules consent; no birth date is stored.

`share_steam_activity` will control disclosure of game activity; exact activity must be omitted from public responses when false. Auth session/start-link secrets are intended to be stored only as hashes. Health responses expose no credentials. API logs exclude authorization and one-time links.

## Deployment approach

Target: a single HTTPS server using Docker Compose and a reverse proxy. Keep PostgreSQL and Redis private; use strong database credentials, TLS, persistent volumes, backups, and separate bot/API processes. Run committed migrations and the idempotent seed before starting the API. Build the Mini App with `pnpm build` and serve `apps/miniapp/dist` from the public origin, proxying `/api` to the API. Register the HTTPS Mini App with BotFather. Concrete app images and authentication deployment notes are delivered with M2.

## Milestones

- M1: repo, infrastructure, DB schema/migration and seed.
- M2: Telegram login, onboarding consent/username, external-browser Steam OpenID and polling.
- M3: Steam/FACEIT cached sync, all owned games, six-hour refresh.
- M4: profile editor and private-profile guidance.
- M5: feed, filters and cursor pagination.
- M6: requests, ten daily outgoing requests, queued notifications/contact exchange.
- M7: reports/blocks, bot admin commands, moderation and final validation.
