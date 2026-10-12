import { z } from 'zod';

// Upstream payload schemas strip unknown keys; raw payloads never reach logs/API clients.
const steamId = z.string().regex(/^\d{17}$/);
const count = z.number().int().min(0).max(2_147_483_647);
export const steamOwnedGamesResponseSchema = z.object({
  response: z.object({
    game_count: count.optional(),
    games: z.array(z.object({
      appid: count.refine((value) => value > 0),
      name: z.string().max(1_000).optional(),
      playtime_forever: count,
      playtime_2weeks: count.optional(),
    })).max(30_000).optional(),
  }),
});
export const steamSummariesResponseSchema = z.object({
  response: z.object({ players: z.array(z.object({
    steamid: steamId,
    personaname: z.string().max(1_000),
    avatarfull: z.string().max(2_048),
    profileurl: z.string().max(2_048),
    communityvisibilitystate: z.number().int().min(1).max(3),
    timecreated: count.optional(),
  })).max(100) }),
});
export const steamBansResponseSchema = z.object({
  players: z.array(z.object({
    SteamId: steamId,
    CommunityBanned: z.boolean(),
    VACBanned: z.boolean(),
    NumberOfVACBans: count,
    DaysSinceLastBan: count,
    NumberOfGameBans: count,
    EconomyBan: z.string().max(50),
  })).max(100),
});
export const faceitPlayerResponseSchema = z.object({
  player_id: z.string().min(1).max(100),
  nickname: z.string().min(1).max(100),
  faceit_url: z.string().max(2_048).optional(),
  games: z.record(z.object({
    game_player_id: z.string().max(100),
    skill_level: z.number().int().min(0).max(10).optional(),
    faceit_elo: count.optional(),
  })),
});
export const faceitStatsResponseSchema = z.object({
  player_id: z.string().min(1).max(100),
  game_id: z.string().max(100),
  // FACEIT documents these as dynamic objects, without a game-specific schema.
  lifetime: z.record(z.unknown()).optional(),
  segments: z.array(z.record(z.unknown())).max(10_000).optional(),
});
