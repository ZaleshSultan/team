import { z } from 'zod';

const timestamp = z.string().datetime();
const minutes = z.number().int().nonnegative();
export const statsSyncSchema = z.object({
  status: z.enum(['IDLE', 'QUEUED', 'RUNNING', 'FAILED']),
  lastAttemptAt: timestamp.nullable(),
  lastSuccessAt: timestamp.nullable(),
  nextRefreshAt: timestamp.nullable(),
  manualAvailableAt: timestamp.nullable(),
  lastErrorCode: z.string().nullable(),
});
export const cachedGameSchema = z.object({
  steamAppId: z.number().int().positive(),
  gameId: z.string().uuid().nullable(),
  name: z.string().nullable(),
  playtimeTotal: minutes,
  playtime2weeks: minutes.nullable(),
  syncedAt: timestamp,
});
export const steamStatsSchema = z.object({
  steamId64: z.string().regex(/^\d{17}$/),
  personaName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  profileUrl: z.string().url().nullable(),
  profileVisibility: z.number().int().nullable(),
  gameDetailsPublic: z.boolean().nullable(),
  timeCreated: timestamp.nullable(),
  syncedAt: timestamp.nullable(),
  bans: z.object({
    vacBans: z.number().int().nonnegative().nullable(),
    gameBans: z.number().int().nonnegative().nullable(),
    daysSinceLastBan: z.number().int().nonnegative().nullable(),
    communityBanned: z.boolean().nullable(),
    economyBan: z.string().nullable(),
  }),
  cs2: z.object({ playtimeTotal: minutes, playtime2weeks: minutes.nullable() }).nullable(),
  games: z.array(cachedGameSchema),
});
export const faceitStatsSchema = z.object({
  playerId: z.string(),
  nickname: z.string(),
  profileUrl: z.string().url().nullable(),
  level: z.number().int().min(1).max(10).nullable(),
  elo: z.number().int().nonnegative().nullable(),
  kd: z.number().nonnegative().nullable(),
  winRate: z.number().min(0).max(100).nullable(),
  favoriteMaps: z.array(z.string()),
  syncedAt: timestamp.nullable(),
  verified: z.boolean(),
});
export const statsResponseSchema = z.object({
  steam: steamStatsSchema.nullable(),
  faceit: faceitStatsSchema.nullable(),
  availability: z.object({ steam: z.boolean(), faceit: z.boolean() }),
  guidance: z.array(z.enum(['STEAM_PROFILE_PRIVATE', 'STEAM_GAME_DETAILS_HIDDEN'])),
  sync: statsSyncSchema,
});
export const manualSyncResponseSchema = z.object({ sync: statsSyncSchema });
export const faceitLinkInputSchema = z.object({ nickname: z.string().trim().min(1).max(100) }).strict();
export type StatsSync = z.infer<typeof statsSyncSchema>;
export type CachedGame = z.infer<typeof cachedGameSchema>;
export type SteamStats = z.infer<typeof steamStatsSchema>;
export type FaceitStats = z.infer<typeof faceitStatsSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type FaceitLinkInput = z.infer<typeof faceitLinkInputSchema>;
