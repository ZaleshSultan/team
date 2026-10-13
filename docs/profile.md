# M4: CS2 profiles and public privacy boundary

M4 adds an owner-only editor, publication state and preview. Search/feed, contact exchange and moderation remain M5–M7. Profile reads use the existing cached Steam/FACEIT rows; they never request upstream APIs. No new runtime dependencies or environment variables are required.

## Endpoints and ownership

All endpoints require an unexpired bearer session. Identity always comes from that session; there is no user-id parameter. Unknown input properties are rejected.

| Method | Path | Request / response |
| --- | --- | --- |
| GET | `/api/me/profile/cs2` | `{profile, published, requirements, privacy, badges, options}`; missing profile is `null` |
| PUT | `/api/me/profile/cs2` | Complete editor input; upserts the single `(user_id, game_id)` profile and returns the same owner response |
| PUT | `/api/me/profile/cs2/publish` | `{published: boolean}` → `{published, requirements}` |
| GET | `/api/me/profile/cs2/preview` | Direct strict `PublicPlayerCard`; missing profile is 404 `PROFILE_NOT_FOUND` |
| PATCH | `/api/me/privacy` | `{shareSteamActivity: boolean}` → `{user}` using the existing owner auth-user contract |
| DELETE | `/api/me` | Existing `{confirmation: "DELETE"}` → 204; cascades all owned rows and revokes sessions |

The editor is shown after onboarding and Steam linking. Account deletion is available to every signed-in user, including those still onboarding or without Steam. The client discards its in-memory session only after successful deletion. A confirmation checkbox and a second explicit action are required.

## Provider rules

`GameProvider.validateProfile` owns all game-specific validation. `Cs2GameProvider.profileOptions` supplies the editor choices. Shared Zod schemas define structural transport types; the database keeps a generic `game_id`.

| Field | Allowed values / rule |
| --- | --- |
| `nickname` | Nullable; blank becomes null. 2–32 Unicode code points when set: letters, decimal digits, spaces, `_`, `-`, `.` |
| `roles` | `entry`, `awp`, `support`, `lurk`, `igl`; 1–3 distinct values |
| `lookingFor` | `duo`, `five_stack`, `team`; 1–3 distinct values |
| `playTimes` | `morning`, `day`, `evening`, `night`; 1–4 distinct values |
| `languages` | `ru`, `kk`, `en`, `de`, `fr`, `es`, `it`, `pt`, `tr`, `uk`, `pl`, `uz`, `ky`, `tg`, `az`, `hy`, `ka`, `be`, `zh`, `ko`, `ja`, `ar`; 1–4 distinct values |
| `region` | `KZ`, `RU`, `CIS`, `EU`, `OTHER` |
| `hasMic` | Boolean, including false |
| `bio` | Optional content, required string field; at most 500 Unicode code points |

Selections are trimmed, normalized and deduplicated before limits are checked. Roles, goals, times and language codes become lowercase; region becomes uppercase. Text uses NFC, collapsed whitespace, and strips control, formatting, zero-width and variation-selector characters. A final NFC pass handles combining characters exposed by stripping.

Nickname and bio reject URL schemes, domain links (including IDNA dot variants), IPv4 links, `@` handles and phone-like sequences of seven or more decimal digits with phone separators. Detection also checks Unicode compatibility forms. These intentionally conservative rules can reject a numeric identifier or dotted nickname that resembles contact information. They are not a substitute for future moderation of deliberately disguised contacts.

Validation returns 400 `PROFILE_VALIDATION_FAILED` with `field` and `issues: [{code, field}]`. Codes are fixed shared enum values (`REQUIRED`, `INVALID_TYPE`, `INVALID_OPTION`, `TOO_MANY`, `TOO_SHORT`, `TOO_LONG`, `INVALID_FORMAT`, `CONTACTS_NOT_ALLOWED`, `UNKNOWN_FIELD`). Errors never echo submitted values or unknown property names.

Public display name uses the saved nickname, then the cached Steam persona name if that name passes the same safety rules. Unsafe, missing or out-of-range fallback names become null; the UI uses a translated generic label. Legacy invalid profile content returns 409 `PROFILE_INVALID` on preview and blocks publication until the owner saves a valid profile.

## Publication and badges

Publishing requires all of:

- Current age confirmation, current community rules and a Telegram username.
- A linked Steam account.
- A saved, complete profile that passes the current provider rules.
- An account that is not banned.

Failures return 409 `PUBLISH_REQUIREMENTS_MISSING` (403 when banned) and the complete missing-requirements list. Requirement codes are `ONBOARDING_INCOMPLETE`, `STEAM_REQUIRED`, `PROFILE_INCOMPLETE`, `PROFILE_INVALID`, `USER_BANNED`; incomplete fields can be listed separately. The editor displays how to resolve each requirement.

Unpublishing is idempotent and allowed even without a profile, Steam, current onboarding or a non-banned account. It still requires an unexpired owner session. The banned-account authentication exception applies only to the publication endpoint; publishing true rechecks the ban under a row lock.

Private Steam profiles and hidden game details do not block publication. The existing stats guidance explains why activity may be unavailable. Missing provider keys also do not block the editor or publication.

`GameProvider.isVerified` computes badges from linked identities. `steamVerified` means Steam is linked. `faceitVerified` requires a FACEIT account whose Steam ID exactly equals the linked Steam ID. Mismatched FACEIT stats are excluded from public cards.

Save, publish and privacy mutations lock and reread the owner row in short transactions, serializing against deletion and bans. No network calls run under these locks. Future M5 selection must also recheck current eligibility: later username, consent-version or ban changes can invalidate an already-published profile. `isPublished` alone is not an authorization or discovery filter.

## Public privacy matrix

`serializePublicPlayerCard` is the sole public projection; `publicPlayerCardSchema` is strict at the top level and inside nested objects. The old M3 prototype public-stats serializer has been retired. Owner stats remain owner-only.

| Field | Sharing off (default) | Sharing on |
| --- | --- | --- |
| Opaque profile UUID | Included | Included |
| Safe display nickname, profile choices, mic, bio | Included | Included |
| Steam/FACEIT verification badges | Included | Included |
| Matching FACEIT level/ELO | Included; nullable | Included; nullable |
| `hasBans` (VAC, game, community, economy) | Included; null when unknown | Included; null when unknown |
| `activity.cs2Hours`, `activity.cs2Hours2weeks` | Entire activity object omitted | Exact cached minutes divided by 60; nullable when unknown |
| Telegram ID/username, internal user ID, Steam ID | Never | Never |
| Steam/FACEIT account IDs, URLs and account nicknames | Never | Never |
| Library, other games, raw minutes, sync metadata | Never | Never |

Public preview uses exactly this serializer, including when the profile is still a draft. Privacy changes invalidate the displayed preview and fetch a new card from the server. Form edits never create a public card from owner data. No avatars are displayed; the existing narrow image CSP is unchanged.

## UI, verification and deployment

Russian is the default; English has the same translation keys. The form provides selection limits, live text counters/errors, save feedback, publication checklist, preview and sharing explanation. Unsaved input enables both browser navigation protection and Telegram closing confirmation, with an explicit logout warning.

ThemeParams and live `themeChanged` follow the [official Telegram Mini App API](https://core.telegram.org/bots/webapps#themeparams).

Migration `202610130001_m4_profile_nickname` adds nullable `player_profiles.nickname VARCHAR(32)` without rewriting existing rows. Provider tests use no external keys or DB. Integration tests require a separate database ending `_test`, test migration shape, upsert, ownership, publish/unpublish, privacy and deletion cascades, and clean only their own test identities. Real-device Telegram behavior remains a separate acceptance check.

After transferring the reviewed commits to the server, rebuild, migrate, and recreate application services using the same Compose file set already in use:

```sh
docker compose --profile app build api bot miniapp
docker compose --profile app run --rm --no-deps api pnpm db:migrate
docker compose --profile app up -d --no-deps --force-recreate api bot miniapp
```

For a stack already using `compose.production.yaml`, add `-f compose.yaml -f compose.production.yaml` immediately after `docker compose` in each command. No new seed or environment change is needed. These commands are instructions only; development of M4 does not change or deploy the running stack.
