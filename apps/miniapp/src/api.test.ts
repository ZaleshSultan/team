import { describe, expect, it, vi } from 'vitest';
import { SquadApi } from './api.js';
import { statsFixture } from './stats-fixture.js';
import { profileFixture, profileInputFixture, publicProfileFixture } from './profile-fixture.js';

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

describe('profile API and account deletion client', () => {
  it('reads and saves own profiles, publishes and fetches the exact public preview using bearer-only authorization', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response(profileFixture))
      .mockResolvedValueOnce(response(profileFixture))
      .mockResolvedValueOnce(response({ published: true, requirements: [] }))
      .mockResolvedValueOnce(response(publicProfileFixture));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.profile()).resolves.toEqual(profileFixture);
    await expect(client.saveProfile(profileInputFixture)).resolves.toEqual(profileFixture);
    await expect(client.publishProfile(true)).resolves.toEqual({ published: true, requirements: [] });
    await expect(client.previewProfile()).resolves.toEqual(publicProfileFixture);
    expect(send.mock.calls.slice(1).map(([url, options]) => [url, options?.method])).toEqual([
      ['/api/me/profile/cs2', 'GET'], ['/api/me/profile/cs2', 'PUT'],
      ['/api/me/profile/cs2/publish', 'PUT'], ['/api/me/profile/cs2/preview', 'GET'],
    ]);
    expect(JSON.parse(String(send.mock.calls[2]?.[1]?.body))).toEqual(profileInputFixture);
    for (const [url, options] of send.mock.calls.slice(1)) {
      expect(url).not.toContain(authPayload.token);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${authPayload.token}` });
    }
  });

  it('patches privacy without sending identity fields', async () => {
    const updated = { ...authPayload.user, privacy: { shareSteamActivity: true } };
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(authPayload)).mockResolvedValueOnce(response({ user: updated }));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.changePrivacy(true)).resolves.toEqual({ user: updated });
    expect(send.mock.calls[1]?.[0]).toBe('/api/me/privacy');
    expect(send.mock.calls[1]?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual({ shareSteamActivity: true });
  });

  it('preserves only safe structured field issues and checklist requirements from server errors', async () => {
    const issues = [{ field: 'nickname', code: 'CONTACTS_NOT_ALLOWED' }];
    const requirements = [{ code: 'PROFILE_INVALID', fields: ['nickname'] }];
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response({ error: { code: 'PROFILE_VALIDATION_FAILED', field: 'nickname', issues, requirements, message: 'raw private input must not be shown' } }, 400));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.saveProfile(profileInputFixture)).rejects.toMatchObject({
      code: 'PROFILE_VALIDATION_FAILED', field: 'nickname', issues, requirements, message: 'PROFILE_VALIDATION_FAILED',
    });
  });

  it('rejects previews containing forbidden fields even when the HTTP response is successful', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response({ ...publicProfileFixture, telegramId: 'private' }));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.previewProfile()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('sends explicit DELETE confirmation and forgets the session after a successful deletion', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(authPayload)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await client.deleteAccount();
    expect(send.mock.calls[1]?.[0]).toBe('/api/me');
    expect(send.mock.calls[1]?.[1]?.method).toBe('DELETE');
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual({ confirmation: 'DELETE' });
    await expect(client.me()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps the session for a failed deletion so the user can retry', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(authPayload)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response({ user: authPayload.user }));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.deleteAccount()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(client.me()).resolves.toEqual({ user: authPayload.user });
  });
});

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

  it('reads cached stats without triggering a provider refresh', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response(statsFixture));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.stats()).resolves.toEqual(statsFixture);
    expect(send.mock.calls[1]?.[0]).toBe('/api/me/stats');
    expect(send.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${authPayload.token}` } });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('accepts a queued asynchronous refresh with a server cooldown', async () => {
    const sync = { ...statsFixture.sync, status: 'QUEUED', manualAvailableAt: '2026-10-12T12:05:00.000Z' };
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response({ sync }, 202));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.refreshStats()).resolves.toEqual({ sync });
    expect(send.mock.calls[1]?.[0]).toBe('/api/me/sync');
    expect(send.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('trims FACEIT input and surfaces only a safe Steam mismatch code', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockResolvedValueOnce(response({ error: { code: 'FACEIT_STEAM_MISMATCH', message: 'upstream secret details' } }, 409));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    await expect(client.linkFaceit('  other-player  ')).rejects.toMatchObject({ code: 'FACEIT_STEAM_MISMATCH', message: 'FACEIT_STEAM_MISMATCH' });
    expect(send.mock.calls[1]?.[0]).toBe('/api/me/faceit/link');
    expect(send.mock.calls[1]?.[1]?.body).toBe('{"nickname":"other-player"}');
  });

  it('does not let a cancelled stats response clear a newly authenticated session', async () => {
    const renewedAuth = { ...authPayload, token: 'B'.repeat(43) };
    let finish!: (result: Response) => void;
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response(renewedAuth))
      .mockResolvedValueOnce(response({ user: renewedAuth.user }));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    const controller = new AbortController();
    const rejected = expect(client.stats(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    client.forgetSession();
    await client.authenticate('new-signed-telegram-data');
    finish(response({ error: { code: 'SESSION_INVALID', message: 'Old session' } }, 401));
    await rejected;
    await expect(client.me()).resolves.toEqual({ user: renewedAuth.user });
    expect(send.mock.calls[3]?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${renewedAuth.token}` });
  });

  it('also isolates an old uncancelled rejection from a newer bearer session', async () => {
    const renewedAuth = { ...authPayload, token: 'B'.repeat(43) };
    let finish!: (result: Response) => void;
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(authPayload))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response(renewedAuth))
      .mockResolvedValueOnce(response({ user: renewedAuth.user }));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    const rejected = expect(client.stats()).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    client.forgetSession();
    await client.authenticate('new-signed-telegram-data');
    finish(response({ error: { code: 'SESSION_INVALID', message: 'Old session' } }, 401));
    await rejected;
    await expect(client.me()).resolves.toEqual({ user: renewedAuth.user });
  });

  it('cancels a FACEIT link request when the card is unmounted', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(authPayload));
    const client = new SquadApi('', send, () => now);
    await client.authenticate('signed-telegram-data');
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    send.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      started();
    }));
    const controller = new AbortController();
    const rejected = expect(client.linkFaceit('TestPlayer', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    controller.abort();
    await rejected;
    expect(send.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });
});
