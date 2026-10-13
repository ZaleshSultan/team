import { describe, expect, it, vi } from 'vitest';
import { SquadApi } from './api.js';
import { requestFixture } from './request-fixture.js';
import { publicProfileFixture } from './profile-fixture.js';

const now = Date.parse('2026-10-13T12:00:00.000Z');
const auth = {
  token: 'A'.repeat(43), expiresAt: new Date(now + 3_600_000).toISOString(),
  user: {
    id: 'b3a0b6dd-662e-44a5-9581-c2a3cf075e58', telegramId: '123456789', username: 'test_player', language: 'ru',
    onboarding: { required: false, ageConfirmed: true, rulesAccepted: true, minimumAge: 18, rulesVersion: '2026-10-07', usernameRequired: true },
    steam: null, privacy: { shareSteamActivity: false },
  },
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('requests API client', () => {
  it('sends only normalized optional text and a target profile, authorizing with a memory bearer', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ request: requestFixture }, 201));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    await expect(client.sendRequest({ toProfileId: publicProfileFixture.id, message: '  Пойдём\nиграть?  ' })).resolves.toEqual({ request: requestFixture });
    expect(send.mock.calls[1]?.[0]).toBe('/api/requests');
    expect(send.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', headers: { Authorization: `Bearer ${auth.token}` }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual({ toProfileId: publicProfileFixture.id, message: 'Пойдём играть?' });
    expect(send.mock.calls[1]?.[0]).not.toContain(auth.token);
  });
  it('rejects contact-bearing messages before making an HTTP call', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)); const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    expect(() => client.sendRequest({ toProfileId: publicProfileFixture.id, message: '@username' })).toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
  it('paginates incoming/outgoing with encoded cursors and obtains only a safe pending count', async () => {
    const list = { items: [requestFixture], nextCursor: 'opaque_next' };
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response(list)).mockResolvedValueOnce(response({ ...list, nextCursor: null })).mockResolvedValueOnce(response({ pendingIncoming: 4 }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    await expect(client.requests('incoming')).resolves.toEqual(list);
    await client.requests('outgoing', 'opaque+cursor'); await expect(client.requestSummary()).resolves.toEqual({ pendingIncoming: 4 });
    expect(send.mock.calls.slice(1).map(([url]) => url)).toEqual(['/api/requests/incoming?limit=20', '/api/requests/outgoing?limit=20&cursor=opaque%2Bcursor', '/api/requests/summary']);
  });
  it.each(['username', 'telegramId', 'fromUserId', 'contact'])('rejects list items leaking %s', async (field) => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ items: [{ ...requestFixture, [field]: 'private' }], nextCursor: null }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    await expect(client.requests('incoming')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects a private account identifier nested in another player card', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ items: [{ ...requestFixture, player: { ...publicProfileFixture, steamId64: 'private' } }], nextCursor: null }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    await expect(client.requests('outgoing')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('accepts, declines, and cancels using strict empty mutation bodies', async () => {
    const accepted = { ...requestFixture, status: 'ACCEPTED' as const };
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ request: accepted, contact: { username: 'fresh_username' } }))
      .mockResolvedValueOnce(response({ request: { ...requestFixture, status: 'DECLINED' } })).mockResolvedValueOnce(response({ request: { ...requestFixture, status: 'CANCELED' } }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    await expect(client.resolveRequest(requestFixture.id, 'accept')).resolves.toEqual({ request: accepted, contact: { username: 'fresh_username' } });
    await client.resolveRequest(requestFixture.id, 'decline'); await client.resolveRequest(requestFixture.id, 'cancel');
    expect(send.mock.calls.slice(1).map(([url, init]) => [url, init?.method, init?.body])).toEqual(['accept', 'decline', 'cancel'].map((action) => [`/api/requests/${requestFixture.id}/${action}`, 'POST', '{}']));
  });
  it('checks accepted contacts afresh and rejects contacts for pending requests or unsafe usernames', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth))
      .mockResolvedValueOnce(response({ request: { ...requestFixture, status: 'ACCEPTED' }, contact: { username: 'fresh_player' } }))
      .mockResolvedValueOnce(response({ request: requestFixture, contact: { username: 'private_player' } }))
      .mockResolvedValueOnce(response({ request: { ...requestFixture, status: 'ACCEPTED' }, contact: { username: 'player?bad' } }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    await expect(client.requestContact(requestFixture.id)).resolves.toMatchObject({ contact: { username: 'fresh_player' } });
    await expect(client.requestContact(requestFixture.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.requestContact(requestFixture.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(send.mock.calls[1]?.[0]).toBe(`/api/requests/${requestFixture.id}`);
    expect(send.mock.calls[1]?.[1]?.method).toBe('GET');
  });
  it('blocks and unblocks only by public profile reference', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ blocked: true })).mockResolvedValueOnce(response({ blocked: false }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    await expect(client.blockProfile(publicProfileFixture.id)).resolves.toEqual({ blocked: true }); await expect(client.unblockProfile(publicProfileFixture.id)).resolves.toEqual({ blocked: false });
    expect(send.mock.calls.slice(1).map(([url, init]) => [url, init?.method, init?.body])).toEqual([[`/api/blocks/${publicProfileFixture.id}`, 'POST', '{}'], [`/api/blocks/${publicProfileFixture.id}`, 'DELETE', undefined]]);
  });
  it('keeps the validated daily reset time but never displays a raw server error message', async () => {
    const resetAt = '2026-10-14T12:00:00.000Z';
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ error: { code: 'DAILY_LIMIT_REACHED', resetAt, message: 'private raw server input' } }, 429));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    await expect(client.sendRequest({ toProfileId: publicProfileFixture.id })).rejects.toMatchObject({ code: 'DAILY_LIMIT_REACHED', resetAt, message: 'DAILY_LIMIT_REACHED' });
  });
  it('rejects invalid reset dates rather than reflecting unchecked text', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ error: { code: 'DAILY_LIMIT_REACHED', resetAt: '<script>raw</script>' } }, 429));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    await expect(client.sendRequest({ toProfileId: publicProfileFixture.id })).rejects.toMatchObject({ code: 'REQUEST_FAILED', resetAt: undefined });
  });
  it('cancels mutation requests when a card or screen is unmounted', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fake-signed-init-data');
    const controller = new AbortController(); const pending = client.resolveRequest(requestFixture.id, 'accept', controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
