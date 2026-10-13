import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DailyRequestLimitError } from '../src/requests/errors.js';
import type { RequestService } from '../src/requests/service.js';
import { hashSecret } from '../src/auth/secrets.js';
import { profileTextError, sendRequestInputSchema } from '@squad/shared';

const now = new Date('2026-10-13T12:00:00.000Z');
const configInput = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/squad_test', REDIS_URL: 'redis://localhost:6379',
  BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot', MINIAPP_URL: 'https://app.example',
  PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' };
const config = loadConfig(configInput);
const token = 'A'.repeat(43); const otherToken = 'B'.repeat(43);
const id = '20000000-0000-4000-8000-000000000001'; const otherId = '20000000-0000-4000-8000-000000000002';
const actor = { id, telegramId: 12345n, username: 'fixture_user', isBanned: false, language: 'ru',
  ageConfirmedAt: now, ageMinimumConfirmed: 18, rulesAcceptedAt: now, rulesVersion: config.RULES_VERSION,
  steamAccount: null, privacySettings: { shareSteamActivity: false } };
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

async function fixture(options: { onboarded?: boolean; max?: number } = {}) {
  const service = { summary: vi.fn().mockResolvedValue({ pendingIncoming: 0 }), send: vi.fn() };
  const prisma = { $disconnect: vi.fn(), session: { findUnique: vi.fn().mockImplementation(async ({ where }: { where: { tokenHash: string } }) => {
    const currentId = where.tokenHash === hashSecret(otherToken) ? otherId : id;
    return { userId: currentId, expiresAt: new Date(now.getTime() + 60_000), user: { ...actor, id: currentId,
      ...(options.onboarded === false ? { rulesVersion: 'old' } : {}) } };
  }) } };
  const app = await buildApp({ ...config, REQUESTS_RATE_LIMIT_PER_MINUTE: options.max ?? 60 },
    { prisma: prisma as unknown as PrismaClient, redis: false, requests: service as unknown as RequestService, now: () => now });
  apps.push(app); return { app, prisma, service };
}

describe('request configuration', () => {
  it('validates all request and notification defaults', () => {
    expect(config).toMatchObject({ REQUESTS_PER_DAY: 10, REQUEST_TTL_DAYS: 7, REQUESTS_RATE_LIMIT_PER_MINUTE: 60,
      NOTIFICATION_CONCURRENCY: 3, NOTIFICATION_RATE_LIMIT_PER_SECOND: 25, NOTIFICATION_MAX_ATTEMPTS: 5,
      NOTIFICATION_BACKOFF_MS: 1000, TELEGRAM_CONTACT_TIMEOUT_MS: 5000 });
  });
  it.each([
    { REQUEST_TTL_DAYS: '0' }, { REQUEST_TTL_DAYS: '31' }, { REQUEST_TTL_DAYS: '1.5' },
    { REQUESTS_RATE_LIMIT_PER_MINUTE: '0' }, { REQUESTS_RATE_LIMIT_PER_MINUTE: '601' },
    { NOTIFICATION_RATE_LIMIT_PER_SECOND: '26' }, { NOTIFICATION_CONCURRENCY: '11' },
    { NOTIFICATION_MAX_ATTEMPTS: '0' }, { NOTIFICATION_BACKOFF_MS: '249' }, { TELEGRAM_CONTACT_TIMEOUT_MS: '10001' },
  ])('rejects unsafe/out-of-range config %j', (value) => { expect(() => loadConfig({ ...configInput, ...value })).toThrow('Invalid environment'); });
});

describe('shared message contact filtering', () => {
  it.each(['2001:db8::1', '[::1]', '2001:0db8:0000:0000:0000:ff00:0042:8329', '::ffff:192.168.1.1', 'fe80::1%eth0'])('rejects IPv6 contact %s in messages and bios', (address) => {
    expect(profileTextError('bio', `Сервер ${address}`)).toBe('CONTACTS_NOT_ALLOWED');
    expect(sendRequestInputSchema.safeParse({ toProfileId: otherId, message: `Сервер ${address}` }).success).toBe(false);
  });
  it.each(['Играю в 19:30', 'Счёт 13:9', 'Сервер ::ffff:999.1.1.1', 'abc:12:34'])('retains non-IP text %s', (message) => {
    expect(profileTextError('bio', message)).toBeNull();
  });
});

describe('request route boundaries without database/credentials', () => {
  it('rejects unknown send query parameters before changing request state', async () => {
    const { app, service } = await fixture();
    const response = await app.inject({ method: 'POST', url: '/api/requests?unexpected=private-value',
      headers: { authorization: `Bearer ${token}` }, payload: { toProfileId: otherId } });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('INVALID_INPUT');
    expect(response.body).not.toContain('private-value'); expect(service.send).not.toHaveBeenCalled();
  });
  it('uses one authenticated-user quota across IP changes and isolates shared-IP users', async () => {
    const { app, service } = await fixture({ max: 1 });
    const first = await app.inject({ url: '/api/requests/summary', remoteAddress: '203.0.113.1', headers: { authorization: `Bearer ${token}` } });
    const second = await app.inject({ url: '/api/requests/summary', remoteAddress: '203.0.113.1', headers: { authorization: `Bearer ${otherToken}` } });
    const repeated = await app.inject({ url: '/api/requests/summary', remoteAddress: '203.0.113.2', headers: { authorization: `Bearer ${token}` } });
    expect([first.statusCode, second.statusCode, repeated.statusCode]).toEqual([200, 200, 429]);
    expect(repeated.json().error.code).toBe('RATE_LIMITED'); expect(service.summary).toHaveBeenCalledTimes(2);
  });
  it('serializes the daily reset and Retry-After without exposing identities', async () => {
    const { app, service } = await fixture(); const resetAt = new Date(now.getTime() + 5000).toISOString();
    service.send.mockRejectedValue(new DailyRequestLimitError(resetAt));
    const response = await app.inject({ method: 'POST', url: '/api/requests', headers: { authorization: `Bearer ${token}` }, payload: { toProfileId: otherId } });
    expect(response.statusCode).toBe(429); expect(response.headers['retry-after']).toBe('5');
    expect(response.json().error).toMatchObject({ code: 'DAILY_LIMIT_REACHED', resetAt });
    expect(response.body).not.toContain(token); expect(response.body).not.toContain(id);
  });
  it('rejects incomplete consent before service calls', async () => {
    const { app, service } = await fixture({ onboarded: false });
    const response = await app.inject({ url: '/api/requests/summary', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe('ONBOARDING_INCOMPLETE'); expect(service.summary).not.toHaveBeenCalled();
  });
  it.each(['/api/requests/incoming?limit=0', '/api/requests/outgoing?limit=51', '/api/requests/incoming?unknown=value', '/api/requests/summary?unknown=value'])('strictly rejects query %s', async (url) => {
    const { app } = await fixture(); const response = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('INVALID_INPUT');
  });
});
