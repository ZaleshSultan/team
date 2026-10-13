import { Prisma } from '@prisma/client';
import type { FeedFilters } from '@squad/shared';
import type { GameProvider } from '../games/provider.js';
import type { PublicCardSource } from '../profile/serializer.js';

export const DECLINED_REQUEST_COOLDOWN_DAYS = 14;
export interface FeedPosition { createdAt: Date; id: string }
export interface FeedQueryInput {
  gameId: string; callerId: string; provider: GameProvider; filters: FeedFilters;
  position: FeedPosition | null; limit: number; now: Date;
  minimumAge: number; rulesVersion: string;
}
export interface FeedRow extends FeedPosition {
  nickname: string | null; roles: string[]; lookingFor: string[]; playTimes: string[];
  languages: string[]; region: string; hasMic: boolean; bio: string;
  steamId64: bigint; personaName: string | null; vacBans: number | null;
  gameBans: number | null; communityBanned: boolean | null; economyBan: string | null;
  faceitSteamId64: bigint | null; faceitLevel: number | null; faceitElo: number | null;
  shareSteamActivity: boolean; playtimeTotal: number | null; playtime2weeks: number | null;
}

/** All untrusted values are bound parameters, including arrays and cursor values. */
export function buildFeedQuery(input: FeedQueryInput): Prisma.Sql {
  const { callerId, filters, position } = input;
  const declinedSince = new Date(input.now.getTime() - DECLINED_REQUEST_COOLDOWN_DAYS * 86_400_000);
  const conditions: Prisma.Sql[] = [
    Prisma.sql`p.game_id = ${input.gameId}::uuid`, Prisma.sql`p.is_published = true`,
    Prisma.sql`u.id <> ${callerId}::uuid`, Prisma.sql`u.is_banned = false`,
    Prisma.sql`u.bot_blocked = false`, Prisma.sql`u.username IS NOT NULL AND length(trim(u.username)) > 0`,
    Prisma.sql`u.age_confirmed_at IS NOT NULL AND u.age_minimum_confirmed = ${input.minimumAge}`,
    Prisma.sql`u.rules_accepted_at IS NOT NULL AND u.rules_version = ${input.rulesVersion}`,
    Prisma.sql`NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_user_id = ${callerId}::uuid AND b.blocked_user_id = u.id)`,
    Prisma.sql`NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_user_id = u.id AND b.blocked_user_id = ${callerId}::uuid)`,
    Prisma.sql`NOT EXISTS (SELECT 1 FROM teammate_requests r WHERE r.from_user_id = ${callerId}::uuid AND r.to_user_id = u.id AND r.status IN ('PENDING', 'ACCEPTED'))`,
    Prisma.sql`NOT EXISTS (SELECT 1 FROM teammate_requests r WHERE r.from_user_id = u.id AND r.to_user_id = ${callerId}::uuid AND r.status IN ('PENDING', 'ACCEPTED'))`,
    Prisma.sql`NOT EXISTS (SELECT 1 FROM teammate_requests r WHERE r.from_user_id = ${callerId}::uuid AND r.to_user_id = u.id AND r.status = 'DECLINED' AND r.resolved_at >= ${declinedSince})`,
  ];
  if (position) conditions.push(Prisma.sql`(p.created_at, p.id) < (${position.createdAt}, ${position.id}::uuid)`);
  if (filters.roles.length) conditions.push(Prisma.sql`p.roles && ARRAY[${Prisma.join(filters.roles)}]::text[]`);
  if (filters.languages.length) conditions.push(Prisma.sql`p.languages && ARRAY[${Prisma.join(filters.languages)}]::text[]`);
  if (filters.regions.length) conditions.push(Prisma.sql`p.region IN (${Prisma.join(filters.regions)})`);
  if (filters.lookingFor.length) conditions.push(Prisma.sql`p.looking_for && ARRAY[${Prisma.join(filters.lookingFor)}]::text[]`);
  if (filters.playTimes.length) conditions.push(Prisma.sql`p.play_times && ARRAY[${Prisma.join(filters.playTimes)}]::text[]`);
  if (filters.hasMic !== undefined) conditions.push(Prisma.sql`p.has_mic = ${filters.hasMic}`);
  if (filters.verifiedOnly) conditions.push(Prisma.sql`fa.steam_id64 IS NOT NULL`);
  if (filters.faceitLevelMin !== undefined) conditions.push(Prisma.sql`fa.level >= ${filters.faceitLevelMin}`);
  if (filters.faceitLevelMax !== undefined) conditions.push(Prisma.sql`fa.level <= ${filters.faceitLevelMax}`);
  // Unknown cached ban state is retained. This toggle hides positive VAC/game
  // ban counts; community/economy bans remain visible as card warnings.
  // Keep column predicates visible to PostgreSQL's statistics: COALESCE hides
  // their selectivity and can turn an ordered page into a full-library scan.
  if (filters.noBans) conditions.push(Prisma.sql`(sa.vac_bans IS NULL OR sa.vac_bans <= 0) AND (sa.game_bans IS NULL OR sa.game_bans <= 0)`);
  return Prisma.sql`
    SELECT p.id, p.created_at AS "createdAt", p.nickname, p.roles, p.languages,
      p.region, p.has_mic AS "hasMic", p.play_times AS "playTimes", p.looking_for AS "lookingFor", p.bio,
      sa.steam_id64 AS "steamId64", sa.persona_name AS "personaName", sa.vac_bans AS "vacBans",
      sa.game_bans AS "gameBans", sa.community_banned AS "communityBanned", sa.economy_ban AS "economyBan",
      fa.steam_id64 AS "faceitSteamId64", fa.level AS "faceitLevel", fa.elo AS "faceitElo",
      COALESCE(ps.share_steam_activity, false) AS "shareSteamActivity",
      ug.playtime_total AS "playtimeTotal", ug.playtime_2weeks AS "playtime2weeks"
    FROM player_profiles p
    JOIN users u ON u.id = p.user_id
    JOIN steam_accounts sa ON sa.user_id = u.id
    LEFT JOIN faceit_accounts fa ON fa.user_id = u.id AND fa.steam_id64 = sa.steam_id64
    LEFT JOIN privacy_settings ps ON ps.user_id = u.id
    LEFT JOIN user_games ug ON ug.user_id = u.id AND ug.steam_app_id = ${input.provider.steamAppId}
      AND ps.share_steam_activity = true
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${input.limit}`;
}

export function feedRowSource(row: FeedRow): PublicCardSource {
  return {
    profile: { id: row.id, nickname: row.nickname, roles: row.roles, lookingFor: row.lookingFor,
      playTimes: row.playTimes, languages: row.languages, region: row.region, hasMic: row.hasMic, bio: row.bio },
    steam: { steamId64: row.steamId64, personaName: row.personaName, vacBans: row.vacBans,
      gameBans: row.gameBans, communityBanned: row.communityBanned, economyBan: row.economyBan },
    faceit: row.faceitSteamId64 === null ? null : { steamId64: row.faceitSteamId64, level: row.faceitLevel, elo: row.faceitElo },
    shareSteamActivity: row.shareSteamActivity,
    cs2Game: row.playtimeTotal === null ? null : { playtimeTotal: row.playtimeTotal, playtime2weeks: row.playtime2weeks },
  };
}
