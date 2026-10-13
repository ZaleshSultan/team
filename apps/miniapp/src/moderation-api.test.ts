import { describe, expect, it, vi } from 'vitest';
import { SquadApi } from './api.js';
import { publicProfileFixture } from './profile-fixture.js';
import { requestFixture } from './request-fixture.js';

const now = Date.parse('2026-10-14T12:00:00.000Z');
const auth = { token: 'A'.repeat(43), expiresAt: new Date(now + 3_600_000).toISOString(), user: {
  id: 'b3a0b6dd-662e-44a5-9581-c2a3cf075e58', telegramId: '123456789', username: 'test_player', language: 'ru',
  onboarding: { required: false, ageConfirmed: true, rulesAccepted: true, minimumAge: 18, rulesVersion: '2026-10-07', usernameRequired: true },
  steam: null, privacy: { shareSteamActivity: false },
} };
const report = { report: { id: 'f9d545ce-d5b1-47d5-86c9-ec95f626c42b', status: 'OPEN', createdAt: new Date(now).toISOString() }, duplicate: false };
const block = { profileId: publicProfileFixture.id, player: publicProfileFixture, createdAt: report.report.createdAt };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('moderation API client', () => {
  it('sends normalized report evidence privately with only one target reference', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response(report));
    const client = new SquadApi('', send, () => now); await client.authenticate('fixture-init-data');
    await expect(client.report({ profileId: publicProfileFixture.id, reason: 'CONTACT_SPAM', details: '  @contact\nhttps://example.com  ' })).resolves.toEqual(report);
    expect(send.mock.calls[1]?.[0]).toBe('/api/reports');
    expect(send.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Authorization: `Bearer ${auth.token}` } });
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual({ profileId: publicProfileFixture.id, reason: 'CONTACT_SPAM', details: '@contact https://example.com' });
  });
  it('supports report provenance by owned request and idempotent duplicate responses', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ ...report, duplicate: true }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fixture-init-data');
    await expect(client.report({ requestId: requestFixture.id, reason: 'SPAM' })).resolves.toMatchObject({ duplicate: true });
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual({ requestId: requestFixture.id, reason: 'SPAM' });
  });
  it('rejects dual references and excessive details before HTTP', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)); const client = new SquadApi('', send, () => now); await client.authenticate('fixture-init-data');
    expect(() => client.report({ profileId: publicProfileFixture.id, requestId: requestFixture.id, reason: 'SPAM' })).toThrow();
    expect(() => client.report({ requestId: requestFixture.id, reason: 'OTHER', details: '🙂'.repeat(501) })).toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
  it('keeps validated daily reset data without reflecting raw server messages', async () => {
    const resetAt = '2026-10-15T12:00:00.000Z';
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ error: { code: 'REPORT_DAILY_LIMIT_REACHED', message: 'private evidence', resetAt } }, 429));
    const client = new SquadApi('', send, () => now); await client.authenticate('fixture-init-data');
    await expect(client.report({ profileId: publicProfileFixture.id, reason: 'OTHER' })).rejects.toMatchObject({ code: 'REPORT_DAILY_LIMIT_REACHED', message: 'REPORT_DAILY_LIMIT_REACHED', resetAt });
  });
  it.each(['reporterUserId', 'reportedUserId', 'details', 'username'])('rejects report acknowledgments leaking %s', async (field) => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ ...report, report: { ...report.report, [field]: 'private' } }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fixture-init-data');
    await expect(client.report({ profileId: publicProfileFixture.id, reason: 'SPAM' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('paginates blocked public cards with encoded cursor and retains unavailable profile references', async () => {
    const list = { items: [block], nextCursor: 'opaque' }; const hidden = { items: [{ ...block, player: null }], nextCursor: null };
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response(list)).mockResolvedValueOnce(response(hidden));
    const client = new SquadApi('', send, () => now); await client.authenticate('fixture-init-data');
    await expect(client.blocks()).resolves.toEqual(list); await expect(client.blocks('opaque+cursor')).resolves.toEqual(hidden);
    expect(send.mock.calls.slice(1).map(([url]) => url)).toEqual(['/api/blocks?limit=20', '/api/blocks?limit=20&cursor=opaque%2Bcursor']);
  });
  it.each(['username', 'telegramId', 'blockedUserId'])('rejects blocked list entries leaking %s', async (field) => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ items: [{ ...block, [field]: 'private' }], nextCursor: null }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fixture-init-data');
    await expect(client.blocks()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects contact fields nested in a blocked player card', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(auth)).mockResolvedValueOnce(response({ items: [{ ...block, player: { ...publicProfileFixture, username: 'private' } }], nextCursor: null }));
    const client = new SquadApi('', send, () => now); await client.authenticate('fixture-init-data');
    await expect(client.blocks()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('reads public community metadata without a session or bearer', async () => {
    const data = { botUsername: 'Squad_test_bot', minimumAge: 18, rulesVersion: '2026-10-07', supportContact: '@support_test' };
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(data)); const client = new SquadApi('', send, () => now);
    await expect(client.community()).resolves.toEqual(data); expect(send.mock.calls[0]?.[0]).toBe('/api/community');
    expect(send.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
  });
  it('rejects unsafe community link configuration', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ botUsername: 'bot?start=admin', minimumAge: 18, rulesVersion: 'v1', supportContact: '' }));
    const client = new SquadApi('', send, () => now); await expect(client.community()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
