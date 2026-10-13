import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedResponseSchema } from '@squad/shared';
import { buildApp } from '../src/app.js';
import { createSecret, hashSecret } from '../src/auth/secrets.js';
import { loadConfig } from '../src/config.js';
import { DECLINED_REQUEST_COOLDOWN_DAYS } from '../src/feed/query.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.runIf(Boolean(databaseUrl))('M5 isolated PostgreSQL feed lifecycle', () => {
  let prisma: PrismaClient; let app: FastifyInstance; let gameId: string;
  let caller: Awaited<ReturnType<typeof fixture>>;
  const ids: string[] = [];
  const now = new Date('2026-10-13T12:00:00.000Z');
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl ?? 'postgresql://unused@localhost/squad_test',
    REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
    MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example', FEED_RATE_LIMIT_PER_MINUTE: '600' });
  const fetcher = vi.fn().mockRejectedValue(new Error('Feed must never fetch upstream'));
  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.slice(1).endsWith('_test')) throw new Error('Only a dedicated *_test database is permitted');
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    gameId = (await prisma.game.findUniqueOrThrow({ where: { slug: 'cs2' } })).id;
    app = await buildApp(config, { prisma, redis: false, now: () => now, fetch: fetcher });
  });
  beforeEach(async () => { await prisma.user.deleteMany({ where: { id: { in: ids } } }); ids.length = 0; caller = await fixture(); });
  afterAll(async () => { if (prisma) await prisma.user.deleteMany({ where: { id: { in: ids } } }); if (app) await app.close(); });
  async function fixture(options: { steam?: boolean; profile?: boolean; published?: boolean; username?: string | null;
    banned?: boolean; botBlocked?: boolean; onboarding?: boolean; createdAt?: Date; profileId?: string; share?: boolean; unsafeBio?: boolean } = {}) {
    const token = createSecret(); const steamId64 = 76561198000000000n + BigInt(Math.floor(Math.random() * 1_000_000_000));
    const user = await prisma.user.create({ data: {
      telegramId: 8_960_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000)),
      username: options.username === undefined ? 'feed_fixture' : options.username,
      isBanned: options.banned ?? false, botBlocked: options.botBlocked ?? false,
      ...(options.onboarding === false ? {} : { ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM, rulesAcceptedAt: now, rulesVersion: config.RULES_VERSION }),
      ...(options.steam === false ? {} : { steamAccount: { create: { steamId64, personaName: 'Private Steam Account',
        profileVisibility: 3, gameDetailsPublic: true, vacBans: 0, gameBans: 0, communityBanned: false, economyBan: 'none' } } }),
      privacySettings: { create: { shareSteamActivity: options.share ?? false } },
      ...(options.profile === false ? {} : { playerProfiles: { create: { gameId, ...(options.profileId ? { id: options.profileId } : {}),
        nickname: 'Fixture Player', roles: ['entry'], lookingFor: ['duo'], playTimes: ['evening'], languages: ['ru'], region: 'KZ', hasMic: true,
        bio: options.unsafeBio ? '@legacy_contact' : 'Играю по вечерам.', isPublished: options.published ?? true, createdAt: options.createdAt ?? now } } }),
      sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(now.getTime() + 3_600_000) } },
    }, include: { playerProfiles: true } });
    ids.push(user.id); return { user, profile: user.playerProfiles[0] ?? null, steamId64, headers: { authorization: `Bearer ${token}` } };
  }
  async function response(query = '', headers = caller.headers) { return app.inject({ url: `/api/feed/cs2${query ? `?${query}` : ''}`, headers }); }
  async function itemIds(query = '') {
    const result = await response(query); expect(result.statusCode).toBe(200);
    return feedResponseSchema.parse(result.json()).items.map((item) => item.id);
  }

  it('requires a session and an eligible caller with a published profile', async () => {
    expect((await app.inject({ url: '/api/feed/cs2' })).statusCode).toBe(401);
    const incomplete = await fixture({ steam: false, profile: false, onboarding: false });
    const denied = await response('', incomplete.headers);
    expect(denied.statusCode).toBe(409); expect(denied.json().error).toMatchObject({ code: 'FEED_REQUIREMENTS_MISSING', requirements: [
      { code: 'ONBOARDING_INCOMPLETE' }, { code: 'STEAM_REQUIRED' }, { code: 'PUBLISHED_PROFILE_REQUIRED' },
    ] });
    const banned = await fixture({ banned: true }); expect((await response('', banned.headers)).statusCode).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { banned: true }, { published: false }, { steam: false }, { username: null }, { username: '   ' },
    { botBlocked: true }, { profile: false }, { onboarding: false }, { unsafeBio: true },
  ])('excludes ineligible candidates: %j', async (options) => {
    const target = await fixture(options); const visible = await fixture(); const result = await itemIds();
    expect(result).toEqual([visible.profile!.id]); expect(result).not.toContain(caller.profile!.id);
    if (target.profile) expect(result).not.toContain(target.profile.id);
  });
  it('rechecks current consent versions for previously published candidates', async () => {
    const target = await fixture(); await prisma.user.update({ where: { id: target.user.id }, data: { rulesVersion: 'outdated', ageMinimumConfirmed: 17 } });
    expect(await itemIds()).toEqual([]);
  });
  it.each(['outgoing', 'incoming'] as const)('honors symmetric %s blocks', async (direction) => {
    const target = await fixture(); const visible = await fixture();
    await prisma.block.create({ data: direction === 'outgoing' ? { blockerUserId: caller.user.id, blockedUserId: target.user.id }
      : { blockerUserId: target.user.id, blockedUserId: caller.user.id } });
    expect(await itemIds()).toEqual([visible.profile!.id]);
  });
  it.each([
    ['PENDING', 'outgoing'], ['PENDING', 'incoming'], ['ACCEPTED', 'outgoing'], ['ACCEPTED', 'incoming'],
  ] as const)('excludes %s requests in %s direction', async (status, direction) => {
    const target = await fixture();
    await prisma.teammateRequest.create({ data: { gameId, status,
      fromUserId: direction === 'outgoing' ? caller.user.id : target.user.id,
      toUserId: direction === 'outgoing' ? target.user.id : caller.user.id } });
    expect(await itemIds()).toEqual([]);
  });
  it('uses an inclusive 14-day declined outgoing window; old, reverse and cancelled requests stay visible', async () => {
    const targets = await Promise.all(Array.from({ length: 5 }, () => fixture()));
    const cutoff = new Date(now.getTime() - DECLINED_REQUEST_COOLDOWN_DAYS * 86_400_000);
    await prisma.teammateRequest.createMany({ data: targets.map((target, index) => ({ gameId,
      fromUserId: index === 3 ? target.user.id : caller.user.id, toUserId: index === 3 ? caller.user.id : target.user.id,
      status: index === 4 ? 'CANCELLED' : 'DECLINED',
      resolvedAt: index === 2 ? new Date(cutoff.getTime() - 1) : index === 1 ? cutoff : now,
    })) });
    expect((await itemIds()).sort()).toEqual(targets.slice(2).map((target) => target.profile!.id).sort());
  });
  it('applies request exclusions globally across other games', async () => {
    const otherGame = await prisma.game.create({ data: { slug: `feed_fixture_${randomUUID()}`, name: 'Fixture game' } });
    try {
      const target = await fixture(); await prisma.teammateRequest.create({ data: { gameId: otherGame.id, fromUserId: target.user.id, toUserId: caller.user.id, status: 'ACCEPTED' } });
      expect(await itemIds()).toEqual([]);
    } finally { await prisma.game.delete({ where: { id: otherGame.id } }); }
  });
  it('keyset pagination remains stable with tied dates and concurrent inserts', async () => {
    const createdAt = new Date('2026-10-12T10:00:00.000Z');
    const targets = [];
    for (let index = 1; index <= 5; index++) targets.push(await fixture({ createdAt, profileId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
    const first = feedResponseSchema.parse((await response('limit=2')).json()); expect(first.items.map((item) => item.id)).toEqual(targets.slice(3).reverse().map((target) => target.profile!.id));
    expect(first.nextCursor).toBeTypeOf('string');
    const inserted = await fixture({ createdAt: new Date('2026-10-13T11:00:00Z') });
    const second = feedResponseSchema.parse((await response(`limit=2&cursor=${first.nextCursor}`)).json());
    const third = feedResponseSchema.parse((await response(`limit=2&cursor=${second.nextCursor}`)).json());
    const all = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(all).toEqual(targets.reverse().map((target) => target.profile!.id)); expect(new Set(all).size).toBe(5);
    expect(all).not.toContain(inserted.profile!.id); expect(third.nextCursor).toBeNull();
    expect((await itemIds('limit=1'))[0]).toBe(inserted.profile!.id);
  });
  it('cursor stays valid when its anchor row is deleted; filters and caller cannot be switched', async () => {
    const targets = []; for (let index = 1; index <= 4; index++) targets.push(await fixture({ createdAt: new Date(now.getTime() - index * 1000) }));
    const first = feedResponseSchema.parse((await response('limit=2')).json());
    await prisma.user.delete({ where: { id: targets[1]!.user.id } });
    const next = feedResponseSchema.parse((await response(`limit=2&cursor=${first.nextCursor}`)).json());
    expect(next.items.map((item) => item.id)).toEqual(targets.slice(2).map((target) => target.profile!.id));
    expect((await response(`limit=2&noBans=false&cursor=${first.nextCursor}`)).statusCode).toBe(400);
    expect((await response(`limit=2&cursor=${first.nextCursor}`, targets[0]!.headers)).statusCode).toBe(400);
    const raw = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()); raw.id = randomUUID();
    const tampered = await response(`cursor=${Buffer.from(JSON.stringify(raw)).toString('base64url')}`);
    expect(tampered.statusCode).toBe(400); expect(tampered.json().error.code).toBe('INVALID_CURSOR');
  });
  it('skips unsafe legacy rows between valid rows without duplicates or gaps', async () => {
    const first = await fixture({ createdAt: new Date(now.getTime() - 1000) });
    await fixture({ unsafeBio: true, createdAt: new Date(now.getTime() - 2000) });
    const second = await fixture({ createdAt: new Date(now.getTime() - 3000) });
    const page = feedResponseSchema.parse((await response('limit=1')).json());
    const next = feedResponseSchema.parse((await response(`limit=1&cursor=${page.nextCursor}`)).json());
    expect(page.items.map((item) => item.id)).toEqual([first.profile!.id]); expect(next.items.map((item) => item.id)).toEqual([second.profile!.id]);
    expect(next.nextCursor).toBeNull();
  });
  it('returns only the closed public snapshot; never includes private fields or internal identities', async () => {
    const target = await fixture();
    await prisma.faceitAccount.create({ data: { userId: target.user.id, steamId64: target.steamId64, playerId: randomUUID(), nickname: 'private_faceit_name', level: 8, elo: 1800 } });
    await prisma.userGame.createMany({ data: [730, 570].map((steamAppId) => ({ userId: target.user.id, steamAppId, playtimeTotal: 12345, playtime2weeks: 678, syncedAt: now })) });
    const result = await response(); const page = feedResponseSchema.parse(result.json());
    expect({ ...page, items: page.items.map((item) => ({ ...item, id: '<opaque-profile-id>' })) }).toMatchInlineSnapshot(`
      {
        "items": [
          {
            "badges": {
              "faceitVerified": true,
              "steamVerified": true,
            },
            "bio": "Играю по вечерам.",
            "faceit": {
              "elo": 1800,
              "level": 8,
            },
            "hasBans": false,
            "hasMic": true,
            "id": "<opaque-profile-id>",
            "languages": [
              "ru",
            ],
            "lookingFor": [
              "duo",
            ],
            "nickname": "Fixture Player",
            "playTimes": [
              "evening",
            ],
            "region": "KZ",
            "roles": [
              "entry",
            ],
          },
        ],
        "nextCursor": null,
      }
    `);
    for (const value of ['telegramId', 'username', 'userId', 'steamId64', 'library', 'playtimeTotal', 'playtime2weeks',
      target.user.id, target.steamId64.toString(), target.user.telegramId.toString(), 'private_faceit_name']) expect(result.body).not.toContain(value);
    expect(page.items[0]).not.toHaveProperty('activity');
    await prisma.privacySettings.update({ where: { userId: target.user.id }, data: { shareSteamActivity: true } });
    expect(feedResponseSchema.parse((await response()).json()).items[0]?.activity).toEqual({ cs2Hours: 205.75, cs2Hours2weeks: 11.3 });
    await prisma.privacySettings.update({ where: { userId: target.user.id }, data: { shareSteamActivity: false } });
    expect(feedResponseSchema.parse((await response()).json()).items[0]).not.toHaveProperty('activity');
  });
  it('bans, unpublishing, new blocks and deletion affect the next request without a cached feed', async () => {
    const target = await fixture(); expect(await itemIds()).toEqual([target.profile!.id]);
    await prisma.user.update({ where: { id: target.user.id }, data: { isBanned: true } }); expect(await itemIds()).toEqual([]);
    await prisma.user.update({ where: { id: target.user.id }, data: { isBanned: false } });
    await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: target.headers, payload: { published: false } }); expect(await itemIds()).toEqual([]);
    await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: target.headers, payload: { published: true } }); expect(await itemIds()).toEqual([target.profile!.id]);
    const block = await prisma.block.create({ data: { blockerUserId: target.user.id, blockedUserId: caller.user.id } }); expect(await itemIds()).toEqual([]);
    await prisma.block.delete({ where: { id: block.id } });
    expect((await app.inject({ method: 'DELETE', url: '/api/me', headers: target.headers, payload: { confirmation: 'DELETE' } })).statusCode).toBe(204);
    expect(await itemIds()).toEqual([]); expect(await prisma.playerProfile.count({ where: { userId: target.user.id } })).toBe(0);
    expect((await response('', target.headers)).statusCode).toBe(401);
  });
});
