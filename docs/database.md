# Database design

PostgreSQL is the source of truth; Prisma models map to snake_case tables and
columns. IDs are UUIDs except external Telegram and Steam IDs, which are 64-bit
integers. Convert those external IDs to decimal strings in JSON: JavaScript
numbers can lose precision and `JSON.stringify` cannot serialize `BigInt`.

## Ownership and consent

`users` stores Telegram identity, optional current username, Russian/English UI
language, ban/bot delivery flags, and timestamps/version for age confirmation and
community rules. `age_minimum_confirmed` records the configured minimum the user
confirmed; no date of birth is stored. Age threshold is application config. An
absent consent timestamp or an outdated confirmed minimum means onboarding is
incomplete.

`privacy_settings` is one row per user. Steam activity sharing defaults to false;
the application must apply this setting to public responses. Row absence must be
treated as no consent. Telegram authentication creates this row; later onboarding
can change it. Account linking does not itself publish a player profile.

`steam_accounts` keeps verified SteamID64 and nullable public metadata/bans. Null
stats or `synced_at` means unavailable/not yet fetched, never zero. Steam identity
is unique across users. `faceit_accounts` holds public cached FACEIT stats; its
compound foreign key `(user_id, steam_id64)` references the same user's Steam
account, enforcing Steam identity matching even for nickname-based linking.

## Games and search

`games` has provider slugs independent of optional Steam app IDs; the idempotent
seed registers only `cs2` / Steam app `730`. `player_profiles` is unique per user
and game. Roles, languages, play times, and looking-for values are string arrays;
the matching `GameProvider` validates allowed game-specific values. GIN indexes
support array filters; the catalog/publication index supports the initial feed.
Visibility still requires age/rules consent, a linked Steam account, and a user
who is not banned; enforce those joins in the application when publishing and
searching. The published flag alone does not establish eligibility.

`user_games` stores **every owned Steam game** returned during M3 synchronization,
not only CS2. Playtime fields are integer **minutes**, matching Steam API values.
`playtime_2weeks` may be null when the upstream data is unavailable; zero means a
known zero. `game_id` is an optional mapping to supported catalog games, so an
unknown Steam app can still be stored without adding a provider. CS2 hours are
derived from its row and are not duplicated on Steam accounts. Game clusters and
their membership are empty extension points; adding games does not change the
per-user profile or request tables.

## Requests and moderation

Requests record sender, recipient, game, status, optional short message, and
resolution time. Indexes support recipient inboxes, sender daily quotas, and
interaction exclusions. SQL adds a no-self-request check and a unique unordered
pending pair per game, preventing duplicates and reciprocal pending requests.
Accept/decline/cancel are conditional application transitions. The daily quota
and exclusion of users with past interactions belong in transactional service
logic in M6.

Blocks are unique directional pairs; feed exclusion checks both directions. SQL
rejects self-blocks and self-reports. Reports retain a reason, optional comment,
review state/time, and optional reviewing user. Deleting a user cascades their
owned data and interactions; an optional report reviewer is set to null.

Contacts are delivered only after mutual acceptance. Onboarding requires a
Telegram username so M6 can exchange usable contacts. The database permits null
because Telegram authentication admits new users before onboarding. If a username
is later removed, revalidate it before accepting/contact delivery and prompt the
user to restore it. A username must never be treated as stable identity.

## M2 authentication and external Steam browser flow

`sessions` persists only a SHA-256 hash of a random bearer token, its owning user,
creation time, and expiry. Raw tokens are returned once after validated Telegram
initData and are never stored or logged. Expired sessions must fail authorization
even before background cleanup deletes them.

`steam_links` binds a short-lived linking attempt to the authenticated user. It
stores a hash of a high-entropy one-time start code, a distinct callback-state
hash, and a browser-binding cookie hash. The start endpoint atomically claims
`PENDING` before redirecting an external browser and issues a secure HttpOnly
browser cookie. `return_to` stores only the base callback URL containing the flow
ID; it never persists raw callback state. After checking the incoming state's
hash, reconstruct the expected complete OpenID `return_to` from that stored base
and verified state, then compare it exactly. The configured realm is persisted
separately. Use `STARTED -> VERIFYING -> COMPLETED/FAILED` to claim callback
verification, also checking the same browser-binding cookie. The
Mini App polls its own link ID through session-authenticated endpoints; TTL is
checked on every transition. `started_at` marks start-code consumption;
`completed_at` and `failure_code` describe terminal outcomes without retaining
raw OpenID responses. The browser receives neither Telegram initData nor a
Mini App session token.

M2 does not replace an existing linked Steam account; doing so later requires an
explicit unlink/relink flow that clears old cached playtime and reverifies FACEIT.

`steam_openid_nonces` rejects a previously accepted Steam response nonce globally,
including reuse in another linking attempt. These public response identifiers
are not Steam credentials. `expires_at` allows cleanup after the permitted nonce
freshness window. Cleanup must not remove a nonce while it could still pass
freshness validation. A nonce insertion and account-link completion belong in
the same transaction. Never collect Steam or FACEIT passwords/session tokens.

## Migration and seed

Use `prisma migrate deploy` for checked-in migrations and `prisma db seed` for
the CS2 catalog entry. The API package needs Prisma 6 / `@prisma/client` at the
same version, `tsx`, and `"prisma": { "seed": "tsx prisma/seed.ts" }` in package
configuration. `prisma generate` does not require a live database.

The initial migration contains SQL checks/partial indexes that Prisma 6 cannot
fully represent: no-self actions, nonnegative Steam playtime, valid cached stat
ranges, and the unique unordered pending request pair. Preserve these when creating future
migrations. No demo users, contacts, or fabricated stats are seeded.
