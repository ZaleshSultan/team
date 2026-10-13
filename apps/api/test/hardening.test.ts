import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { requireSession, sessionRateLimitKey } from '../src/auth/session.js';
import { hashSecret } from '../src/auth/secrets.js';
import { loadConfig } from '../src/config.js';

const now = new Date('2026-10-12T12:00:00.000Z');
const token = 'A'.repeat(43);
const secondToken = 'B'.repeat(43);
const userId = randomUUID();
const secondUserId = randomUUID();
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused', REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot', MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' });

function session(id = userId, options: { expired?: boolean; banned?: boolean } = {}) {
  return { userId: id, expiresAt: options.expired ? now : new Date(now.getTime() + 60_000), user: {
    id, telegramId: 12345n, username: 'fixture_user', isBanned: options.banned ?? false,
    language: 'ru', ageConfirmedAt: now, ageMinimumConfirmed: 18, rulesAcceptedAt: now,
    rulesVersion: config.RULES_VERSION, steamAccount: null, privacySettings: { shareSteamActivity: false },
  } };
}
function request(authorization?: string, ip = '203.0.113.20', url = '/api/me') {
  return { headers: { ...(authorization ? { authorization } : {}) }, ip, routeOptions: { url } } as FastifyRequest;
}
function mockPrisma(found: ReturnType<typeof session> | null = session()) {
  const db = { session: { findUnique: vi.fn().mockResolvedValue(found) }, user: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    report: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(), $disconnect: vi.fn() };
  db.$transaction.mockImplementation((callback) => callback(db));
  return db;
}

describe('session-aware rate limit keys', () => {
  it.each(['/api/auth/telegram', '/api/auth/steam/start', '/api/auth/steam/callback'])('keeps public login endpoint %s on IP without a session lookup', async (url) => {
    const db = mockPrisma();
    expect(await sessionRateLimitKey(request(`Bearer ${token}`, '203.0.113.20', url), { prisma: db as unknown as PrismaClient, now: () => now })).toBe('ip:203.0.113.20');
    expect(db.session.findUnique).not.toHaveBeenCalled();
  });

  it('keys authenticated requests by the validated user id, never by token or client-supplied id', async () => {
    const db = mockPrisma();
    const deps = { prisma: db as unknown as PrismaClient, now: () => now };
    const req = request(`Bearer ${token}`);
    req.headers['x-user-id'] = 'spoofed-id';
    const key = await sessionRateLimitKey(req, deps);
    expect(key).toBe(`user:${userId}`);
    expect(key).not.toContain(token);
    expect(db.session.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: hashSecret(token) } }));
    expect((await requireSession(req, deps)).id).toBe(userId);
    expect(db.session.findUnique).toHaveBeenCalledTimes(1);
  });

  it('falls back to IP for anonymous, malformed, unknown and exactly-expired sessions', async () => {
    const db = mockPrisma();
    const deps = { prisma: db as unknown as PrismaClient, now: () => now };
    expect(await sessionRateLimitKey(request(), deps)).toBe('ip:203.0.113.20');
    expect(await sessionRateLimitKey(request('Bearer forged'), deps)).toBe('ip:203.0.113.20');
    expect(db.session.findUnique).not.toHaveBeenCalled();
    db.session.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(session(userId, { expired: true }));
    expect(await sessionRateLimitKey(request(`Bearer ${token}`), deps)).toBe('ip:203.0.113.20');
    expect(await sessionRateLimitKey(request(`Bearer ${token}`), deps)).toBe('ip:203.0.113.20');
  });

  it('preserves banned-user rejection after a cached key lookup', async () => {
    const db = mockPrisma(session(userId, { banned: true }));
    const deps = { prisma: db as unknown as PrismaClient, now: () => now };
    const req = request(`Bearer ${token}`);
    expect(await sessionRateLimitKey(req, deps)).toBe(`user:${userId}`);
    await expect(requireSession(req, deps)).rejects.toMatchObject({ statusCode: 403, code: 'USER_BANNED' });
    expect(db.session.findUnique).toHaveBeenCalledTimes(1);
  });

  it('gives mobile users on the same IP separate buckets and keeps one user in a bucket across IPs', async () => {
    const db = mockPrisma();
    db.session.findUnique.mockImplementation(async (args: { where: { tokenHash: string } }) => args.where.tokenHash === hashSecret(secondToken) ? session(secondUserId) : session());
    const app = await buildApp(config, { prisma: db as unknown as PrismaClient, redis: false, now: () => now });
    app.get('/limiter-fixture', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
    try {
      const first = await app.inject({ url: '/limiter-fixture', remoteAddress: '203.0.113.20', headers: { authorization: `Bearer ${token}` } });
      const second = await app.inject({ url: '/limiter-fixture', remoteAddress: '203.0.113.20', headers: { authorization: `Bearer ${secondToken}` } });
      const sameUser = await app.inject({ url: '/limiter-fixture', remoteAddress: '203.0.113.21', headers: { authorization: `Bearer ${token}` } });
      expect([first.statusCode, second.statusCode, sameUser.statusCode]).toEqual([200, 200, 429]);
      expect(sameUser.json().error.code).toBe('RATE_LIMITED');
    } finally { await app.close(); }
  });
});

describe('account deletion', () => {
  it.each([undefined, {}, { confirmation: true }, { confirmation: 'delete' }, { confirmation: 'DELETE', userId: secondUserId }])('rejects deletion without exact explicit confirmation: %j', async (payload) => {
    const db = mockPrisma();
    const app = await buildApp(config, { prisma: db as unknown as PrismaClient, redis: false, now: () => now });
    try {
      const response = await app.inject({ method: 'DELETE', url: '/api/me', headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode).toBe(400);
      expect(db.user.deleteMany).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('deletes only the session owner after confirmation and immediately rejects all revoked sessions', async () => {
    const db = mockPrisma();
    db.user.deleteMany.mockImplementation(async () => {
      db.session.findUnique.mockResolvedValue(null);
      return { count: 1 };
    });
    const app = await buildApp(config, { prisma: db as unknown as PrismaClient, redis: false, now: () => now });
    try {
      const anonymous = await app.inject({ method: 'DELETE', url: '/api/me', payload: { confirmation: 'DELETE' } });
      expect(anonymous.statusCode).toBe(401);
      const response = await app.inject({ method: 'DELETE', url: '/api/me', headers: { authorization: `Bearer ${token}` }, payload: { confirmation: 'DELETE' } });
      expect(response.statusCode).toBe(204);
      expect(db.user.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { id: userId } });
      expect(db.report.updateMany).toHaveBeenCalledWith({ where: { reportedUserId: userId, reporterUserId: { not: userId } },
        data: { details: null, resolutionNote: 'ACCOUNT_DELETED', status: 'REVIEWED', resolvedAt: now, resolvedBy: null } });
      for (const oldToken of [token, secondToken]) {
        expect((await app.inject({ url: '/api/me', headers: { authorization: `Bearer ${oldToken}` } })).statusCode).toBe(401);
      }
    } finally { await app.close(); }
  });
});
