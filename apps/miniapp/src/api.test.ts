import { describe, expect, it, vi } from 'vitest';
import { SquadApi } from './api.js';

const now = Date.parse('2026-10-07T12:00:00.000Z');
const authPayload = {
  token: 'A'.repeat(43),
  expiresAt: new Date(now + 3_600_000).toISOString(),
  user: {
    id: 'b3a0b6dd-662e-44a5-9581-c2a3cf075e58',
    telegramId: '123456789',
    username: 'test_player',
    language: 'ru',
    onboarding: { required: true, ageConfirmed: false, rulesAccepted: false, minimumAge: 18, rulesVersion: '2026-10-07', usernameRequired: true },
    steam: null,
    privacy: { shareSteamActivity: false },
  },
};
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Mini App authentication client', () => {
  it('binds the default browser fetch to its global receiver', async () => {
    const original = globalThis.fetch;
    let receiver: unknown;
    globalThis.fetch = async function (this: unknown) {
      receiver = this;
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return response(authPayload);
    };
    try {
      await expect(new SquadApi('', undefined, () => now).authenticate('signed-telegram-data')).resolves.toEqual(authPayload);
      expect(receiver).toBe(globalThis);
    } finally { globalThis.fetch = original; }
  });

  it('does not request a session outside Telegram', async () => {
    const send = vi.fn<typeof fetch>();
    await expect(new SquadApi('', send, () => now).authenticate('')).rejects.toMatchObject({ code: 'TELEGRAM_REQUIRED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('shares the login POST across duplicate StrictMode effects', async () => {
    let finish!: (result: Response) => void;
    const send = vi.fn<typeof fetch>().mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const client = new SquadApi('', send, () => now);
    const first = client.authenticate('signed-telegram-data');
    const second = client.authenticate('signed-telegram-data');
    expect(first).toBe(second);
    expect(send).toHaveBeenCalledTimes(1);
    finish(response(authPayload));
    await expect(first).resolves.toEqual(authPayload);
  });

  it('uses relative routes and sends memory-held tokens only in bearer headers', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response({ user: authPayload.user }));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await client.me();
    expect(send.mock.calls[0]?.[0]).toBe('/api/auth/telegram');
    expect(send.mock.calls[1]?.[0]).toBe('/api/me');
    const loginOptions = send.mock.calls[0]?.[1];
    expect(loginOptions?.headers).not.toHaveProperty('Authorization');
    expect(loginOptions?.body).not.toContain(authPayload.token);
    const meOptions = send.mock.calls[1]?.[1];
    expect(meOptions?.headers).toMatchObject({ Authorization: `Bearer ${authPayload.token}` });
    expect(meOptions?.credentials).toBe('omit');
    expect(meOptions?.cache).toBe('no-store');
    expect(meOptions?.referrerPolicy).toBe('no-referrer');
    expect(meOptions?.body).toBeUndefined();
  });

  it('blocks expired sessions before making an authenticated request', async () => {
    let clock = now;
    const send = vi.fn<typeof fetch>().mockResolvedValue(response(authPayload));
    const client = new SquadApi('', send, () => clock);
    await client.authenticate('signed-telegram-data');
    clock += 3_600_001;
    await expect(client.me()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('clears rejected bearer sessions and never exposes server error messages', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response({ error: { code: 'SESSION_INVALID', message: 'private server details' } }, 401));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.me()).rejects.toMatchObject({ code: 'SESSION_INVALID', message: 'SESSION_INVALID' });
    await expect(client.me()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('clears local session memory even when remote logout fails', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockRejectedValueOnce(new TypeError('network failed'));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.logout()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(client.me()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('rejects malformed identities and permits a later login retry', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ...authPayload, token: 'invalid' }))
      .mockResolvedValueOnce(response(authPayload));
    const client = new SquadApi('', send, () => now);
    await expect(client.authenticate('signed-telegram-data')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.authenticate('signed-telegram-data')).resolves.toEqual(authPayload);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects an insecure handoff link before it reaches a browser anchor', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response({ id: authPayload.user.id, expiresAt: authPayload.expiresAt, url: 'http://squad.example/api/auth/steam/start?code=one-time' }));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.createSteamLink()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('enforces its deadline while a successful response body is still stalled', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
        const result = response(authPayload);
        const signal = options?.signal;
        vi.spyOn(result, 'json').mockImplementation(() => new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
        }));
        return result;
      });
      const client = new SquadApi('', send, () => now);
      const assertion = expect(client.authenticate('signed-telegram-data')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('keeps an upstream polling abort connected while the body is being read', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(authPayload));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    let bodyStarted!: () => void;
    const reading = new Promise<void>((resolve) => { bodyStarted = resolve; });
    send.mockImplementationOnce(async (_url, options) => {
      const result = response({ user: authPayload.user });
      const signal = options?.signal;
      vi.spyOn(result, 'json').mockImplementation(() => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
        bodyStarted();
      }));
      return result;
    });
    const controller = new AbortController();
    const assertion = expect(client.me(controller.signal)).rejects.toThrow('body aborted');
    await reading;
    controller.abort();
    await assertion;
  });

  it('clears a banned cached identity before another request or retry', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response({ error: { code: 'USER_BANNED', message: 'This account is banned' } }, 403));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.me()).rejects.toMatchObject({ code: 'USER_BANNED' });
    await expect(client.me()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
