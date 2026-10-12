import { statsResponseSchema, statsSyncSchema, type StatsResponse, type StatsSync } from '@squad/shared';
import type { Prisma } from '@prisma/client';

export const statsIncludes = { steamAccount: true, faceitAccount: true, userGames: true, statsSync: true } as const;
export type StatsUser = Prisma.UserGetPayload<{ include: typeof statsIncludes }>;
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

export function serializeSync(sync: StatsUser['statsSync'], now = new Date()): StatsSync {
  const expired = sync?.status === 'RUNNING' && (!sync.lockedUntil || sync.lockedUntil <= now);
  return statsSyncSchema.parse({ status: expired ? 'FAILED' : sync?.status ?? 'IDLE', lastAttemptAt: iso(sync?.lastAttemptAt),
    lastSuccessAt: iso(sync?.lastSuccessAt), nextRefreshAt: iso(sync?.nextRefreshAt),
    manualAvailableAt: iso(sync?.manualAvailableAt), lastErrorCode: expired ? 'STATS_UNAVAILABLE' : sync?.lastErrorCode ?? null });
}

export function serializeOwnStats(user: StatsUser, availability: StatsResponse['availability'], now = new Date()): StatsResponse {
  const steam = user.steamAccount;
  const faceit = user.faceitAccount;
  const games = user.userGames.map((game) => ({ steamAppId: game.steamAppId, gameId: game.gameId, name: game.name,
    playtimeTotal: game.playtimeTotal, playtime2weeks: game.playtime2weeks, syncedAt: game.syncedAt.toISOString() }));
  const cs2 = games.find((game) => game.steamAppId === 730);
  return statsResponseSchema.parse({
    steam: steam ? { steamId64: steam.steamId64.toString(), personaName: steam.personaName, avatarUrl: steam.avatarUrl,
      profileUrl: steam.profileUrl, profileVisibility: steam.profileVisibility, gameDetailsPublic: steam.gameDetailsPublic,
      timeCreated: iso(steam.timeCreated), syncedAt: iso(steam.syncedAt),
      bans: { vacBans: steam.vacBans, gameBans: steam.gameBans, daysSinceLastBan: steam.daysSinceLastBan,
        communityBanned: steam.communityBanned, economyBan: steam.economyBan },
      cs2: cs2 ? { playtimeTotal: cs2.playtimeTotal, playtime2weeks: cs2.playtime2weeks } : null, games } : null,
    faceit: faceit ? { playerId: faceit.playerId, nickname: faceit.nickname, profileUrl: faceit.profileUrl,
      level: faceit.level, elo: faceit.elo, kd: faceit.kd, winRate: faceit.winRate, favoriteMaps: faceit.favoriteMaps,
      syncedAt: iso(faceit.syncedAt), verified: Boolean(steam && steam.steamId64 === faceit.steamId64) } : null,
    availability, guidance: [
      ...(steam?.profileVisibility != null && steam.profileVisibility !== 3 ? ['STEAM_PROFILE_PRIVATE'] : []),
      ...(steam?.gameDetailsPublic === false ? ['STEAM_GAME_DETAILS_HIDDEN'] : []),
    ], sync: serializeSync(user.statsSync, now),
  });
}

// Explicit allow-list: never return library, exact activity, sync metadata or
// guidance by spreading the owner-only response into a public response.
export function serializePublicStats(stats: StatsResponse, privacy: { shareSteamActivity: boolean }) {
  const steam = stats.steam;
  return {
    steam: steam ? { steamId64: steam.steamId64, personaName: steam.personaName,
      avatarUrl: steam.avatarUrl, profileUrl: steam.profileUrl, bans: { ...steam.bans },
      ...(privacy.shareSteamActivity ? { cs2: stats.steam!.cs2, games: stats.steam!.games.map((game) => ({ ...game })) } : {}),
    } : null,
    faceit: stats.faceit ? { playerId: stats.faceit.playerId, nickname: stats.faceit.nickname,
      profileUrl: stats.faceit.profileUrl, level: stats.faceit.level, elo: stats.faceit.elo,
      kd: stats.faceit.kd, winRate: stats.faceit.winRate, favoriteMaps: [...stats.faceit.favoriteMaps], verified: stats.faceit.verified } : null,
  };
}
