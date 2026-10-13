import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/squad_test',
  REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
  MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example',
  ADMIN_TELEGRAM_IDS: '12345,67890', SUPPORT_CONTACT: '@squad_support' });

describe('M7 route hardening', () => {
  it('public community metadata exposes only legal navigation and required consent settings', async () => {
    const db = { $disconnect: vi.fn() } as unknown as PrismaClient;
    const app = await buildApp(config, { prisma: db, redis: false });
    try {
      const result = await app.inject('/api/community');
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ botUsername: 'squad_test_bot', minimumAge: 18, rulesVersion: config.RULES_VERSION, supportContact: '@squad_support' });
      for (const value of [config.BOT_TOKEN, 'ADMIN_TELEGRAM_IDS', '12345', '67890', 'DATABASE_URL']) expect(result.body).not.toContain(value);
    } finally { await app.close(); }
  });
  it.each(['/health', '/ready', '/api/community', '/api/me', '/api/me/profile/cs2', '/api/me/stats', '/api/requests/summary'])('rejects unknown query properties: %s', async (url) => {
    const db = { $disconnect: vi.fn(), $queryRaw: vi.fn(), session: { findUnique: vi.fn() } };
    const app = await buildApp(config, { prisma: db as unknown as PrismaClient, redis: false });
    try {
      const result = await app.inject(`${url}?private_unexpected=SECRET`);
      expect(result.statusCode).toBe(400); expect(result.json().error.code).toBe('INVALID_INPUT');
      expect(result.body).not.toContain('SECRET'); expect(result.body).not.toContain('private_unexpected');
      expect(db.$queryRaw).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('keeps unknown routes uniformly 404 and returns no database exception text', async () => {
    const db = { $disconnect: vi.fn(), $queryRaw: vi.fn().mockRejectedValue(new Error('postgresql://user:SECRET@privatehost')) };
    const app = await buildApp(config, { prisma: db as unknown as PrismaClient, redis: false });
    try {
      expect((await app.inject('/api/admin/users?userId=guessed')).statusCode).toBe(404);
      const result = await app.inject('/ready');
      expect(result.statusCode).toBe(503); expect(result.json().error.code).toBe('DEPENDENCIES_UNAVAILABLE');
      expect(result.body).not.toMatch(/SECRET|privatehost|stack|Prisma|postgresql/);
    } finally { await app.close(); }
  });
});
