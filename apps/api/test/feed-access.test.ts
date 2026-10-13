import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { feedResponseSchema } from '@squad/shared';
import { buildApp } from '../src/app.js';
import { hashSecret } from '../src/auth/secrets.js';
import { loadConfig } from '../src/config.js';
import { FeedService } from '../src/feed/service.js';
import { feedRequirements } from '../src/feed/access.js';
import { steamFixture, profileFixture } from './profile-fixtures.js';

const now = new Date('2026-10-13T12:00:00.000Z');
const configInput = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/squad_test',
  REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
  MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' };
const config = loadConfig(configInput);
const owner = { id: profileFixture.userId, telegramId: 123n, username: 'private_handle', language: 'ru',
  ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM, rulesAcceptedAt: now,
  rulesVersion: config.RULES_VERSION, isBanned: false, steamAccount: steamFixture,
  privacySettings: { shareSteamActivity: false } };
const ownerType = owner as unknown as Parameters<typeof feedRequirements>[0];
const token = 'A'.repeat(43);
function db() {
  return { $disconnect: vi.fn(), session: { findUnique: vi.fn().mockResolvedValue({ userId: owner.id,
    expiresAt: new Date(now.getTime() + 60000), user: owner }) },
    playerProfile: { findFirst: vi.fn().mockResolvedValue({ id: profileFixture.id }) } };
}

describe('feed access configuration and requirements', () => {
  it('defaults to a published own profile and 60 feed requests per minute', () => {
    expect(config.FEED_REQUIRES_PUBLISHED_PROFILE).toBe(true); expect(config.FEED_RATE_LIMIT_PER_MINUTE).toBe(60);
    expect(loadConfig({ ...configInput, FEED_REQUIRES_PUBLISHED_PROFILE: 'false', FEED_RATE_LIMIT_PER_MINUTE: '42' }))
      .toMatchObject({ FEED_REQUIRES_PUBLISHED_PROFILE: false, FEED_RATE_LIMIT_PER_MINUTE: 42 });
  });
  it.each([{ FEED_REQUIRES_PUBLISHED_PROFILE: '0' }, { FEED_REQUIRES_PUBLISHED_PROFILE: 'TRUE' },
    { FEED_RATE_LIMIT_PER_MINUTE: '0' }, { FEED_RATE_LIMIT_PER_MINUTE: '601' }, { FEED_RATE_LIMIT_PER_MINUTE: '1.5' }])('rejects invalid settings: %j', (values) => {
    expect(() => loadConfig({ ...configInput, ...values })).toThrow('Invalid environment');
  });
  it('returns the full structured missing-requirements list', () => {
    expect(feedRequirements({ ...ownerType, username: null, steamAccount: null }, false, config)).toEqual([
      { code: 'ONBOARDING_INCOMPLETE' }, { code: 'STEAM_REQUIRED' }, { code: 'PUBLISHED_PROFILE_REQUIRED' },
    ]);
    expect(feedRequirements(ownerType, true, config)).toEqual([]);
    expect(feedRequirements(ownerType, false, { ...config, FEED_REQUIRES_PUBLISHED_PROFILE: false })).toEqual([]);
  });
});

describe('feed route authentication, gates and rate limit', () => {
  it('requires a valid session before querying profiles', async () => {
    const mock = db();
    const app = await buildApp(config, { prisma: mock as unknown as PrismaClient, redis: false, now: () => now });
    try {
      const response = await app.inject({ url: '/api/feed/cs2' });
      expect(response.statusCode).toBe(401); expect(mock.playerProfile.findFirst).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('returns a structured gate error without private input or identities', async () => {
    const mock = db(); mock.playerProfile.findFirst.mockResolvedValue(null);
    mock.session.findUnique.mockResolvedValue({ userId: owner.id, expiresAt: new Date(now.getTime() + 60000), user: { ...owner, username: null, steamAccount: null } });
    const app = await buildApp(config, { prisma: mock as unknown as PrismaClient, redis: false, now: () => now });
    try {
      const response = await app.inject({ url: '/api/feed/cs2', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(409); expect(response.json().error).toMatchObject({ code: 'FEED_REQUIREMENTS_MISSING', requirements: [
        { code: 'ONBOARDING_INCOMPLETE' }, { code: 'STEAM_REQUIRED' }, { code: 'PUBLISHED_PROFILE_REQUIRED' },
      ] });
      expect(response.body).not.toContain(owner.id); expect(response.body).not.toContain(token);
    } finally { await app.close(); }
  });
  it('uses validated user identity for the feed quota across shared or changed IPs', async () => {
    const mock = db(); const otherToken = 'B'.repeat(43); const otherId = '20000000-0000-4000-8000-000000000002';
    mock.session.findUnique.mockImplementation(async ({ where }: { where: { tokenHash: string } }) => {
      const id = where.tokenHash === hashSecret(otherToken) ? otherId : owner.id;
      return { userId: id, expiresAt: new Date(now.getTime() + 60000), user: { ...owner, id } };
    });
    const list = vi.spyOn(FeedService.prototype, 'listPage').mockResolvedValue({ items: [], hasMore: false, position: null });
    const app = await buildApp({ ...config, FEED_RATE_LIMIT_PER_MINUTE: 1, FEED_REQUIRES_PUBLISHED_PROFILE: false },
      { prisma: mock as unknown as PrismaClient, redis: false, now: () => now });
    try {
      const first = await app.inject({ url: '/api/feed/cs2', remoteAddress: '203.0.113.1', headers: { authorization: `Bearer ${token}` } });
      const second = await app.inject({ url: '/api/feed/cs2', remoteAddress: '203.0.113.1', headers: { authorization: `Bearer ${otherToken}` } });
      const repeated = await app.inject({ url: '/api/feed/cs2', remoteAddress: '203.0.113.2', headers: { authorization: `Bearer ${token}` } });
      expect([first.statusCode, second.statusCode, repeated.statusCode]).toEqual([200, 200, 429]);
      expect(repeated.json().error.code).toBe('RATE_LIMITED');
      expect(feedResponseSchema.parse(first.json())).toEqual({ items: [], nextCursor: null });
      expect(list).toHaveBeenCalledTimes(2); expect(mock.playerProfile.findFirst).not.toHaveBeenCalled();
    } finally { await app.close(); list.mockRestore(); }
  });
  it.each(['roles=secret-invalid-value', 'hasMic=yes', 'unknown=private-value', 'limit=51', 'faceitLevelMin=9&faceitLevelMax=3', 'cursor=invalid'])
  ('rejects malformed filters/cursors cleanly: %s', async (query) => {
    const mock = db();
    const app = await buildApp(config, { prisma: mock as unknown as PrismaClient, redis: false, now: () => now });
    try {
      const response = await app.inject({ url: `/api/feed/cs2?${query}`, headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(400); expect(['INVALID_INPUT', 'INVALID_CURSOR']).toContain(response.json().error.code);
      expect(response.body).not.toContain('secret-invalid-value'); expect(response.body).not.toContain('private-value');
    } finally { await app.close(); }
  });
});
