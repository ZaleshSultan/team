import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('API bootstrap', () => {
  it('serves health and returns structured errors', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/test', REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot', MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' });
    const app = await buildApp(config);
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok', milestone: 'M1' });
    const unknown = await app.inject('/unknown');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });
  it('rejects missing configuration without echoing secrets', () => {
    expect(() => loadConfig({ BOT_TOKEN: 'secret' })).toThrow('Invalid environment');
  });
});
