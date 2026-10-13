import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createSecret, hashSecret } from '../src/auth/secrets.js';
import { profileInput } from '../src/profile/gate.js';
import { profileFixture } from './profile-fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.runIf(Boolean(databaseUrl))('M4 isolated PostgreSQL profile lifecycle', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let gameId: string;
  const ids: string[] = [];
  const now = new Date('2026-10-13T12:00:00Z');
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl ?? 'postgresql://unused@localhost/squad_test',
    REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
    MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' });
  const fetcher = vi.fn().mockRejectedValue(new Error('Profile operations must never fetch upstream'));
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.slice(1).endsWith('_test')) throw new Error('Only a dedicated *_test database is permitted');
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    gameId = (await prisma.game.findUniqueOrThrow({ where: { slug: 'cs2' } })).id;
    app = await buildApp(config, { prisma, redis: false, now: () => now, fetch: fetcher });
  });
  afterAll(async () => {
    if (prisma) await prisma.user.deleteMany({ where: { id: { in: ids } } });
    if (app) await app.close(); else if (prisma) await prisma.$disconnect();
  });
  async function fixture(options: { steam?: boolean; onboarding?: boolean; banned?: boolean } = {}) {
    const token = createSecret();
    const steamId64 = 76561198000000000n + BigInt(Math.floor(Math.random() * 1_000_000_000));
    const user = await prisma.user.create({ data: {
      telegramId: 8_900_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000)), username: 'm4_fixture',
      isBanned: options.banned ?? false,
      ...(options.onboarding === false ? {} : { ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM,
        rulesAcceptedAt: now, rulesVersion: config.RULES_VERSION }),
      ...(options.steam === false ? {} : { steamAccount: { create: { steamId64, personaName: 'Cached Steam Player',
        profileVisibility: 1, gameDetailsPublic: false, vacBans: 0, gameBans: 0, communityBanned: false, economyBan: 'none' } } }),
      privacySettings: { create: {} }, sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(now.getTime() + 3_600_000) } },
    } });
    ids.push(user.id);
    return { user, steamId64, headers: { authorization: `Bearer ${token}` } };
  }
  const input = () => profileInput(profileFixture);

  it('migration adds nullable varchar32 nickname and permits legacy rows without a nickname', async () => {
    const columns = await prisma.$queryRaw<Array<{ is_nullable: string; character_maximum_length: number }>>`
      SELECT is_nullable, character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'player_profiles' AND column_name = 'nickname'`;
    expect(columns).toEqual([{ is_nullable: 'YES', character_maximum_length: 32 }]);
    const h = await fixture();
    const row = await prisma.playerProfile.create({ data: { userId: h.user.id, gameId, region: 'KZ' } });
    expect(row.nickname).toBeNull();
  });
  it('GET returns a draft checklist; PUT upserts one normalized generic game profile', async () => {
    const h = await fixture();
    const empty = await app.inject({ url: '/api/me/profile/cs2', headers: h.headers });
    expect(empty.statusCode).toBe(200); expect(empty.json()).toMatchObject({ profile: null, published: false, requirements: [{ code: 'PROFILE_INCOMPLETE' }] });
    const first = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: h.headers,
      payload: { ...input(), nickname: '  Игрок\u200b  ', roles: ['ENTRY', 'entry'], region: 'kz' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().profile).toMatchObject({ nickname: 'Игрок', roles: ['entry'], region: 'KZ' });
    const second = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: h.headers, payload: { ...input(), nickname: 'New Name' } });
    expect(second.statusCode).toBe(200); expect(second.json().profile.id).toBe(first.json().profile.id);
    expect(await prisma.playerProfile.count({ where: { userId: h.user.id } })).toBe(1);
    expect(await prisma.playerProfile.findUnique({ where: { userId_gameId: { userId: h.user.id, gameId } } })).toMatchObject({ nickname: 'New Name', isPublished: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preview is a direct closed public card and activity privacy changes immediately', async () => {
    const h = await fixture();
    expect((await app.inject({ url: '/api/me/profile/cs2/preview', headers: h.headers })).statusCode).toBe(404);
    await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: h.headers, payload: input() });
    await prisma.faceitAccount.create({ data: { userId: h.user.id, steamId64: h.steamId64, playerId: randomUUID(), nickname: 'private_faceit', level: 8, elo: 1800 } });
    await prisma.userGame.createMany({ data: [730, 570].map((steamAppId) => ({ userId: h.user.id, steamAppId, playtimeTotal: 12345, playtime2weeks: 678, syncedAt: now })) });
    const preview = await app.inject({ url: '/api/me/profile/cs2/preview', headers: h.headers });
    expect(preview.statusCode).toBe(200); expect(preview.json().badges).toEqual({ steamVerified: true, faceitVerified: true });
    expect(preview.json()).not.toHaveProperty('activity'); expect(preview.json()).not.toHaveProperty('profile');
    for (const value of [h.user.id, h.steamId64.toString(), 'telegramId', 'username', 'steamId64', 'userGames', 'private_faceit', 'playtimeTotal']) expect(preview.body).not.toContain(value);
    const privacy = await app.inject({ method: 'PATCH', url: '/api/me/privacy', headers: h.headers, payload: { shareSteamActivity: true } });
    expect(privacy.statusCode).toBe(200); expect(privacy.json().user.privacy.shareSteamActivity).toBe(true);
    expect((await app.inject({ url: '/api/me/profile/cs2/preview', headers: h.headers })).json().activity).toEqual({ cs2Hours: 205.75, cs2Hours2weeks: 11.3 });
    await app.inject({ method: 'PATCH', url: '/api/me/privacy', headers: h.headers, payload: { shareSteamActivity: false } });
    expect((await app.inject({ url: '/api/me/profile/cs2/preview', headers: h.headers })).json()).not.toHaveProperty('activity');
  });
  it('publishes with private Steam, blocks current missing requirements, and always unpublishes for a banned owner', async () => {
    const h = await fixture();
    const noProfile = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: h.headers, payload: { published: true } });
    expect(noProfile.statusCode).toBe(409); expect(noProfile.json().error.requirements).toContainEqual({ code: 'PROFILE_INCOMPLETE' });
    await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: h.headers, payload: input() });
    const published = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: h.headers, payload: { published: true } });
    expect(published.statusCode).toBe(200); expect(published.json()).toEqual({ published: true, requirements: [] });
    await prisma.user.update({ where: { id: h.user.id }, data: { isBanned: true, rulesVersion: 'old' } });
    const banned = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: h.headers, payload: { published: true } });
    expect(banned.statusCode).toBe(403); expect(banned.json().error.requirements).toContainEqual({ code: 'USER_BANNED' });
    const hidden = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: h.headers, payload: { published: false } });
    expect(hidden.statusCode).toBe(200); expect(hidden.json().published).toBe(false);
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { userId_gameId: { userId: h.user.id, gameId } } })).isPublished).toBe(false);
  });
  it.each([{ steam: false }, { onboarding: false }])('blocks publication when a prerequisite is absent: %j', async (options) => {
    const h = await fixture(options);
    await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: h.headers, payload: input() });
    const result = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: h.headers, payload: { published: true } });
    expect(result.statusCode).toBe(409);
    expect(result.json().error.requirements).toContainEqual({ code: options.steam === false ? 'STEAM_REQUIRED' : 'ONBOARDING_INCOMPLETE' });
    expect((await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: h.headers, payload: { published: false } })).statusCode).toBe(200);
  });
  it('keeps two users isolated across read, save, publish, preview and privacy', async () => {
    const a = await fixture(); const b = await fixture();
    const save = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: a.headers, payload: input() });
    expect((await app.inject({ url: '/api/me/profile/cs2', headers: b.headers })).json().profile).toBeNull();
    expect((await app.inject({ url: '/api/me/profile/cs2/preview', headers: b.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: b.headers, payload: { published: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: b.headers, payload: { ...input(), userId: a.user.id } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/me/privacy', headers: b.headers, payload: { shareSteamActivity: true, userId: a.user.id } })).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: b.headers, payload: { ...input(), nickname: 'Other Player' } });
    await app.inject({ method: 'PATCH', url: '/api/me/privacy', headers: b.headers, payload: { shareSteamActivity: true } });
    const own = await app.inject({ url: '/api/me/profile/cs2', headers: a.headers });
    expect(own.json().profile.id).toBe(save.json().profile.id); expect(own.json().profile.nickname).toBe('Игрок');
    expect(own.json().privacy.shareSteamActivity).toBe(false);
  });
  it('deletion cascades a nickname-bearing published profile and revokes preview access', async () => {
    const h = await fixture();
    await app.inject({ method: 'PUT', url: '/api/me/profile/cs2', headers: h.headers, payload: input() });
    await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: h.headers, payload: { published: true } });
    expect((await app.inject({ method: 'DELETE', url: '/api/me', headers: h.headers, payload: { confirmation: 'DELETE' } })).statusCode).toBe(204);
    expect(await prisma.playerProfile.count({ where: { userId: h.user.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: h.user.id } })).toBe(0);
    expect((await app.inject({ url: '/api/me/profile/cs2/preview', headers: h.headers })).statusCode).toBe(401);
  });
});
