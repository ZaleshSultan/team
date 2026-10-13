import type { FaceitAccount, PlayerProfile, SteamAccount } from '@prisma/client';

export const profileFixture: PlayerProfile = {
  id: '10000000-0000-4000-8000-000000000001', userId: '20000000-0000-4000-8000-000000000001',
  gameId: '30000000-0000-4000-8000-000000000001', nickname: 'Игрок', roles: ['entry'],
  lookingFor: ['duo'], playTimes: ['evening'], languages: ['ru', 'kk'], region: 'KZ',
  hasMic: true, bio: 'Ищу команду для спокойной игры.', isPublished: false,
  createdAt: new Date('2026-10-13T10:00:00Z'), updatedAt: new Date('2026-10-13T10:00:00Z'),
};
export const steamFixture: SteamAccount = {
  id: '40000000-0000-4000-8000-000000000001', userId: profileFixture.userId, steamId64: 76561198000000001n,
  personaName: 'Steam Player', profileUrl: 'https://steamcommunity.com/profiles/76561198000000001', avatarUrl: null,
  profileVisibility: 3, gameDetailsPublic: true, timeCreated: null, vacBans: 0, gameBans: 0,
  daysSinceLastBan: 0, communityBanned: false, economyBan: 'none',
  linkedAt: profileFixture.createdAt, syncedAt: profileFixture.updatedAt,
};
export const faceitFixture: FaceitAccount = {
  id: '50000000-0000-4000-8000-000000000001', userId: profileFixture.userId, playerId: 'external-player',
  steamId64: steamFixture.steamId64, nickname: 'FACEIT Player', profileUrl: null, level: 8, elo: 1800,
  kd: 1.2, winRate: 55, favoriteMaps: ['de_mirage'], linkedAt: profileFixture.createdAt, syncedAt: profileFixture.updatedAt,
};
