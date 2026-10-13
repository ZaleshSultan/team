# M3 review hardening

Historical M3 review record. M7 supersedes the report-deletion behavior below:
reports by the deleted user cascade; reports about them are anonymized and retained
temporarily, and audit rows survive. See [current moderation policy](moderation.md).

These changes are committed separately from M3. At the start of the task, the
Squad working tree was clean: no uncommitted `compose.yaml` changes existed.

## Database password

`compose.yaml` now requires `${POSTGRES_PASSWORD:?required}` for PostgreSQL and
the API's `DATABASE_URL`. There is no silent password fallback. Set the existing
variable in the server `.env` to the password of its initialized PostgreSQL role.
Changing an environment variable does not rotate the password of an existing
database. No `.env` file or credential was read into test output or committed.

## Request limits

Authenticated API requests are limited by the validated session's **user ID**,
not bearer token or IP. Multiple sessions for one user share a quota; distinct
users behind the same mobile-network IP have independent quotas. Invalid or
expired sessions use IP. Public Telegram login and external Steam start/callback
always use IP, even if the caller supplies a bearer header. A request-scoped
WeakMap shares the session lookup with its handler; the existing expiry and ban
checks still apply. Tokens are hashed before the DB lookup and never become
Redis rate-limit keys.

## Account deletion

`DELETE /api/me` requires a valid, unbanned session and the exact JSON body:

```json
{ "confirmation": "DELETE" }
```

Missing/wrong confirmation or extra fields are rejected before mutation. The
owner identity comes exclusively from the session. Success returns 204. Deleting
the user revokes all sessions through PostgreSQL cascades and removes privacy
settings, Steam/FACEIT accounts, game library, player profiles, Steam link/nonces,
stats sync state, requests, blocks and reports involving the user. Reports between
other users that this user merely reviewed remain, with reviewer set to NULL, as
the schema defines. Catalog games and other users remain intact. Already queued
stats tasks contain only the user ID and become no-ops when the user is absent;
in-flight cache writes lock/recheck the user and cannot recreate deleted data.

`GET /health` now returns only `{"status":"ok"}`. Shared schemas and tests match.
This hardening commit introduces no extra DB migration or runtime dependency.

## Verification

`pnpm typecheck`, `pnpm test` and `pnpm build` pass. Unit suites cover authenticated
limit keys, shared-IP isolation, invalid/expired tokens, public route behavior,
confirmation validation and session revocation. Separate integration tests run
against a disposable PostgreSQL 18 instance in the ignored project `.local`
directory on a free loopback port, with no running-stack connection:

- 25 existing auth/OpenID tests.
- 7 M3 cache/concurrency/privacy tests.
- 1 full deletion cascade test covering all user-owned models and reviewer SetNull.

API unit tests: 185 passed. Mini App unit tests: 45 passed. PostgreSQL integration:
33 passed. The temporary PostgreSQL instance is stopped after verification.
The application targets PostgreSQL 16; these migrations use no PostgreSQL 18-only
features. A Docker image build, live Redis/BullMQ worker and real-key provider
round-trip were not run in this task. Provider documentation limits are recorded
in [api-mappings.md](api-mappings.md).

Use the existing-server commands in [stats.md](stats.md#validation-and-deployment-review)
after transferring/reviewing both local commits. The task itself makes no remote
push, deployment or changes to the running application stack.
