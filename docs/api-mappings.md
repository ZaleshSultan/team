# External stats API mappings (M3)

Checked against the providers' official documentation on 2026-10-12. Tests replay
local, anonymized contract fixtures; they do not contact providers or read API keys.
Fixtures are documentation-shaped examples, **not** a claim of a live response capture.

## Verified request contracts

Steam uses the public HTTPS host `api.steampowered.com` with the Web API key in the
`key` query parameter. The partner host requires publisher credentials and is not
used. See [Valve's Web API overview](https://partner.steamgames.com/doc/webapi_overview).

| Method | Path | Parameters |
| --- | --- | --- |
| GET | `/IPlayerService/GetOwnedGames/v1/` | `steamid`, `include_appinfo=true`, `include_played_free_games=true` |
| GET | `/ISteamUser/GetPlayerSummaries/v2/` | `steamids` |
| GET | `/ISteamUser/GetPlayerBans/v1/` | `steamids` |

Owned games include played free games, with no app filter. Valve documents that
game details must be visible; see [IPlayerService](https://partner.steamgames.com/doc/webapi/IPlayerService).
Summary and ban field names below match the examples in
[ISteamUser](https://partner.steamgames.com/doc/webapi/ISteamUser).

FACEIT uses `https://open.faceit.com/data/v4`, with a server key in the
`Authorization: Bearer …` header, as specified in its
[authentication documentation](https://docs.faceit.com/docs/data-api/). The official
[Data API v4 reference](https://docs.faceit.com/docs/data-api/data/) specifies these routes:

| Method | Path | Purpose/parameters |
| --- | --- | --- |
| GET | `/players` | Auto-detect: `game=cs2`, `game_player_id=<linked Steam ID>` |
| GET | `/players` | Nickname fallback: `nickname` |
| GET | `/players/{player_id}` | Refresh linked accounts by stable ID after renames |
| GET | `/players/{player_id}/stats/cs2` | Lifetime stats/segments |

The player fields `player_id`, `nickname`, `faceit_url`, and
`games.<game>.game_player_id`, `skill_level`, `faceit_elo` are documented. Only the
exact CS2 game player ID proves ownership; neither legacy CS:GO nor top-level
Steam fields are accepted as substitutes. FACEIT's own `verified` flag does not
establish this application's ownership relationship.

## Storage mapping

| Response | Cache field |
| --- | --- |
| Steam `personaname`, `avatarfull`, `profileurl`, `communityvisibilitystate` | `steam_accounts.persona_name`, `avatar_url`, `profile_url`, `profile_visibility` |
| Steam `timecreated` (seconds, optional; verification limit below) | `steam_accounts.time_created` |
| Steam `NumberOfVACBans`, `NumberOfGameBans`, `DaysSinceLastBan`, `CommunityBanned`, `EconomyBan` | Corresponding ban fields |
| Steam owned `appid`, `name`, `playtime_forever`, `playtime_2weeks` (verification limit below) | All `user_games` rows, playtime in minutes; absent recent playtime is zero |
| FACEIT CS2 `skill_level`, `faceit_elo` | `faceit_accounts.level`, `elo` |
| FACEIT dynamic lifetime/segments (verification limit below) | Nullable `kd`, `win_rate`, `favorite_maps` |

An unranked FACEIT skill level of zero is stored as unknown (`null`). Catalog
matching and timestamps belong to the stats service, outside the adapters.
The adapters never persist a raw upstream response. IDs are matched to the requested
account before the service receives data. Names are bounded to database limits;
external profile/avatar URLs are HTTPS and provider-host restricted, and query or
fragment-bearing display URLs are discarded.

## Verification limits — review before deployment

1. Valve's current Steamworks page does **not** provide the owned-games response
   schema or the optional summary `timecreated` field. The official
   [Steam Community developer page](https://steamcommunity.com/dev) links to the
   [Valve developer wiki](https://developer.valvesoftware.com/wiki/Steam_Web_API),
   which returned HTTP 403 during this work. Thus `response.game_count`,
   `response.games`, `appid`, `name`, `playtime_forever`, `playtime_2weeks`,
   `timecreated`, minute units, and the public-visibility numeric interpretation
   are **unverified against accessible official field documentation** here.
   The bounded fixtures exercise this explicit contract; they do not replace
   provider verification.
2. FACEIT's OpenAPI defines `lifetime` and `segments` as dynamic objects. It does
   **not** specify CS2 metric names or map segment members. The exact optional
   keys `Average K/D Ratio`, `Win Rate %`, `type=Map`, `label`, and `stats.Matches`
   are therefore an **unverified mapping**, not a guaranteed schema. No alternate
   keys are guessed at runtime. Missing, renamed or malformed values yield
   `null` / `[]`, while verified player level and ELO remain available. Favorite
   maps mean up to five map labels with most recorded matches, combined across
   segment modes; this is an application choice, not an official favorite flag.

No real Steam/FACEIT calls were made with credentials. Before deploying, use a
controlled real account to verify the explicitly unverified fields above. API
changes cannot cause guessed zero KD/win rate, cross-account association, or raw
provider errors to appear in client responses.

## Privacy and operational behavior

A private/friends-only Steam summary skips library requests and produces no games.
For an otherwise public profile, an absent games payload marks game details hidden.
An explicit `game_count=0` represents an accessible empty library. This distinction
is conservative and depends on the Steam response contract noted above. HTTP or
malformed-response failures preserve the previous cache rather than masquerading
as an empty private library. Valid FACEIT identity with missing stats (404) retains
level/ELO with unknown metrics.

Transport rejects redirects, applies request/body deadlines and byte limits, and
throws only fixed `ProviderError` metadata (provider, code, retryability, status,
Retry-After duration). Original exceptions, URLs, response bodies and authorization
headers are discarded. Keys are held in non-enumerable JavaScript private fields.
The supplemental redactor masks a `key` query value and Bearer token, but production
logs should never receive provider URLs at all. The queue supplies a shared provider
gate and handles retries, exponential backoff and Retry-After; adapters make one
attempt per call so worker retries do not multiply hidden HTTP retries.
