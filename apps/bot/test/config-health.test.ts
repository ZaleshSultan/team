import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminCallbackSchema, adminSettingsSchema } from '@squad/shared';
import { loadConfig } from '../src/config.js';
import { startBotHealth } from '../src/health.js';
const env = { BOT_TOKEN: '123456:TEST_TOKEN_NEVER_A_REAL_BOT_12345', MINIAPP_URL: 'https://example.test',
  DATABASE_URL: 'postgresql://test@127.0.0.1/squad_bot_test', REDIS_URL: 'redis://127.0.0.1:6379' };
describe('shared admin and bot configuration', () => {
  it('defaults to no admins, empty support and180 day retention', () => {
    expect(loadConfig(env)).toMatchObject({ ADMIN_TELEGRAM_IDS: [], SUPPORT_CONTACT: '', REPORT_RETENTION_DAYS: 180 });
  });
  it('normalizes whitespace and duplicate admin ids without logging values', () => {
    expect(loadConfig({ ...env, ADMIN_TELEGRAM_IDS: ' 123456789,987654321,123456789, ', SUPPORT_CONTACT: ' @support ' })).toMatchObject({ ADMIN_TELEGRAM_IDS: ['123456789', '987654321'], SUPPORT_CONTACT: '@support' });
  });
  it.each(['-1', '0', '+1', '1.5', '1e4', '9007199254740992', '123,abc', '１２３'])('rejects invalid administrator ids %s', (value) => {
    expect(() => loadConfig({ ...env, ADMIN_TELEGRAM_IDS: value })).toThrow('Invalid bot configuration: ADMIN_TELEGRAM_IDS');
  });
  it.each(['@support', 'https://t.me/squad_support', ''])('accepts a public support contact %s', (value) => {
    expect(adminSettingsSchema.safeParse({ SUPPORT_CONTACT: value }).success).toBe(true);
  });
  it.each(['https://secret.test', '@support private note', 'https://t.me/name?secret=1', 'https://t.me/name/extra', '+77001234567', '@name\n@other'])('rejects private/arbitrary support text %s', (value) => {
    expect(adminSettingsSchema.safeParse({ SUPPORT_CONTACT: value }).success).toBe(false);
  });
  it.each(['MINIAPP_URL', 'DATABASE_URL', 'REDIS_URL'] as const)('malformed %s reports a fixed field-only configuration error', (field) => {
    try { loadConfig({ ...env, [field]: 'https://[bad-SECRET' }); expect.unreachable(); }
    catch (error) { expect(String(error)).toContain(field); expect(String(error)).not.toMatch(/SECRET|TypeError|Invalid URL/); }
  });
  it('strict admin callback values fit Telegram64-byte limit', () => {
    expect(adminCallbackSchema.safeParse(`ma:${'a'.repeat(32)}`).success).toBe(true);
    expect(adminCallbackSchema.safeParse(`ma:${'a'.repeat(65)}`).success).toBe(false); expect(adminCallbackSchema.safeParse('unknown').success).toBe(false);
  });
});
describe('bot readiness heartbeat', () => {
  afterEach(() => vi.useRealTimers());
  it('checks immediately and every15seconds, and writes unhealthy on stop', async () => {
    vi.useFakeTimers(); const check = vi.fn(async () => true); const write = vi.fn(async () => undefined);
    const runtime = startBotHealth(check, write); await vi.advanceTimersByTimeAsync(0); expect(write).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(15_000); expect(check).toHaveBeenCalledTimes(2); await runtime.stop(); expect(write).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(30_000); expect(check).toHaveBeenCalledTimes(2);
  });
  it('DB/Redis/polling failures and a hung probe write an unhealthy heartbeat without error details', async () => {
    vi.useFakeTimers(); const check = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error('https://SECRET')).mockImplementationOnce(() => new Promise(() => undefined));
    const write = vi.fn(async () => undefined); const runtime = startBotHealth(check, write);
    await vi.advanceTimersByTimeAsync(0); expect(write).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(20_000); expect(write).toHaveBeenLastCalledWith(false); await runtime.stop();
  });
  it('stop cannot be overwritten by an in-flight successful readiness probe', async () => {
    vi.useFakeTimers(); let resolve: (value: boolean) => void = () => undefined;
    const check = vi.fn(() => new Promise<boolean>((done) => { resolve = done; })); const write = vi.fn(async () => undefined);
    const runtime = startBotHealth(check, write); const stopping = runtime.stop(); resolve(true); await stopping;
    expect(write).toHaveBeenLastCalledWith(false); expect(write.mock.calls.every(([healthy]) => healthy === false)).toBe(true);
  });
});
