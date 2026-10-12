# Cached stats (M3)

The API process hosts the BullMQ scheduler and bounded workers. Profile/stat reads
never call external APIs. Steam identity alone makes a CS2 profile eligible;
FACEIT verification requires an exact `games.cs2.game_player_id` match to the
linked Steam ID. `Cs2GameProvider` implements the existing provider interface.

## API

All three endpoints require the existing bearer session. Mutations require current
onboarding consent and a Steam link.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/me/stats` | Owner-only cached Steam summary, bans, all games, CS2 minutes, FACEIT and sync status |
| `POST /api/me/sync` with `{}` | `202` queues refresh; persistent per-user cooldown, `429 STATS_SYNC_COOLDOWN` on repeat |
| `POST /api/me/faceit/link` with `{"nickname":"..."}` | Lookup and strict Steam match, save verified FACEIT cache, return owner stats |

FACEIT nickname lookup is rate-limited and makes two bounded provider requests;
if a slow upstream exceeds the WebView timeout, reread saved status before retrying.
A nickname mismatch never overwrites the previous association. Automatic refresh
uses the linked FACEIT player ID, so nickname changes do not break it. An
authoritative CS2 ownership mismatch or removed FACEIT player invalidates its old
association. Transient failures preserve the previous cache.

Responses and inputs are Zod contracts in `packages/shared`. The Mini App displays
minutes as hours, localized bans, last successful provider cache timestamps,
private-profile guidance, FACEIT metrics and refresh cooldown. All strings are RU/EN
translations. Pending status polling only reads cached rows, stops on logout or
after five minutes, and offers a saved-status retry control.

## Cache, privacy and scheduling

`user_games` stores every accessible owned title, not only CS2, with integer
`playtime_total` and `playtime_2weeks` minutes. Catalog matches populate nullable
`game_id`. Removed titles and hidden libraries are deleted from the cache. Private
Steam profiles skip the library request. Unknown/private activity remains unknown,
not a fabricated zero-hour CS2 record. Malformed or failed upstream responses
preserve the old cache. The owner response includes their cache even when activity
sharing is off; `serializePublicStats` explicitly omits `games` and `cs2` unless
`shareSteamActivity` is true. No public feed endpoint is introduced in M3.

Migration `202610120001_stats_sync` adds `stats_sync`, its user cascade, status
check and `(next_refresh_at,user_id)` index. It records attempts, successes, due
time, manual cooldown and a three-minute lease; raw provider payloads and secrets
are never persisted. Writes lock the existing user after provider requests finish
and recheck the lease/account identity. Deletion or superseded leases cannot be
undone by an in-flight refresh. FACEIT write conflicts use a savepoint so successful
Steam data can still commit.

The BullMQ repeatable scheduler scans once per minute, taking up to 100 stale
accounts. New Steam links become eligible on the next scan. Per-user jobs dedupe
while waiting/active and receive 0–60s initial jitter. A successful full refresh is
due after `STATS_REFRESH_HOURS` plus 0–5min positive jitter. Abandoned enqueue/lease
states are eligible again after their deadline. Failed accounts get a ten-minute
recovery deadline so they do not monopolize each scan; permanent failures are
retried at that recovery interval. Disabled/banned/deleted accounts are skipped.

Each job has four attempts with exponential 30s seed, up to 25% positive jitter and
15min cap. An upstream `Retry-After` is a minimum, even above that cap. Each user
fails independently. Redis spaces every outgoing request per provider globally,
including nickname lookups, and publishes a provider-wide 429 cooldown immediately.
Sleepers recheck cooldown before sending. The worker limit is set globally on the
queue and per worker. [BullMQ schedulers](https://docs.bullmq.io/guide/job-schedulers)
and [global concurrency](https://docs.bullmq.io/guide/queues/global-concurrency)
describe the primitives used here.

Only fixed error codes reach logs, API responses and BullMQ failure metadata.
Steam's query-string key, FACEIT authorization, upstream errors and bodies are
discarded. The transport rejects redirects and unexpected hosts, bounds bodies
and applies request/body deadlines. Missing keys yield provider availability = false;
neither missing key causes app startup or stat reads to crash. If both are absent,
manual refresh returns `503 STATS_UNAVAILABLE`.

## Configuration

Existing variables: `STEAM_WEB_API_KEY`, `FACEIT_API_KEY`, `STATS_REFRESH_HOURS=6`.
New optional variables (defaults work without editing `.env`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `STATS_WORKER_CONCURRENCY` | `3` | Queue-global and per-worker concurrency, range 1–10 |
| `STATS_MANUAL_COOLDOWN_SECONDS` | `300` | Manual refresh cooldown, range 120–3600 |
| `STATS_STEAM_INTERVAL_MS` | `1000` | Minimum global Steam request spacing, range 250–10000 |
| `STATS_FACEIT_INTERVAL_MS` | `1000` | Minimum global FACEIT request spacing, range 250–10000 |

These are conservative application limits, not claims of published provider quotas.
BullMQ is the only new runtime dependency. It uses the existing Redis service;
no additional deployment service is required.

## Validation and deployment review

Fixtures are anonymized, documentation-shaped examples, not captured live traffic.
Read [the verified/unverified mapping boundary](api-mappings.md) before reviewing
real provider values. Steam owned-game fields/timecreated could not be verified
because the linked Valve wiki returned 403. FACEIT's official schema does not name
its dynamic CS2 KD/win-rate/map fields. Missing metrics remain nullable.

Local commands: `pnpm typecheck`, `pnpm test`, `pnpm build`. Optional PostgreSQL
integration: migrate/seed a separate database ending `_test`, then set
`TEST_DATABASE_URL` and run `pnpm test:integration`. Tests include cache writes,
private library removal, concurrent cooldown reservation, stale selection and
deletion during an upstream request. No test reads provider keys or calls real
Steam/FACEIT APIs. Queue/gate unit tests use fake Redis; a live Redis worker run
and a real-provider device check remain deployment review items.

After transferring the reviewed commits to an **already running server**, run
from the Squad repository with the same Compose configuration currently in use:

```sh
docker compose --profile app build api bot miniapp
docker compose --profile app run --rm --no-deps api pnpm db:migrate
docker compose --profile app up -d --no-deps --force-recreate api bot miniapp
```

If that server already uses `compose.production.yaml`, add
`-f compose.yaml -f compose.production.yaml` immediately after `docker compose`
in each command. Keep the current tunnel and proxy/network configuration. The
commands rebuild application images, migrate and recreate application containers;
they do not stop or recreate PostgreSQL/Redis. The existing CS2 seed remains valid.
No deployment or remote push is performed by this implementation task.
