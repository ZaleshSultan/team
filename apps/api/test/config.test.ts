import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const configInput = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/squad_test',
  REDIS_URL: 'redis://localhost:6379',
  BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx',
  BOT_USERNAME: 'squad_test_bot',
  MINIAPP_URL: 'https://app.example',
  PUBLIC_API_URL: 'https://app.example',
  MINIAPP_ORIGIN: 'https://app.example',
};

describe('configuration URL validation', () => {
  it.each(['DATABASE_URL', 'REDIS_URL', 'MINIAPP_URL', 'PUBLIC_API_URL', 'MINIAPP_ORIGIN'])(
    'reports malformed %s without throwing a URL parser error or exposing values', (field) => {
      const malformed = 'invalid-url-with-private-configuration';
      let error: unknown;
      try {
        loadConfig({ ...configInput, [field]: malformed });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain(`Invalid environment: ${field}:`);
      expect((error as Error).message).not.toContain(malformed);
      expect((error as Error).message).not.toContain(configInput.BOT_TOKEN);
      expect((error as Error).message).not.toContain(configInput.DATABASE_URL);
    },
  );

  it('reports all malformed URLs together', () => {
    expect(() => loadConfig({ ...configInput, DATABASE_URL: 'invalid', REDIS_URL: 'invalid',
      MINIAPP_URL: 'invalid', PUBLIC_API_URL: 'invalid', MINIAPP_ORIGIN: 'invalid' }))
      .toThrow(/Invalid environment: DATABASE_URL:.*REDIS_URL:.*MINIAPP_URL:.*PUBLIC_API_URL:.*MINIAPP_ORIGIN:/);
  });

  it('accepts a production HTTPS origin and rejects a path or credentials', () => {
    expect(loadConfig(configInput).MINIAPP_ORIGIN).toBe('https://app.example');
    expect(() => loadConfig({ ...configInput, MINIAPP_ORIGIN: 'https://app.example/path' }))
      .toThrow('MINIAPP_ORIGIN: Must be an origin without path');
    expect(() => loadConfig({ ...configInput, MINIAPP_ORIGIN: 'https://user:private-secret@app.example' }))
      .toThrow('MINIAPP_ORIGIN: Credentials, query and fragments are not allowed');
  });
});
