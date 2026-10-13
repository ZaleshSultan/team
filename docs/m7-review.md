# M7 review record — 2026-10-13

Baseline: `main` at `f88cb38`, fetched and equal to `origin/main` before work. Squad workspace verified. Development used a fresh local `squad_m7_test` database on loopback port 6793, fixtures and mocked Telegram/HTTP. Production DB, live bot token and running stack were not used. No deployment or remote push was performed by this milestone.

## Delivered

- Shared strict Zod moderation/admin configuration and transport contracts; shared CS2 option allowlists.
- Prisma migration `202610150001_m7_moderation`: report reasons/resolution/FKs, reversible moderation flags, append-only application audit, hashed confirmations, moderation outbox and indexes. Legacy unknown reasons map to OTHER; old comment text truncates to 500 characters.
- API reports, daily quota/idempotency, legitimate visibility checks, distinct qualified reporter auto-hide, block pagination, recovery-safe outbox/retention maintenance and public legal-navigation metadata.
- Private bot admin commands, authorization/rate limits, confirmation, ban/session/request side effects, audited explicit contact access, notifications and legal/help texts.
- Mini App report dialog and optional independent block/retry, blocked-player settings, legal links and matching RU/EN translations.
- Route hardening, ordered user locks for onboarding/username refresh/deletion, anonymized reports-about on deletion, no republishing a moderation-hidden profile, uniform unblock 404s and optional-feed-publication consistency.
- nginx security headers/Telegram framing/source-map denial, removal of CSP-blocked external font import, five container health checks, bot heartbeat, backup/smoke/header scripts, optional systemd timer and deployment/restore/rotation guide. Caddy example now overwrites the exact trusted IP header.
- Safe Effect 3.18.4→3.20.1 transitive minor update. No new runtime dependency.

## Final verification

| Check | Result |
| --- | --- |
| `pnpm lint` | PASS, zero warnings |
| `pnpm typecheck` | PASS, shared/API/bot/Mini App and API tooling |
| `pnpm test` | PASS: 547 API + 213 bot + 252 Mini App = **1012 unit tests**, plus **14 ops tests** |
| `pnpm test:integration` | PASS: **258 PostgreSQL tests** across nine files |
| `pnpm build` | PASS, all workspaces and production Vite bundle |
| Prisma migration + seed + validate | PASS on the fresh disposable PostgreSQL 18 database |
| Compose production configuration | PASS, example-only env and cleared app env-file override |
| `docker compose ... build` | BLOCKED: Docker Desktop Linux engine pipe absent; no images/containers started |
| nginx syntax + fetch built frontend | PASS on isolated nginx/Windows 1.30.5; actual main/asset/404 headers, no inline scripts/source maps |
| Mini App browser review | PASS on 390×844 with actual UI and mocked HTTP; reports, independent block retry, 429/404, request-origin report, hidden-profile unblock, pagination, legal links, RU/EN, light/dark, dirty guard |
| `pnpm audit` | Nonzero: **5 advisories**, 2 critical / 1 high / 2 moderate; major upgrades deferred as required |

Tests cover unknown/invisible/self/foreign targets, fully onboarded callers, rolling quota boundaries, duplicate retries and races, distinct/new/unlinked/banned reporter rules, reversible hiding/publication bypass, ownership/privacy/pagination, ban and concurrent request effects, confirmation expiry/replay/wrong admin, every admin command/authorization/group behavior/audit, terminal notification markers and 403/429/backoff, deletion/anonymization/FK survival, bounded retention and report/request cleanup races. Ops tests use doubles for Docker/curl/flock and verify backup failure preserves prior files, gzip/retention and secret-free error output.

## Operator review

New app settings: `SUPPORT_CONTACT`, `REPORTS_PER_DAY=10`, `REPORTS_AUTO_HIDE_THRESHOLD=3`, `REPORTS_RATE_LIMIT_PER_MINUTE=10`, `REPORT_RETENTION_DAYS=180`; existing `ADMIN_TELEGRAM_IDS` now enforces a numeric allowlist. Host scripts accept exported `BACKUP_KEEP=14`, `BACKUP_DIR=./backups`, `SMOKE_ORIGIN=http://127.0.0.1:8088`, plus a consistent `COMPOSE_FILE`/project name. Empty admin/support defaults are safe; missing provider keys remain supported.

Not verified: real Telegram identities/delivery/flood limits, real mobile WebViews, HTTPS tunnel and external Steam return, live Redis worker transport, Docker image/Linux health checks, production PostgreSQL 16, and actual server backup/restore. Telegram's side-effect/DB-marker crash window can duplicate a notification. Coordinated qualified reports can hide an innocent profile pending review. Audit/deleted-account moderation metadata and backups have separate retention. Development tooling remains in API/bot images and carries the remaining advisories; see [audit details](security-audit.md).

Exact **backup → pull → build → stop app writers → migrate/seed → recreate → smoke/headers** server commands, including first M6→M7 backup bootstrap, are in [deployment update procedure](deployment.md#update-an-existing-installation-backup-first). It is ready for the operator to run after reviewing/transferring the commits. This work does not run it. [Manual two-player + one-admin checklist](moderation.md#migration-and-review) covers report/block/ban/unban/deletion/consent/privacy; the default three-reporter automatic threshold is covered with isolated fixtures rather than changing production settings.
