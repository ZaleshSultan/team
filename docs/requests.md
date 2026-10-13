# M6: teammate requests and contacts

M6 adds invitations from CS2 feed cards, incoming/outgoing request history, live accepted-contact checks, minimal blocking and bot notifications. Moderation/report UI remains M7. Russian is the default UI language, with matching English translations. The running stack, production database and live bot are not used during development/testing.

## Model and migration

`202610140001_m6_requests` reuses `teammate_requests` and `blocks`, retaining their user-deletion cascades and the stronger reciprocal pending-pair unique index. It renames the legacy enum spelling `CANCELLED` to `CANCELED`, narrows `message` to 200 PostgreSQL characters, adds `expires_at`, an outbox/status index and an expiry index, and creates `request_notifications` with cascade links to its request/recipient. Existing migrations are unchanged.

Legacy messages longer than 200 characters are truncated by the migration. Legacy requests get `expires_at = created_at + 7 days`; the database default is seven days for compatibility, while application-created requests explicitly use configured `REQUEST_TTL_DAYS`. Messages exposed by the API are normalized and checked again; unsafe legacy contact text becomes null. Request rows, notification rows and Redis jobs never store the exchanged Telegram username.

## API and authorization

Every route requires a valid session and current onboarding consent/username. Invalid sessions return 401, banned callers 403, and incomplete onboarding `403 ONBOARDING_INCOMPLETE`. Strict shared Zod contracts reject unknown body/query fields. The per-user request route limit defaults to 60/minute; it uses the existing validated user key across sessions/IPs. Anonymous traffic uses the IP fallback.

| Route | Behavior |
| --- | --- |
| `POST /api/requests` | `{toProfileId, message?}`; send to an eligible CS2 profile. |
| `GET /api/requests/incoming` | Own inbox, `{items,nextCursor}`. |
| `GET /api/requests/outgoing` | Own outbox, same shape. |
| `GET /api/requests/summary` | `{pendingIncoming}` for the navigation badge; counts only unexpired pending rows. |
| `GET /api/requests/:id` | Participant-only request detail; a contact appears only after acceptance and a fresh live check. |
| `POST /api/requests/:id/accept` | Recipient only, pending only; live contact preflight, then locked state transition. |
| `POST /api/requests/:id/decline` | Recipient only, pending only; no sender notification. |
| `POST /api/requests/:id/cancel` | Sender only, pending only. |
| `POST /api/blocks/:profileId` | Eligible sender and target; idempotently create my block and cancel pending requests in both directions, across all games. |
| `DELETE /api/blocks/:profileId` | Remove only my block. Target can have become unavailable/unpublished; caller still needs send eligibility. Another user's block is never removed. |

State actions accept no body or `{}`. Lists accept only `limit` (default 20, maximum 50) and `cursor`. Ordering is `(created_at DESC, id DESC)` with a strict keyset predicate. Signed base64url cursors reuse the existing codec, scoped to the caller and incoming/outgoing direction; malformed/tampered/reused cursors return fixed 400 errors. A stranger's request ID and a missing/malformed request ID return the same `404 REQUEST_NOT_FOUND`, including wrong-side accept/decline/cancel attempts.

List items contain request ID/status/message/timestamps and only the existing `PublicPlayerCard` projection of the other participant. No Telegram ID/username, internal user ID, Steam ID or game library appears. Activity remains gated by current privacy settings. History can retain a safe public card after unpublication/blocking; a missing/unsafe/banned player's card becomes null. This is participant history, not public discovery, and never reveals a contact in the list.

## Sending and concurrency

The transaction finds the target profile, locks both user rows in UUID order with `SELECT ... FOR UPDATE`, and re-reads their current state. This same order is used for acceptance, blocking and accepted-contact reads. The sender row serializes concurrent sends to different targets, so quota races cannot exceed the daily limit.

Sending requires current onboarding, Steam, a valid published CS2 profile and an active account. The target must have the same base eligibility as a feed candidate: published valid CS2 profile, Steam, nonempty username, current age/rules consent, not banned, and `botBlocked=false`. Ban-count filtering remains a feed preference rather than an unconditional sending prohibition. Self-invites fail with `REQUEST_SELF`.

Inside the transaction, due pending rows between this pair are expired, symmetric blocks are checked, and pending/accepted requests are checked in either direction across all games. A reverse pending request returns `REQUEST_ALREADY_RECEIVED` and the UI links to the inbox. An own pending request returns `REQUEST_ALREADY_SENT`; any accepted request returns `REQUEST_ALREADY_ACCEPTED`. A caller-to-target decline with `resolved_at >= now - DECLINED_REQUEST_COOLDOWN_DAYS` returns `REQUEST_DECLINED_RECENTLY`; the reused constant is 14 days, inclusive. Reverse/older declines do not prevent sending.

`REQUESTS_PER_DAY` counts **all outgoing statuses** in the rolling window `created_at > now - 24h`. Cancelling or being declined does not refund quota. At the exact 24-hour boundary that row leaves the window. A full quota returns `429 DAILY_LIMIT_REACHED`, an ISO `error.resetAt`, and `Retry-After`. If the configured quota is lowered below the existing count, reset is when enough of the most recent requests have expired from the window to allow another send.

Messages use the shared bio contact filter plus a 200-Unicode-character budget: handles, links/domains, IPv4/IPv6 addresses and phone-like numbers are rejected. Normalization removes invisible controls and unifies whitespace. UI counters and validation use the same character semantics.

The new request and its CREATED outbox event commit atomically. Immediate dispatch is fire-and-catch, so Redis downtime cannot delay an already committed response. The maintenance worker retries durable events. An acceptance similarly commits the state/resolution timestamp and ACCEPTED event atomically. Decline/cancel enqueue no notifications. Concurrent sends/accept/decline/block use locks plus conditional status checks, and one transition wins; later transitions return a fixed conflict.

## Expiration and blocking

Requests expire after seven days by default. The API's BullMQ maintenance scheduler runs every 60 seconds. It selects up to 500 due pending request rows with `FOR UPDATE SKIP LOCKED`, conditionally marks only still-pending rows EXPIRED and sets `resolved_at`. It does not acquire user locks after request locks, avoiding a lock-order cycle with interactive mutations. Existing accepted/resolved requests are never overwritten.

Reads show due pending rows as EXPIRED, the badge excludes them, and the feed immediately stops excluding them even before the worker updates storage. Accepting a due pending row persists its expiry and returns `REQUEST_EXPIRED`. Sending to a pair also lazily expires its due pending rows before checking uniqueness.

A block transaction cancels all pending requests between the pair and hides them from discovery. Blocking also denies subsequent accepted-contact reads and suppresses queued notifications. Unblocking removes only the caller's block; it does not reopen cancelled requests or remove a reciprocal block. Minimal block controls require confirmation in the UI; moderation extensions arrive in M7.

## Contact visibility

Acceptance performs bounded Telegram `getChat` checks for both participants outside the database transaction, then reacquires the ordered user/request locks and rechecks ownership, current consent/eligibility, pending status, expiry and symmetric blocks before committing. The accepting recipient receives the sender's current username only after a successful acceptance. `GET /api/requests/:id` rechecks the other participant's current username on every accepted-contact read and repeats local state/block checks after the external lookup.

Missing/invalid contacts, cached bot blocking, 403, timeout, 429 or network failures return fixed `CONTACT_UNAVAILABLE`; acceptance remains pending. A Telegram 403 also records `botBlocked=true`. The adapter accepts the basic username or a current active/collectible username from `ChatFullInfo`, validates its syntax and exact private chat ID, and retains no raw response or error URL. Telegram `getChat` does **not** guarantee immediate detection of a user blocking the bot: detection relies on the cached flag and Telegram 403 failures, including delivery failures. A later private `/start` clears the known bot-blocked flag.

Contact checks are point-in-time: Telegram can change a username/block state immediately after a successful check. Contacts remain only in component memory; refreshing the request list discards them. The Mini App first fetches the checked contact, then renders a separate synchronous `https://t.me/<username>` link, avoiding popup blocking after asynchronous network work. Neither lists nor localStorage contain contacts. Accepted sender notifications also recheck the accepted user's current username immediately before delivery. See [notification guarantees and transport limitations](notifications.md).

## Configuration

| Variable | Default | Bounds |
| --- | ---: | --- |
| `REQUESTS_PER_DAY` | 10 | 1–100; existing variable, now enforced. |
| `REQUEST_TTL_DAYS` | 7 | 1–30. |
| `REQUESTS_RATE_LIMIT_PER_MINUTE` | 60 | 1–600 per user. |
| `NOTIFICATION_CONCURRENCY` | 3 | 1–10, also set globally on the queue. |
| `NOTIFICATION_RATE_LIMIT_PER_SECOND` | 25 | 1–25 globally across notification workers. |
| `NOTIFICATION_MAX_ATTEMPTS` | 5 | 1–10. |
| `NOTIFICATION_BACKOFF_MS` | 1000 | 250–60000, exponential with bounded Telegram retry-after support. |
| `TELEGRAM_CONTACT_TIMEOUT_MS` | 5000 | 500–10000. |

The bot additionally requires the existing `DATABASE_URL` and `REDIS_URL`. Compose now supplies internal PostgreSQL/Redis addresses and waits for healthy dependencies. Notifications run within the bot process; request maintenance runs within the API process, so both must be restarted for M6. No new external service is introduced. Development lint tooling uses ESLint 10 and requires Node 22.13+; worker dependencies reuse the versions already present in the API workspace.

## Verification

Automated tests use recorded fixtures/test doubles and a separate loopback `*_test` PostgreSQL instance. Production `.env` values/live bot credentials are not used. Tests exercise sending rules in both directions/across games, rolling quota boundaries, simultaneous sends/quota/accept/decline/block, expiry, deletion cascades, keyset integrity, ownership 404s, public activity gating, no pre-accept contact leak, fresh contacts and failed checks. Bot tests cover duplicate jobs, claims/retries, invalid jobs, 403, 429, rate/retry settings and sanitized failures. Mini App tests cover invitations, paging, states, contact URL validation, confirmation and badge polling.

Final verification on 2026-10-13, after restoring GitHub stable `6490579` and continuing M6 on that base: `pnpm lint`, `pnpm typecheck`, `pnpm test` (**509 API + 200 Mini App + 68 bot = 777 unit tests**), the full isolated PostgreSQL suite (**199 integration tests**, including 105 M6 tests), and `pnpm build` passed. After the final strict send-query check, all unit tests, lint, API typecheck/build and all 105 M6 integration tests passed again. Stable configuration URL validation, temporary-outage presentation and their regression tests remain intact.

The migration was applied to a fresh isolated PostgreSQL 18 database and separately tested as an upgrade from the first three migrations with legacy `CANCELLED` rows and 220-character Unicode messages. Enum renaming, truncation to 200 characters, expiry backfill and request/outbox deletion cascades passed assertions. Production PostgreSQL 16 was not exercised.

Browser QA used the actual Mini App with mocked HTTP on a separate local port at 390×844: validation/counter, send, daily reset, unavailable/reverse-request states, both tabs, paging, accept/decline/cancel, contact failure, explicit checked-contact link, badge 2→0, block removal, dirty-profile confirmation, ru/en and light/dark passed. Contacts cleared on refresh; no horizontal overflow was observed. The preview/tab were closed. This browser run preceded the stable-base update; that update retained the same request UI and added the separately tested stable auth error panel.

`docker compose --profile app build` was attempted, but Docker Desktop's Linux Engine was unavailable (`dockerDesktopLinuxEngine` pipe missing), so **Docker images were not built**. Real Telegram accounts/devices, notification receipt, Mini App launch from bot messages, bot-block behavior, live Redis/BullMQ delivery and production load remain unverified. No real notifications were sent, no production database was accessed, and no running stack was restarted. Delivery uses bounded retries; duplicates or undelivered notifications remain possible in the documented failure windows, so exactly-once delivery is not claimed.

## Deployment

Review/backup the database before the migration: it intentionally truncates old messages over 200 characters. Obtain the committed update on the server and use the **same Compose files** already used by that installation. For a current plain `compose.yaml` installation behind the tunnel:

```sh
git pull --ff-only origin main &&
docker compose --profile app build api bot miniapp &&
docker compose up -d --no-recreate --wait --wait-timeout 120 postgres redis &&
docker compose --profile app run --rm --no-deps api pnpm db:migrate &&
docker compose --profile app up -d --no-deps --force-recreate api bot miniapp &&
docker compose --profile app ps --all &&
curl --fail --silent --show-error http://127.0.0.1:8088/ready
```

For an existing installation using `compose.production.yaml`, add `-f compose.yaml -f compose.production.yaml` to each Docker command. Keep the `&&` chain: a failed build, dependency check or migration must prevent application recreation. The dependency step starts stopped PostgreSQL/Redis without recreating existing containers. Use the configured frontend port if it differs from 8088; `/ready` may briefly fail while the API starts, so retry after startup. See [deployment recovery](feed.md#deployment-recovery-p1001) if database connectivity fails. Do not change proxy/network configuration during this update. The bot container includes the notification worker; recreating it restarts that worker. The API recreation restarts expiry/outbox maintenance. Keep PostgreSQL/Redis volumes. M6 development does not run deployment commands or push automatically.
