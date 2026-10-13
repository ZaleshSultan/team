import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { CS2_PROFILE_OPTIONS } from '../games/cs2.js';
import { syntheticTelegramId, SYNTHETIC_TELEGRAM_MAX } from './synthetic-guard.js';

/** Stable IDs also act as an ownership marker checked before cleanup. */
export function syntheticId(kind: string, index: number): string {
  syntheticTelegramId(index);
  const hex = createHash('sha256').update(`squad-m5-synthetic-v1:${kind}:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function ownsSyntheticUser(user: { id: string; telegramId: bigint }): boolean {
  const index = Number(SYNTHETIC_TELEGRAM_MAX - user.telegramId);
  try { return user.id === syntheticId('user', index); } catch { return false; }
}

export interface SyntheticBatch {
  users: Prisma.UserCreateManyInput[];
  steam: Prisma.SteamAccountCreateManyInput[];
  faceit: Prisma.FaceitAccountCreateManyInput[];
  profiles: Prisma.PlayerProfileCreateManyInput[];
  privacy: Prisma.PrivacySettingsCreateManyInput[];
  games: Prisma.UserGameCreateManyInput[];
}

/** Deterministic and varied: arrays, privacy, bans, level, visibility, and eligibility. */
export function syntheticBatch(start: number, count: number, gameId: string, consent = { ageMinimum: 18, rulesVersion: '2026-10-07' }): SyntheticBatch {
  const batch: SyntheticBatch = { users: [], steam: [], faceit: [], profiles: [], privacy: [], games: [] };
  const options = CS2_PROFILE_OPTIONS;
  for (let index = start; index < start + count; index++) {
    const userId = syntheticId('user', index);
    const steamId64 = 76_561_201_000_000_000n + BigInt(index);
    const number = String(index + 1).padStart(5, '0');
    // Groups of three share timestamps, exercising the UUID cursor tiebreaker.
    const createdAt = new Date(Date.UTC(2026, 0, 1) + Math.floor(index / 3) * 60_000);
    const hasSteam = index % 53 !== 0;
    batch.users.push({ id: userId, telegramId: syntheticTelegramId(index), username: index % 47 === 0 ? null : `synthetic_${number}`,
      language: index % 2 ? 'en' : 'ru', ageConfirmedAt: createdAt, ageMinimumConfirmed: consent.ageMinimum,
      rulesAcceptedAt: createdAt, rulesVersion: consent.rulesVersion, isBanned: index % 61 === 0,
      botBlocked: index % 59 === 0, createdAt, updatedAt: createdAt });
    batch.profiles.push({ id: syntheticId('profile', index), userId, gameId, nickname: `Игрок ${number}`,
      roles: index % 3 === 0 ? [options.roles[index % options.roles.length]!, options.roles[(index + 2) % options.roles.length]!] : [options.roles[index % options.roles.length]!],
      languages: index % 4 === 0 ? ['ru', 'kk'] : index % 4 === 1 ? ['en'] : index % 4 === 2 ? ['ru', 'en'] : ['kk', 'en'],
      hasMic: index % 4 !== 0, region: options.regions[Math.floor(index / 7) % options.regions.length]!,
      playTimes: index % 5 === 0 ? ['evening', 'night'] : [options.playTimes[Math.floor(index / 11) % options.playTimes.length]!],
      lookingFor: index % 6 === 0 ? ['duo', 'team'] : [options.lookingFor[Math.floor(index / 13) % options.lookingFor.length]!],
      bio: index % 2 ? 'Looking for friendly teammates and consistent practice.' : 'Ищу спокойных тиммейтов для совместной игры.',
      isPublished: index % 43 !== 0, createdAt, updatedAt: createdAt });
    batch.privacy.push({ userId, shareSteamActivity: index % 3 === 0, updatedAt: createdAt });
    if (!hasSteam) continue;
    batch.steam.push({ id: syntheticId('steam', index), userId, steamId64, personaName: `Synthetic ${number}`,
      profileVisibility: index % 17 === 0 ? 1 : 3, gameDetailsPublic: index % 17 !== 0,
      vacBans: index % 37 === 0 ? 1 : 0, gameBans: index % 41 === 0 ? 1 : 0,
      daysSinceLastBan: 0, communityBanned: false, economyBan: 'none', linkedAt: createdAt, syncedAt: createdAt });
    if (index % 17 !== 0) batch.games.push({ id: syntheticId('user-game', index), userId, gameId, steamAppId: 730,
      name: 'Counter-Strike 2', playtimeTotal: 60 * (100 + index % 2_000), playtime2weeks: 30 * (index % 100), syncedAt: createdAt });
    if (index % 4 !== 0) batch.faceit.push({ id: syntheticId('faceit', index), userId, steamId64,
      playerId: `squad-synthetic-${number}`, nickname: `Synthetic${number}`, level: Math.floor(index / 9) % 10 + 1,
      elo: 300 + Math.floor(index / 9) % 10 * 250, kd: 0.7 + index % 10 / 10, winRate: 35 + index % 30,
      favoriteMaps: ['de_mirage', 'de_ancient'], linkedAt: createdAt, syncedAt: createdAt });
  }
  return batch;
}
