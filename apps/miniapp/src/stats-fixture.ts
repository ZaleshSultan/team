import type { StatsResponse } from '@squad/shared';

/** Synthetic fixture; no provider keys or real account data. Imported by tests only. */
export const statsFixture: StatsResponse = {
  steam: {
    steamId64: '76561198000000001',
    personaName: 'Test teammate',
    avatarUrl: null,
    profileUrl: 'https://steamcommunity.com/profiles/76561198000000001',
    profileVisibility: 3,
    gameDetailsPublic: true,
    timeCreated: null,
    syncedAt: '2026-10-12T12:00:00.000Z',
    bans: { vacBans: 0, gameBans: 0, daysSinceLastBan: 0, communityBanned: false, economyBan: 'none' },
    cs2: { playtimeTotal: 7395, playtime2weeks: 150 },
    games: [{ steamAppId: 730, gameId: null, name: 'Counter-Strike 2', playtimeTotal: 7395, playtime2weeks: 150, syncedAt: '2026-10-12T12:00:00.000Z' }],
  },
  faceit: {
    playerId: 'test-player-id', nickname: 'TestPlayer', profileUrl: null, level: 8, elo: 1800, kd: 1.25, winRate: 54,
    favoriteMaps: ['de_mirage', 'de_ancient'], syncedAt: '2026-10-12T12:00:00.000Z', verified: true,
  },
  availability: { steam: true, faceit: true },
  guidance: [],
  sync: { status: 'IDLE', lastAttemptAt: '2026-10-12T12:00:00.000Z', lastSuccessAt: '2026-10-12T12:00:00.000Z', nextRefreshAt: '2026-10-12T18:00:00.000Z', manualAvailableAt: null, lastErrorCode: null },
};
