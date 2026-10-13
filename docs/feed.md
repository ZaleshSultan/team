# M5: CS2 player feed

M5 implements `GET /api/feed/cs2` and the Mini App's Profile / Feed navigation. Requests, contact exchange and moderation controls remain M6/M7. Cards contain a source-code slot for future actions and render no action buttons.

## Access and configuration

Send the existing session bearer token. An absent/expired session returns 401; a banned caller returns 403. The feed also requires current age/rules consent and a Telegram username, linked Steam, and a published CS2 profile by default. Missing requirements return 409:

```json
{
  "error": {
    "code": "FEED_REQUIREMENTS_MISSING",
    "message": "Complete the feed access requirements",
    "requirements": [
      { "code": "ONBOARDING_INCOMPLETE" },
      { "code": "STEAM_REQUIRED" },
      { "code": "PUBLISHED_PROFILE_REQUIRED" }
    ]
  }
}
```

Only unmet requirements appear. The UI translates the codes and links to Profile. Error responses can also include the existing request identifier. Invalid query parameters return 400 with the existing validation error shape; invalid cursors return the fixed `INVALID_CURSOR` code without echoing the token.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FEED_REQUIRES_PUBLISHED_PROFILE` | `true` | Accepts exactly `true`/`false`; `false` removes only the caller's publication requirement. |
| `FEED_RATE_LIMIT_PER_MINUTE` | `60` | Integer 1–600, requests per minute per authenticated session **user**, shared across that user's sessions/IPs. |
| `ALLOW_SYNTHETIC_SEED` | `0` | Tooling-only opt-in; must be exactly `1` for seed, cleanup or benchmark. Keep disabled on real installations. |

The feed limiter inherits the validated session-user key generator. Invalid/anonymous sessions use the IP key. An exhausted quota returns 429 and the existing rate-limit response/headers. Feed reads use PostgreSQL directly, with no Redis feed cache and no Steam/FACEIT requests. All stats come from M3's stored cache; absent provider keys do not prevent browsing.

## Filters and pagination parameters

Unknown parameters, invalid options, empty list entries, repeated scalar parameters and out-of-range values are rejected. List parameters accept repeated values, comma-separated values, or both; values are trimmed, normalized and deduplicated. The selected `GameProvider.profileOptions` is the source of allowed values; the UI obtains the same options through the profile endpoint.

| Parameter | Accepted values / behavior |
| --- | --- |
| `roles` | `entry`, `awp`, `support`, `lurk`, `igl` |
| `languages` | Provider language codes: `ru`, `kk`, `en`, `de`, `fr`, `es`, `it`, `pt`, `tr`, `uk`, `pl`, `uz`, `ky`, `tg`, `az`, `hy`, `ka`, `be`, `zh`, `ko`, `ja`, `ar`. |
| `regions` | `KZ`, `RU`, `CIS`, `EU`, `OTHER` (case normalized to uppercase). |
| `lookingFor` | `duo`, `five_stack`, `team` |
| `playTimes` | `morning`, `day`, `evening`, `night` |
| `faceitLevelMin`, `faceitLevelMax` | Inclusive integer bounds 1–10; minimum must not exceed maximum. Only a Steam-matched FACEIT account can satisfy a bound; absent/unknown levels do not match. |
| `hasMic` | Exactly `true` or `false`; omitted means either. |
| `verifiedOnly` | Exactly `true` or `false`, default `false`. `true` requires FACEIT's stored Steam ID to equal the linked Steam account. |
| `noBans` | Exactly `true` or `false`, default `true`. Hides positive cached VAC/game-ban counts; unknown counts remain eligible. Community/economy bans remain eligible and show the public ban warning. |
| `limit` | Integer 1–50, default 20. |
| `cursor` | Opaque `nextCursor` from the preceding response, with the same filters. |

List values mean **any-of within one field**, **AND across different fields**. For example, `roles=awp,support&languages=ru&hasMic=true` selects a player with AWP **or** support, who also speaks Russian and has a microphone. Omitted list fields impose no restriction. Time labels are self-reported availability; M5 does not interpret them as timezones or clock ranges.

```http
GET /api/feed/cs2?roles=awp&roles=support&languages=ru,en&regions=KZ&verifiedOnly=true&faceitLevelMin=5&limit=20
Authorization: Bearer <session token>
```

## Candidate eligibility and exclusions

Each request rechecks that a candidate has a published profile for the provider's catalog game, linked Steam, a nonempty Telegram username, `isBanned=false`, `botBlocked=false`, and current age/rules consent. The caller is excluded. The extra consent check prevents a formerly published profile from remaining discoverable after the required age/rules version changes. Private Steam game details do not exclude a profile.

The query excludes:

- Blocks in either direction.
- `PENDING` or `ACCEPTED` teammate requests in either direction, across **all games**.
- My outgoing request with status `DECLINED` and `resolved_at >= now - 14 days`, including the exact boundary. The named constant is `DECLINED_REQUEST_COOLDOWN_DAYS`. A reverse-direction decline, an older decline, or a cancelled/expired request does not hide that candidate.

There is no feed result cache. After a ban, unpublication, block or account deletion, subsequent feed requests reflect the database immediately. Already displayed cards are replaced on refresh; the UI does not receive server push events in M5. Deleting an account also cascades its blocks/requests, so surviving peers become eligible when those exclusions disappear.

## Cursor and response boundary

Ordering is `player_profiles.created_at DESC, id DESC`. The next page uses the strict tuple predicate `(created_at, id) < (anchorCreatedAt, anchorId)`; it never uses OFFSET. Equal timestamps are ordered by profile UUID. Newly inserted profiles sort ahead of an existing anchor and appear on refresh, without shifting subsequent pages. Deleting the anchor does not invalidate pagination. Eligibility can change while browsing, so pages are a current view rather than a frozen snapshot.

The response is `{ "items": [PublicPlayerCard, ...], "nextCursor": "..." | null }`, without a total count. A null cursor means no further eligible rows were found at that time.

Clients must treat cursors as opaque. Version 1 is canonical base64url JSON with `v`, millisecond ISO `createdAt`, public profile `id`, an HMAC scope and an HMAC signature. Scope binds the caller, game slug and normalized filters. It contains no raw user/account ID; the profile UUID is the same public card ID. HMAC-SHA256 uses separate contexts derived from the existing bot secret. Decoding validates the complete strict shape, canonical encoding/date, UUID, signature and scope. Editing any field, reusing another user's cursor or changing filters returns 400. Page size can change. Rotating `BOT_TOKEN` invalidates outstanding cursors; refresh obtains a new one. Base64url provides encoding, not encryption.

Every row goes through the existing `serializePublicPlayerCard`, followed by the strict shared response schema. The query selects only card-validation fields and ordering anchors. No Telegram ID/username, internal user ID, Steam ID, library, raw minutes, provider payload or exact cached ban counts leave this boundary. The public profile ID is intentionally retained. `activity` with CS2 hours appears only when `shareSteamActivity=true`; even the SQL activity join is gated on that flag. Missing shared game data produces null hours. Invalid legacy profiles/cache rows are skipped in bounded query batches rather than exposed; a page containing many invalid legacy rows can require several batches.

## Mini App

The Russian-default/English UI uses existing Telegram theme variables and contrast handling. It includes provider-based filter chips, FACEIT bounds, microphone/verification/ban toggles, an active summary and reset, skeletons, retry/error messages, requirement guidance, filtered/default empty states, load more and pull-to-refresh. Requests are cancelled when filters/navigation change; refresh replaces cards, and append deduplicates public profile IDs. Unsaved profile edits require the existing translated discard confirmation before switching to Feed.

Only filters are remembered under `squad.feed.cs2.filters.v1`. Storage reads/writes are guarded, and saved data is validated against the shared shape and current provider options. Restricted/unavailable WebView storage falls back to in-memory defaults. Results, cursors and session tokens are not persisted there.

## Synthetic data and benchmark safety

The three developer commands **never load `.env`**. All guards run before creating a database client. Each requires:

- `ALLOW_SYNTHETIC_SEED=1` and `NODE_ENV` exactly `development` or `test` (stricter than simply excluding production).
- PostgreSQL URL with host exactly `localhost` or `127.0.0.1` and database name matching `[A-Za-z0-9_]+_(dev|test)`.
- No URL fragment or connection-option override. Only an optional single `schema=public` query parameter is allowed.

Synthetic Telegram IDs occupy only **-9000000099999 through -9000000000000**. Stable UUID ownership markers protect the range: a foreign identity anywhere in it makes seed/cleanup refuse the entire operation. Seed also refuses an already populated synthetic range. Seed and cleanup use one transaction and an advisory lock; errors log only fixed codes. Cleanup deletes only marked users in that range, letting existing cascades remove their data. Seed defaults to 10,000 profiles, accepts a count from 1–100,000, and creates varied filters, FACEIT levels, bans, privacy and eligibility states. It performs no external API calls. `AGE_MINIMUM`/`RULES_VERSION` can be supplied explicitly if your public consent settings differ from the defaults.

The initial schema's `users_telegram_id_positive` CHECK rejects negative IDs. To support fixtures without changing the production schema, seed verifies that this CHECK has the exact original positive-ID expression and is validated. Inside its guarded disposable-database transaction it drops the CHECK, inserts fixtures, and restores the original `telegram_id > 0` CHECK as **NOT VALID** before commit. New/updated rows still obey that CHECK; existing synthetic users remain readable but cannot be updated through normal user-edit flows. Seed is intended for feed reads and benchmarks. Cleanup deletes synthetic users and validates the original CHECK in the same transaction, restoring its original state. A failed transaction rolls back both data and DDL. If seed is interrupted after commit, run cleanup before reusing the disposable database. Missing/modified checks or an initially unvalidated check make seed refuse to proceed. This operation takes an exclusive users-table lock in the disposable database; never target a running application's database.

Use a separately created disposable database; do not reuse an application's database. Example for a local PostgreSQL instance with a dedicated `squad_test` role and passwordless local test authentication:

```powershell
$env:NODE_ENV = 'test'
$env:ALLOW_SYNTHETIC_SEED = '1'
$env:DATABASE_URL = 'postgresql://squad_test@127.0.0.1:6791/squad_feed_test?schema=public'
pnpm --filter @squad/api db:migrate
pnpm --filter @squad/api db:seed
pnpm dev:synthetic:seed
pnpm dev:feed:benchmark
pnpm dev:synthetic:cleanup
Remove-Item Env:ALLOW_SYNTHETIC_SEED
Remove-Item Env:DATABASE_URL
Remove-Item Env:NODE_ENV
```

Adjust the example to your dedicated local test instance. These commands neither create PostgreSQL nor start/restart Docker. Avoid the root `db:migrate`/`db:seed` wrappers for this workflow, since those intentionally load `.env`; the workspace commands above use the explicitly supplied URL. Cleanup, seed and benchmark share the same safety guard. Benchmark requires the default dataset (including its anchor at index 3000), runs ANALYZE, and prints aggregate timings/plans only.

## Performance evidence and budget

The implementation uses parameterized `Prisma.sql` exclusively. A normal page performs session/access checks, one catalog-ID lookup and one joined card query; it does not perform one query per player. The scan batch is 100 rows, and responses remain capped at 50 cards. Existing indexes cover profile order, region/mic, GIN role/language/goal arrays, FACEIT level/ELO, unique account joins and block/request exclusions. There is no GIN index for play times; combined filters are assessed using the existing indexes first.

Measured on 2026-10-13 using a separate loopback PostgreSQL **18** instance, Node **24.19**, and 10,000 synthetic profiles. The deployment image remains PostgreSQL **16** / Node **22**; production results must be remeasured there. Data included private/shared activity, mixed publication/username/bot/ban states and FACEIT levels. Blocks/requests were empty in the 10k benchmark; their correctness was exercised separately in integration tests, and request-heavy performance remains unmeasured.

The guarded benchmark ran ANALYZE, the exact card query at batch limit 100, 30 warm samples per scenario, then `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. The first sample was after ANALYZE, not a cold-disk test. Query p50/p95 include Prisma/driver/round-trip/planning overhead; EXPLAIN execution is a separate sample and excludes its reported planning time. All final EXPLAIN samples had zero shared buffer reads, so these are warm-cache measurements. A separate Fastify `inject` run exercised the actual route, session/access queries, serializer and response schema with PostgreSQL, limit 20 and 30 warm samples. It used an in-memory rate limiter, with no Redis, TCP/TLS, tunnel or real Telegram client.

| Scenario | Card rows (batch 100) | Query p50 / p95 ms | EXPLAIN planning / execution ms | Shared hits | Route p95 ms (limit 20) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Default, no VAC/game bans | 100 | 9.55 / 12.54 | 6.90 / 1.15 | 1,534 | 17.96 |
| AWP/support + ru/en + mic | 100 | 45.86 / 51.01 | 7.14 / 1.09 | 1,584 | 53.79 |
| KZ/EU + duo/team + evening/night | 100 | 31.77 / 42.68 | 6.34 / 1.21 | 1,538 | 39.71 |
| Verified FACEIT level 6–10 | 100 | 57.46 / 65.08 | 10.48 / 50.37 | 46,107 | 65.31 |
| IGL + kk + KZ + team + night + mic + verified level 8–10 | 4 | 2.04 / 11.19 | 8.97 / 0.80 | 235 | 15.32 |
| Include VAC/game bans | 100 | 8.74 / 9.74 | 6.46 / 1.05 | 1,504 | 15.53 |
| Deep cursor at synthetic profile index 3000 | 100 | 2.15 / 9.31 | 6.45 / 1.25 | 1,553 | Not measured |

The initial `COALESCE(ban_count, 0) <= 0` predicates produced a default plan that scanned/sorted about 8,600 candidates, with 101,558 buffer hits and 61.79 ms EXPLAIN execution. Equivalent explicit `ban_count IS NULL OR ban_count <= 0` predicates expose column statistics: the final default plan starts with the existing `player_profiles_game_id_is_published_created_at_id_idx`, scans in descending order and stops early. It reduced that EXPLAIN sample to 1.15 ms / 1,534 hits, while preserving unknown-ban behavior.

The selective all-fields plan combines existing role/goal GIN indexes with the region/mic composite index; it finds four rows without scanning the whole profile table. The broad FACEIT 6–10 plan reads about half the FACEIT table and sorts 3,252 candidates after joins; the existing level index is not selected for this broad range. Repeated query latency can differ substantially from the separately planned EXPLAIN sample, especially for array filters; planner/prepared-query behavior on the deployed version deserves follow-up under realistic load. No missing-index need was demonstrated, so **no index or production migration was added**.

The initial budget for 10,000 valid/mostly valid profiles is warm card-query p95 below **50 ms**, and API p95 below **200 ms** on a single local server, excluding internet/WebView latency. Two broad filter combinations missed the 50 ms query target (51.01 and 65.08 ms); all measured in-process routes stayed below 66 ms. These are tuning targets, not an SLA; full HTTP API latency including Redis, production hardware/distribution and high concurrent load require separate measurement. Repeat the benchmark after data growth or a materially different distribution before adding indexes.

## Tests and deployment

Unit tests cover strict filters, SQL parameterization/shape, gate errors, cursor integrity/scope, privacy serialization, rate-limit keys and unsafe synthetic configurations. PostgreSQL integration tests cover every filter, both directions of exclusions, the declined boundary, cursor insertion/deletion stability and deletion cascades. Mini App tests cover filter/query mapping, pagination, storage failure, loading/error/empty/gate states and locale parity.

Final local verification on 2026-10-13: `pnpm typecheck`, `pnpm test` (413 API + 125 Mini App tests), `pnpm test:integration` (94 tests on isolated PostgreSQL), and `pnpm build` all passed. Guarded seed/cleanup ran with 10,000 profiles; after cleanup and the final integration run, the test DB had zero users/profiles and the original positive-ID CHECK was validated again. A transactional check also confirmed that the NOT VALID CHECK still rejects new negative IDs and updates to existing synthetic users.

Browser QA used the actual App/FeedScreen with mocked HTTP responses on a separate local port: mobile navigation, paging, invalid FACEIT range, filter apply/reset, persisted filters, empty/error/retry states, requirement-to-profile navigation, Russian/dark and English/light themes, and private/shared activity rendering were checked. No horizontal overflow or card action buttons were observed. Native discard-confirmation interaction could not be automated reliably in the in-app browser; its guard is unit-tested. Real-device Telegram/WebView behavior, live Redis limiting, Docker-image builds and deployed PostgreSQL 16 performance were not tested in this milestone. No running stack was changed.

M5 introduces **no schema migration**. New configuration has defaults, so no server `.env` change is necessary for default behavior. Leave synthetic tools disabled. After reviewing and obtaining the updated checkout on the server, use the same Compose files as the existing installation. For the documented production override:

```sh
docker compose -f compose.yaml -f compose.production.yaml --profile app build api bot miniapp &&
docker compose -f compose.yaml -f compose.production.yaml up -d --no-recreate --wait --wait-timeout 120 postgres redis &&
docker compose -f compose.yaml -f compose.production.yaml --profile app run --rm --no-deps api pnpm db:migrate &&
docker compose -f compose.yaml -f compose.production.yaml --profile app up -d --no-deps --force-recreate api bot miniapp
```

For an installation already using only `compose.yaml` behind a local HTTPS tunnel, omit both `-f` arguments on all four commands. Do not switch network/proxy configurations as part of this update. The dependency step starts stopped PostgreSQL/Redis containers without recreating existing ones and waits for health checks. Keep the `&&` chain so a failed build, dependency check or migration prevents application recreation. The migration command checks/applies previously committed migrations; M5 itself adds none. These are deployment instructions only: the implementation task does not run them, restart the running stack or push to GitHub.

### Deployment recovery: P1001

If migration reports `P1001: Can't reach database server at postgres:5432`, check container state with `docker compose --profile app ps --all` using the installation's current Compose files. A previous `down` can leave PostgreSQL/Redis stopped, including when it is interrupted. `run --no-deps` and `up --no-deps` skip starting dependencies; an application container reported as `Started` does not establish database connectivity or successful migration.

If the images already built successfully and PostgreSQL/Redis are stopped, run this from the repository for an installation using only `compose.yaml`:

```sh
docker compose up -d --no-recreate --wait --wait-timeout 120 postgres redis &&
docker compose --profile app run --rm --no-deps api pnpm db:migrate &&
docker compose --profile app up -d --no-deps --force-recreate api bot miniapp
```

For an installation already using the production override, add `-f compose.yaml -f compose.production.yaml` immediately after `docker compose` in every command above and below. Existing database/cache containers are preserved; stopped ones are started. Rebuilding images or reseeding is unnecessary for this recovery. If dependency startup or migration fails, resolve that failure before recreating applications.

After the API has started, verify container state and database/cache readiness:

```sh
docker compose --profile app ps --all
curl --fail --silent --show-error http://127.0.0.1:8088/ready
```

Use the configured frontend port if it differs from 8088. PostgreSQL/Redis should be healthy, the API should remain running, and `/ready` should return `{"status":"ok"}`. The readiness endpoint may briefly fail while the API starts; retry after startup. These recovery commands are for the server operator and are not run by the implementation task.

If PostgreSQL/Redis are healthy and migrations succeeded but the API keeps restarting, check configuration before repeating migrations. In particular, `MINIAPP_ORIGIN` must be the frontend's HTTPS origin (scheme, hostname and optional port, with no path, credentials, query or fragment). For a single-origin installation, use the origin of the existing `MINIAPP_URL`. Malformed URL fields now produce a field-specific `Invalid environment` message without exposing their values; older images may show only the generic startup failure. Correct the server's `.env`, then recreate application containers with the current Compose file set. A configuration-only correction requires neither a rebuild nor another migration:

```sh
docker compose --profile app up -d --no-deps --force-recreate api bot miniapp
```

Verify `/ready` again after startup. The Mini App classifies proxy 502/503/504 responses as temporary service unavailability, so backend outages no longer present as a request to sign in again.
