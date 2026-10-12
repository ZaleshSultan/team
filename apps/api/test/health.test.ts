import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('API bootstrap', () => {
  it('serves health and returns structured errors', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/test', REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot', MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' });
    const app = await buildApp(config);
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
    const unknown = await app.inject('/unknown');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });
  it('rejects missing configuration without echoing secrets', () => {
    expect(() => loadConfig({ BOT_TOKEN: 'secret' })).toThrow('Invalid environment');
  });
  it('returns a structured 429 when the authentication rate limit is exceeded', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/test', REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot', MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' });
    const app = await buildApp(config);
    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: 'POST', url: '/api/auth/telegram', payload: {} })).statusCode).toBe(400);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/auth/telegram', payload: {} });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    await app.close();
  });
});
