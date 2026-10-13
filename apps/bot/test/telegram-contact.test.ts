import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramContacts, TelegramContactError, notificationSettingsSchema, notificationJobId,
  notificationRetryDelay } from '@squad/shared';

const token = '123456:TEST_TOKEN_NEVER_A_REAL_BOT_12345';
const chatId = '123456789';
const message = { text: 'Test', reply_markup: { inline_keyboard: [[{ text: 'Open', web_app: { url: 'https://example.test' } }]] } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (body: unknown, status = 200) => {
  const fetch = vi.fn(async () => response(body, status));
  return { telegram: new TelegramContacts(token, { fetch }), fetch };
};
afterEach(() => vi.useRealTimers());

describe('Telegram contact adapter', () => {
  it('rechecks a matching private chat using POST and returns only the username', async () => {
    const { telegram, fetch } = client({ ok: true, result: { id: Number(chatId), type: 'private', username: 'Current_name' } });
    expect(await telegram.getUsername(chatId)).toBe('Current_name');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url.endsWith('/getChat')).toBe(true);
    expect(options.method).toBe('POST');
    expect(JSON.parse(String(options.body))).toEqual({ chat_id: chatId });
  });
  it.each([
    { id: 111, type: 'private', username: 'Current_name' },
    { id: Number(chatId), type: 'group', username: 'Current_name' },
    { id: Number(chatId), type: 'private' },
    { id: Number(chatId), type: 'private', username: '' },
    { id: Number(chatId), type: 'private', username: 'https://secret.test' },
    { id: Number(chatId), type: 'private', username: '@Bad_handle' },
    { id: Number(chatId), type: 'private', username: 'invalid-user' },
  ])('rejects unavailable or unsafe contacts', async (result) => {
    const { telegram } = client({ ok: true, result });
    await expect(telegram.getUsername(chatId)).rejects.toMatchObject({ code: 'CONTACT_UNAVAILABLE', retryable: false });
  });
  it('accepts a short collectible username or current active username fallback', async () => {
    const short = client({ ok: true, result: { id: Number(chatId), type: 'private', username: 'a' } });
    expect(await short.telegram.getUsername(chatId)).toBe('a');
    const active = client({ ok: true, result: { id: Number(chatId), type: 'private', active_usernames: ['3collectible', 'Other_alias'] } });
    expect(await active.telegram.getUsername(chatId)).toBe('3collectible');
  });
  it.each(['0', '-123', '123.1', 'a', '12345678901234567', '9999999999999999'])('rejects an invalid private identity without an upstream call', async (id) => {
    const { telegram, fetch } = client({ ok: true });
    await expect(telegram.getUsername(id)).rejects.toBeInstanceOf(TelegramContactError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('marks403 without retaining Telegram description or contact', async () => {
    const { telegram } = client({ ok: false, error_code: 403, description: `blocked ${token} @private_name` }, 403);
    await expect(telegram.getUsername(chatId)).rejects.toMatchObject({ blocked: true, retryable: false,
      code: 'CONTACT_UNAVAILABLE', message: 'CONTACT_UNAVAILABLE' });
  });
  it('handles malformed403 bodies using HTTP status', async () => {
    const telegram = new TelegramContacts(token, { fetch: async () => new Response('bad json', { status: 403 }) });
    await expect(telegram.getUsername(chatId)).rejects.toMatchObject({ blocked: true, retryable: false });
  });
  it('converts retry_after seconds to bounded milliseconds', async () => {
    const { telegram } = client({ ok: false, error_code: 429, parameters: { retry_after: 9 }, description: token }, 429);
    await expect(telegram.getUsername(chatId)).rejects.toMatchObject({ retryAfterMs: 9_000, retryable: true, code: 'CONTACT_RATE_LIMITED' });
  });
  it('defaults missing429 retry_after and bounds an excessive wait', async () => {
    await expect(client({ ok: false, error_code: 429 }, 429).telegram.getUsername(chatId))
      .rejects.toMatchObject({ retryAfterMs: 1_000 });
    await expect(client({ ok: false, error_code: 429, parameters: { retry_after: 9_999_999 } }, 429).telegram.getUsername(chatId))
      .rejects.toMatchObject({ retryAfterMs: 3_600_000 });
  });
  it('replaces raw network errors and token-bearing URLs with fixed errors', async () => {
    const telegram = new TelegramContacts(token, { fetch: async () => { throw new Error(`https://api.telegram.org/bot${token}/getChat @private_name`); } });
    try { await telegram.getUsername(chatId); expect.unreachable(); }
    catch (error) {
      expect(error).toBeInstanceOf(TelegramContactError);
      expect(String(error)).toBe('TelegramContactError: CONTACT_UNAVAILABLE');
      expect(JSON.stringify(error)).not.toMatch(/TEST_TOKEN|private_name|https:/);
      expect((error as Error).cause).toBeUndefined();
    }
  });
  it('times out even when an injected fetch ignores its AbortSignal', async () => {
    vi.useFakeTimers();
    const telegram = new TelegramContacts(token, { timeoutMs: 500, fetch: () => new Promise(() => undefined) });
    const operation = expect(telegram.getUsername(chatId)).rejects.toMatchObject({ code: 'CONTACT_UNAVAILABLE', retryable: true });
    await vi.advanceTimersByTimeAsync(500);
    await operation;
  });
  it('times out a response stream that never finishes', async () => {
    vi.useFakeTimers();
    const telegram = new TelegramContacts(token, { timeoutMs: 500,
      fetch: async () => new Response(new ReadableStream({ start() { /* intentionally pending */ } })) });
    const operation = expect(telegram.getUsername(chatId)).rejects.toMatchObject({ code: 'CONTACT_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(500);
    await operation;
  });
  it.each([false, true])('bounds response bodies with or without Content-Length', async (declared) => {
    const body = JSON.stringify({ ok: true, result: { id: Number(chatId), type: 'private', username: 'Current_name', ignored: 'x'.repeat(70_000) } });
    const telegram = new TelegramContacts(token, { fetch: async () => new Response(body,
      declared ? { headers: { 'content-length': String(body.length) } } : undefined) });
    await expect(telegram.getUsername(chatId)).rejects.toMatchObject({ code: 'CONTACT_UNAVAILABLE', retryable: false });
  });
  it('sends a private message with a Mini App button', async () => {
    const { telegram, fetch } = client({ ok: true, result: { message_id: 1, chat: { id: Number(chatId), type: 'private' } } });
    await telegram.sendMessage(chatId, message);
    const [url, options] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url.endsWith('/sendMessage')).toBe(true);
    expect(JSON.parse(String(options.body))).toEqual({ chat_id: chatId, ...message });
  });
  it('rejects a malformed or mismatching sendMessage result', async () => {
    await expect(client({ ok: true, result: {} }).telegram.sendMessage(chatId, message)).rejects.toBeInstanceOf(TelegramContactError);
    await expect(client({ ok: true, result: { message_id: 1, chat: { id: 987, type: 'private' } } }).telegram.sendMessage(chatId, message))
      .rejects.toBeInstanceOf(TelegramContactError);
  });
});

describe('notification configuration and policy', () => {
  it('uses bounded defaults', () => {
    expect(notificationSettingsSchema.parse({})).toEqual({ NOTIFICATION_CONCURRENCY: 3,
      NOTIFICATION_RATE_LIMIT_PER_SECOND: 25, NOTIFICATION_MAX_ATTEMPTS: 5, NOTIFICATION_BACKOFF_MS: 1_000, TELEGRAM_CONTACT_TIMEOUT_MS: 5_000 });
  });
  it.each([
    ['NOTIFICATION_CONCURRENCY', '11'], ['NOTIFICATION_CONCURRENCY', '0'],
    ['NOTIFICATION_RATE_LIMIT_PER_SECOND', '26'], ['NOTIFICATION_MAX_ATTEMPTS', '11'],
    ['NOTIFICATION_BACKOFF_MS', '249'], ['TELEGRAM_CONTACT_TIMEOUT_MS', '10001'],
  ])('rejects invalid %s', (field, value) => expect(notificationSettingsSchema.safeParse({ [field]: value }).success).toBe(false));
  it('uses stable colon-free job IDs and rejects unsafe IDs', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(notificationJobId(id, 'CREATED')).toBe(`request-${id}-created`);
    expect(notificationJobId(id, 'ACCEPTED')).toBe(`request-${id}-accepted`);
    expect(notificationJobId(id, 'CREATED')).not.toContain(':');
    expect(() => notificationJobId('bad:url:secret', 'CREATED')).toThrow('INVALID_NOTIFICATION_ID');
  });
  it('uses exponential backoff and never retries before retry_after', () => {
    expect([1, 2, 3].map((attempt) => notificationRetryDelay(attempt, 1_000))).toEqual([1_000, 2_000, 4_000]);
    expect(notificationRetryDelay(10, 1_000)).toBe(60_000);
    expect(notificationRetryDelay(1, 1_000, 9_000)).toBe(9_000);
    expect(notificationRetryDelay(1, 1_000, Number.NaN)).toBe(1_000);
  });
});
