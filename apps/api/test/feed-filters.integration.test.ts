import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedResponseSchema } from '@squad/shared';
import { buildApp } from '../src/app.js';
import { createSecret, hashSecret } from '../src/auth/secrets.js';
import { loadConfig } from '../src/config.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.runIf(Boolean(databaseUrl))('M5 isolated PostgreSQL feed filter semantics', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let gameId: string;
  let headers: { authorization: string };
  const ids: string[] = [];
  const now = new Date('2026-10-13T12:00:00.000Z');
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl ?? 'postgresql://unused@localhost/squad_test',
    REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
    MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example',
    FEED_REQUIRES_PUBLISHED_PROFILE: 'false' });
  const fetcher = vi.fn().mockRejectedValue(new Error('Feed reads must never fetch upstream'));
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.slice(1).endsWith('_test')) throw new Error('Only a dedicated *_test database is permitted');
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    gameId = (await prisma.game.findUniqueOrThrow({ where: { slug: 'cs2' } })).id;
    app = await buildApp(config, { prisma, redis: false, now: () => now, fetch: fetcher });
  });
  beforeEach(async () => {
    if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids.splice(0) } } });
    const token = createSecret();
    const caller = await createUser();
    await prisma.session.create({ data: { userId: caller.id, tokenHash: hashSecret(token), expiresAt: new Date(now.getTime() + 3_600_000) } });
    headers = { authorization: `Bearer ${token}` };
  });
  afterAll(async () => {
    if (prisma && ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
    if (app) await app.close(); else if (prisma) await prisma.$disconnect();
  });
  async function createUser() {
    const user = await prisma.user.create({ data: { telegramId: 8_700_000_000_000n + BigInt(randomInt(1_000_000_000)),
      username: 'feed_filter_fixture', ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM,
      rulesAcceptedAt: now, rulesVersion: config.RULES_VERSION,
      steamAccount: { create: { steamId64: 76561198000000000n + BigInt(randomInt(1_000_000_000)),
        personaName: 'Cached Player', vacBans: 0, gameBans: 0, communityBanned: false, economyBan: 'none' } },
      privacySettings: { create: { shareSteamActivity: false } },
    }, include: { steamAccount: true } });
    ids.push(user.id);
    return user;
  }
  interface CandidateOptions {
    roles?: string[]; languages?: string[]; region?: string; lookingFor?: string[]; playTimes?: string[];
    hasMic?: boolean; level?: number | null; vacBans?: number | null; gameBans?: number | null;
    communityBanned?: boolean | null; economyBan?: string | null;
  }
  async function candidate(options: CandidateOptions = {}) {
    const user = await createUser();
    const profile = await prisma.playerProfile.create({ data: { userId: user.id, gameId, nickname: 'Filter Player',
      roles: options.roles ?? ['entry'], languages: options.languages ?? ['ru'], region: options.region ?? 'KZ',
      lookingFor: options.lookingFor ?? ['duo'], playTimes: options.playTimes ?? ['evening'],
      hasMic: options.hasMic ?? true, bio: 'Спокойная игра.', isPublished: true, createdAt: now } });
    const banFields = Object.fromEntries((['vacBans', 'gameBans', 'communityBanned', 'economyBan'] as const)
      .filter((field) => field in options).map((field) => [field, options[field]]));
    if (Object.keys(banFields).length) await prisma.steamAccount.update({ where: { userId: user.id }, data: banFields });
    if (options.level !== undefined) await prisma.faceitAccount.create({ data: { userId: user.id,
      steamId64: user.steamAccount!.steamId64, playerId: randomUUID(), nickname: 'Cached Faceit',
      level: options.level, elo: options.level === null ? null : 1500 + options.level * 100 } });
    return { id: profile.id, userId: user.id };
  }
  async function feed(query = '') {
    const response = await app.inject({ url: `/api/feed/cs2?limit=50${query ? `&${query}` : ''}`, headers });
    expect(response.statusCode).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    return feedResponseSchema.parse(response.json()).items;
  }
  async function expectProfiles(query: string, expected: Array<{ id: string }>) {
    expect((await feed(query)).map((item) => item.id).sort()).toEqual(expected.map((item) => item.id).sort());
  }

  it.each([
    ['roles', { roles: ['entry'] }, { roles: ['awp', 'support'] }, { roles: ['igl'] }, 'entry,awp'],
    ['languages', { languages: ['ru'] }, { languages: ['en', 'kk'] }, { languages: ['de'] }, 'ru,en'],
    ['regions', { region: 'KZ' }, { region: 'EU' }, { region: 'OTHER' }, 'kz,eu'],
    ['lookingFor', { lookingFor: ['duo'] }, { lookingFor: ['team'] }, { lookingFor: ['five_stack'] }, 'duo,team'],
    ['playTimes', { playTimes: ['morning'] }, { playTimes: ['night', 'day'] }, { playTimes: ['evening'] }, 'morning,night'],
  ] as const)('%s matches any selected value using both comma-separated and repeated parameters', async (field, first, second, other, selected) => {
    const a = await candidate(first); const b = await candidate(second); await candidate(other);
    await expectProfiles(`${field}=${selected}`, [a, b]);
    const [one, two] = selected.split(',');
    await expectProfiles(`${field}=${one}&${field}=${two}&${field}=${one}`, [a, b]);
  });
  it('ANDs fields while preserving OR membership within each field', async () => {
    const a = await candidate({ roles: ['entry'], languages: ['ru'], region: 'KZ', lookingFor: ['duo'], playTimes: ['night'], hasMic: true });
    const b = await candidate({ roles: ['awp'], languages: ['en'], region: 'EU', lookingFor: ['team'], playTimes: ['morning'], hasMic: true });
    await candidate({ roles: ['igl'], languages: ['ru'], region: 'KZ', playTimes: ['night'] });
    await candidate({ roles: ['entry'], languages: ['de'], region: 'KZ', playTimes: ['night'] });
    await candidate({ roles: ['entry'], languages: ['ru'], region: 'OTHER', playTimes: ['night'] });
    await candidate({ roles: ['entry'], languages: ['ru'], region: 'KZ', lookingFor: ['five_stack'], playTimes: ['night'] });
    await candidate({ roles: ['entry'], languages: ['ru'], region: 'KZ', playTimes: ['day'] });
    await candidate({ roles: ['entry'], languages: ['ru'], region: 'KZ', playTimes: ['night'], hasMic: false });
    await expectProfiles('roles=entry,awp&languages=ru,en&regions=KZ,EU&lookingFor=duo,team&playTimes=night,morning&hasMic=true', [a, b]);
  });
  it('matches inclusive FACEIT level boundaries, open ranges and verified accounts', async () => {
    const one = await candidate({ level: 1 }); const four = await candidate({ level: 4 }); const ten = await candidate({ level: 10 });
    const unknownLevel = await candidate({ level: null }); const noFaceit = await candidate();
    await expectProfiles('faceitLevelMin=1&faceitLevelMax=10', [one, four, ten]);
    await expectProfiles('faceitLevelMin=4&faceitLevelMax=4', [four]);
    await expectProfiles('faceitLevelMin=4', [four, ten]);
    await expectProfiles('faceitLevelMax=4', [one, four]);
    await expectProfiles('verifiedOnly=true', [one, four, ten, unknownLevel]);
    await expectProfiles('verifiedOnly=false', [one, four, ten, unknownLevel, noFaceit]);
    const cards = await feed('verifiedOnly=true&faceitLevelMin=4');
    expect(cards.every((card) => card.badges.faceitVerified)).toBe(true);
    expect(cards.map((card) => card.faceit!.level).sort()).toEqual([4, 10].sort());
  });
  it('filters hasMic=false explicitly while the absent filter includes both values', async () => {
    const mic = await candidate({ hasMic: true }); const noMic = await candidate({ hasMic: false });
    await expectProfiles('hasMic=true', [mic]); await expectProfiles('hasMic=false', [noMic]);
    await expectProfiles('', [mic, noMic]);
  });
  it('defaults noBans=true, excludes VAC/game bans and preserves unknown/community/economy states', async () => {
    const clean = await candidate(); const vac = await candidate({ vacBans: 1 }); const game = await candidate({ gameBans: 2 });
    const unknown = await candidate({ vacBans: null, gameBans: null, communityBanned: null, economyBan: null });
    const community = await candidate({ communityBanned: true }); const economy = await candidate({ economyBan: 'banned' });
    await expectProfiles('', [clean, unknown, community, economy]);
    await expectProfiles('noBans=true', [clean, unknown, community, economy]);
    await expectProfiles('noBans=false', [clean, vac, game, unknown, community, economy]);
    const cards = await feed();
    expect(cards.find((card) => card.id === unknown.id)!.hasBans).toBeNull();
    expect(cards.find((card) => card.id === community.id)!.hasBans).toBe(true);
    expect(cards.find((card) => card.id === economy.id)!.hasBans).toBe(true);
  });
  it('combines levels, verification, array filters, mic and ban filtering', async () => {
    const match = await candidate({ roles: ['awp'], languages: ['en'], region: 'EU', lookingFor: ['team'], playTimes: ['night'], hasMic: false, level: 8 });
    await candidate({ roles: ['awp'], languages: ['en'], region: 'EU', lookingFor: ['team'], playTimes: ['night'], hasMic: false, level: 7 });
    const banned = await candidate({ roles: ['awp'], languages: ['en'], region: 'EU', lookingFor: ['team'], playTimes: ['night'], hasMic: false, level: 8, gameBans: 1 });
    await candidate({ roles: ['awp'], languages: ['en'], region: 'EU', lookingFor: ['team'], playTimes: ['night'], hasMic: false });
    const query = 'roles=awp&languages=en&regions=EU&lookingFor=team&playTimes=night&hasMic=false&verifiedOnly=true&faceitLevelMin=8&faceitLevelMax=10';
    await expectProfiles(query, [match]); await expectProfiles(`${query}&noBans=false`, [match, banned]);
  });
  it.each([
    'unknown=do-not-echo', 'roles=invalid', 'languages=invalid', 'regions=invalid', 'lookingFor=invalid', 'playTimes=invalid',
    'roles=', 'roles=entry,', 'hasMic=1', 'verifiedOnly=TRUE', 'noBans=0', 'hasMic=true&hasMic=false',
    'faceitLevelMin=0', 'faceitLevelMax=11', 'faceitLevelMin=9&faceitLevelMax=2', 'faceitLevelMin=3.5',
    'limit=0', 'limit=51', 'limit=-1',
  ])('returns a clean 400 for invalid query %s', async (query) => {
    const response = await app.inject({ url: `/api/feed/cs2?${query}`, headers });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('INVALID_INPUT');
    expect(response.body).not.toContain('do-not-echo');
  });
});
