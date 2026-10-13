import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { publicPlayerCardSchema } from '@squad/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { cs2GameProvider } from '../src/games/cs2.js';
import { profileInput, publishRequirements } from '../src/profile/gate.js';
import { serializePublicPlayerCard } from '../src/profile/serializer.js';
import { ProfileService } from '../src/profile/service.js';
import { faceitFixture, profileFixture, steamFixture } from './profile-fixtures.js';

const now = profileFixture.createdAt;
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/squad_test',
  REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
  MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' });
const owner = { id: profileFixture.userId, telegramId: 123n, username: 'private_handle', language: 'ru',
  ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM, rulesAcceptedAt: now,
  rulesVersion: config.RULES_VERSION, isBanned: false, steamAccount: steamFixture,
  faceitAccount: faceitFixture, playerProfiles: [profileFixture], userGames: [],
  privacySettings: { shareSteamActivity: false } };

describe('publication requirements', () => {
  it('accepts a valid profile with current consent and Steam, regardless of private game details', () => {
    expect(publishRequirements({ ...owner, steamAccount: { ...steamFixture, gameDetailsPublic: false } }, profileFixture, cs2GameProvider, config)).toEqual([]);
  });
  it.each([
    ['username', null], ['ageConfirmedAt', null], ['ageMinimumConfirmed', 17],
    ['rulesAcceptedAt', null], ['rulesVersion', 'outdated'],
  ])('blocks incomplete/current onboarding: %s', (field, value) => {
    expect(publishRequirements({ ...owner, [field]: value }, profileFixture, cs2GameProvider, config)).toContainEqual({ code: 'ONBOARDING_INCOMPLETE' });
  });
  it('returns every missing requirement rather than just the first', () => {
    expect(publishRequirements({ ...owner, username: null, steamAccount: null, isBanned: true }, null, cs2GameProvider, config).map((item) => item.code))
      .toEqual(['ONBOARDING_INCOMPLETE', 'STEAM_REQUIRED', 'PROFILE_INCOMPLETE', 'USER_BANNED']);
  });
  it('identifies missing fields and invalid legacy values', () => {
    const requirements = publishRequirements(owner, { ...profileFixture, roles: [], languages: [], region: '', bio: '@contact' }, cs2GameProvider, config);
    expect(requirements).toContainEqual({ code: 'PROFILE_INCOMPLETE', fields: ['roles', 'languages', 'region'] });
    expect(requirements).toContainEqual({ code: 'PROFILE_INVALID' });
  });
  it('unpublishes a banned account with outdated consent and no Steam', async () => {
    const db = { user: { findUnique: vi.fn().mockResolvedValue({ ...owner, username: null, steamAccount: null, isBanned: true }) },
      playerProfile: { update: vi.fn() }, $queryRaw: vi.fn(), $transaction: vi.fn() };
    db.$transaction.mockImplementation((callback) => callback(db));
    const result = await new ProfileService(db as unknown as PrismaClient, config).publish(owner.id, false);
    expect(result.published).toBe(false);
    expect(result.requirements.map((item) => item.code)).toContain('USER_BANNED');
    expect(db.playerProfile.update).toHaveBeenCalledWith({ where: { id: profileFixture.id }, data: { isPublished: false } });
  });
  it('unpublishing without a profile is idempotent', async () => {
    const db = { user: { findUnique: vi.fn().mockResolvedValue({ ...owner, playerProfiles: [] }) },
      playerProfile: { update: vi.fn() }, $queryRaw: vi.fn(), $transaction: vi.fn() };
    db.$transaction.mockImplementation((callback) => callback(db));
    expect((await new ProfileService(db as unknown as PrismaClient, config).publish(owner.id, false)).published).toBe(false);
    expect(db.playerProfile.update).not.toHaveBeenCalled();
  });
});

describe('closed public player card', () => {
  const source = { profile: profileFixture, steam: steamFixture, faceit: faceitFixture,
    shareSteamActivity: false, cs2Game: { playtimeTotal: 12345, playtime2weeks: 678 } };
  it('snapshots only allowed fields and rejects extra private properties', () => {
    const card = serializePublicPlayerCard({ ...source, telegramId: 'private', username: 'private_handle', library: ['private'] } as typeof source);
    expect(card).toMatchInlineSnapshot(`
      {
        "badges": {
          "faceitVerified": true,
          "steamVerified": true,
        },
        "bio": "Ищу команду для спокойной игры.",
        "faceit": {
          "elo": 1800,
          "level": 8,
        },
        "hasBans": false,
        "hasMic": true,
        "id": "10000000-0000-4000-8000-000000000001",
        "languages": [
          "ru",
          "kk",
        ],
        "lookingFor": [
          "duo",
        ],
        "nickname": "Игрок",
        "playTimes": [
          "evening",
        ],
        "region": "KZ",
        "roles": [
          "entry",
        ],
      }
    `);
    for (const key of ['telegramId', 'username', 'userId', 'steamId64', 'steamId', 'library', 'userGames', 'playtimeTotal', 'playtime2weeks']) {
      expect(JSON.stringify(card)).not.toContain(key);
      expect(publicPlayerCardSchema.safeParse({ ...card, [key]: 'private' }).success).toBe(false);
    }
    expect(JSON.stringify(card)).not.toContain(steamFixture.steamId64.toString());
  });
  it('includes exact CS2 hours only after activity sharing is enabled, never raw minutes or other games', () => {
    expect(serializePublicPlayerCard({ ...source, shareSteamActivity: true }).activity).toEqual({ cs2Hours: 205.75, cs2Hours2weeks: 11.3 });
    expect(serializePublicPlayerCard(source)).not.toHaveProperty('activity');
    expect(serializePublicPlayerCard({ ...source, cs2Game: null, shareSteamActivity: true }).activity).toEqual({ cs2Hours: null, cs2Hours2weeks: null });
  });
  it('ignores mismatched FACEIT stats and handles unknown bans honestly', () => {
    const card = serializePublicPlayerCard({ ...source, faceit: { ...faceitFixture, steamId64: 76561198000000002n }, steam: { ...steamFixture, vacBans: null } });
    expect(card.badges.faceitVerified).toBe(false); expect(card.faceit).toBeNull(); expect(card.hasBans).toBeNull();
    expect(serializePublicPlayerCard({ ...source, steam: { ...steamFixture, gameBans: 1 } }).hasBans).toBe(true);
  });
  it('uses a safe Steam alias fallback and refuses unsafe legacy profile text', () => {
    expect(serializePublicPlayerCard({ ...source, profile: { ...profileFixture, nickname: null } }).nickname).toBe('Steam Player');
    expect(serializePublicPlayerCard({ ...source, profile: { ...profileFixture, nickname: null }, steam: { ...steamFixture, personaName: '@contact' } }).nickname).toBeNull();
    expect(() => serializePublicPlayerCard({ ...source, profile: { ...profileFixture, bio: 't.me/contact' } })).toThrow('Save a valid profile');
  });
});

describe('profile route authentication and safe errors', () => {
  it.each([
    ['GET', '/api/me/profile/cs2', undefined], ['PUT', '/api/me/profile/cs2', profileInput(profileFixture)],
    ['GET', '/api/me/profile/cs2/preview', undefined], ['PUT', '/api/me/profile/cs2/publish', { published: false }],
    ['PATCH', '/api/me/privacy', { shareSteamActivity: true }],
  ] as const)('requires a session: %s %s', async (method, url, payload) => {
    const db = { $disconnect: vi.fn(), session: { findUnique: vi.fn() } };
    const app = await buildApp(config, { prisma: db as unknown as PrismaClient, redis: false });
    try {
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(response.statusCode).toBe(401); expect(response.json().error.code).toBe('SESSION_INVALID');
      expect(db.session.findUnique).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('returns fixed field errors without echoing contacts, unexpected values or property names', async () => {
    const db = { $disconnect: vi.fn(), session: { findUnique: vi.fn().mockResolvedValue({ userId: owner.id,
      expiresAt: new Date(now.getTime() + 60000), user: owner }) } };
    const app = await buildApp(config, { prisma: db as unknown as PrismaClient, redis: false, now: () => now });
    try {
      const response = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: { authorization: `Bearer ${'A'.repeat(43)}` },
        payload: { ...profileInput(profileFixture), bio: 'https://secret-contact.example' } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code: 'PROFILE_VALIDATION_FAILED', field: 'bio', issues: [{ code: 'CONTACTS_NOT_ALLOWED', field: 'bio' }] });
      expect(response.body).not.toContain('secret-contact');
    } finally { await app.close(); }
  });
});
