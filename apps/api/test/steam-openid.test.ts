import { describe, expect, it, vi } from 'vitest';
import { buildSteamLoginUrl, verifySteamAssertion } from '../src/auth/steam-openid.js';

const ENDPOINT = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const RETURN_TO = 'https://app.example/api/auth/steam/callback?id=flow&state=random-state';
const STEAM_ID = '76561198000000000';
const NOW = new Date('2026-10-07T12:00:00Z');
const SIGNED = 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle';

function fixture(changes: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    id: 'flow', state: 'random-state',
    'openid.ns': NS, 'openid.mode': 'id_res', 'openid.op_endpoint': ENDPOINT,
    'openid.return_to': RETURN_TO, 'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    'openid.response_nonce': '2026-10-07T12:00:00Zunique', 'openid.assoc_handle': 'association',
    'openid.signed': SIGNED, 'openid.sig': 'c2lnbmF0dXJl', ...changes,
  });
}

function successfulFetch(raw = `ns:${NS}\nis_valid:true\n`) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(raw, { status: 200 }));
}

function verify(params = fixture(), fetcher = successfulFetch()) {
  return verifySteamAssertion(params, RETURN_TO, { now: NOW, maxAgeSeconds: 600, fetch: fetcher });
}

describe('Steam login URL', () => {
  it('uses identifier selection and the fixed HTTPS provider', () => {
    const url = new URL(buildSteamLoginUrl(RETURN_TO, 'https://app.example'));
    expect(`${url.origin}${url.pathname}`).toBe(ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'openid.ns': NS, 'openid.mode': 'checkid_setup', 'openid.return_to': RETURN_TO,
      'openid.realm': 'https://app.example', 'openid.identity': `${NS}/identifier_select`,
      'openid.claimed_id': `${NS}/identifier_select`,
    });
  });

  it('allows HTTP only for a local developer callback', () => {
    expect(buildSteamLoginUrl('http://localhost:3000/callback', 'http://localhost:3000')).toContain('checkid_setup');
  });

  it.each([
    ['https://other.example/callback', 'https://app.example'],
    ['http://app.example/callback', 'http://app.example'],
    ['ftp://localhost/callback', 'ftp://localhost'],
    ['https://app.example/callback#fragment', 'https://app.example'],
    ['https://name:password@app.example/callback', 'https://app.example'],
    ['https://app.example/api-other/callback', 'https://app.example/api'],
    ['https://app.example/api/callback', 'https://app.example?query=1'],
  ])('rejects invalid callback/realm %s %s', (callback, realm) => {
    expect(() => buildSteamLoginUrl(callback, realm)).toThrowError(expect.objectContaining({ code: 'STEAM_INVALID_RESPONSE' }));
  });
});

describe('Steam assertion verification', () => {
  it('verifies server-side and forwards exact OpenID values without application query fields', async () => {
    const fetcher = successfulFetch(`ns:${NS}\r\nis_valid:true\r\n`);
    const params = fixture();
    expect(await verify(params, fetcher)).toEqual({ steamId64: STEAM_ID, nonce: '2026-10-07T12:00:00Zunique' });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(request!.signal).toBeInstanceOf(AbortSignal);
    const posted = request!.body as URLSearchParams;
    expect(posted.get('openid.mode')).toBe('check_authentication');
    expect(posted.get('openid.return_to')).toBe(RETURN_TO);
    expect(posted.get('openid.sig')).toBe(params.get('openid.sig'));
    expect(posted.has('state')).toBe(false);
    expect(posted.has('id')).toBe(false);
    expect(params.get('openid.mode')).toBe('id_res');
  });

  it.each(['state', 'id', 'openid.ns', 'openid.return_to', 'openid.claimed_id'])('rejects duplicate %s before contacting Steam', async (key) => {
    const params = fixture();
    params.append(key, params.get(key)!);
    const fetcher = successfulFetch();
    await expect(verify(params, fetcher)).rejects.toMatchObject({ statusCode: 400, code: 'STEAM_INVALID_RESPONSE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['openid.ns', 'http://openid.net/signon/1.1'], ['openid.mode', 'cancel'],
    ['openid.op_endpoint', 'https://attacker.example/openid'], ['openid.op_endpoint', 'http://steamcommunity.com/openid/login'],
    ['openid.return_to', `${RETURN_TO}x`], ['openid.return_to', RETURN_TO.replace('app.example', 'other.example')],
    ['openid.return_to', RETURN_TO.replace('/callback', '/other')], ['openid.return_to', RETURN_TO.replace('random-state', 'wrong')],
    ['openid.identity', 'https://steamcommunity.com/openid/id/76561198000000001'],
    ['openid.assoc_handle', ''], ['openid.sig', ''], ['openid.sig', '%%%invalid'],
  ])('rejects changed %s', async (key, value) => {
    const fetcher = successfulFetch();
    await expect(verify(fixture({ [key]: value }), fetcher)).rejects.toMatchObject({ code: 'STEAM_INVALID_RESPONSE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'https://steamcommunity.com/openid/id/123', 'https://steamcommunity.com/openid/id/76561198000000000/',
    'https://steamcommunity.com/openid/id/76561198000000000?x=1', 'https://steamcommunity.com/openid/id/76561198000000000#fragment',
    'https://steamcommunity.com.evil.example/openid/id/76561198000000000',
    'http://steamcommunity.com/openid/id/76561198000000000', 'https://steamcommunity.com/openid/id/00000000000000001',
    'https://steamcommunity.com/openid/id/76561197960265728', 'https://steamcommunity.com/openid/id/76561202255233024',
    'https://steamcommunity.com/openid/id/90071996842377217',
  ])('rejects noncanonical/nonindividual SteamID %s', async (claimedId) => {
    await expect(verify(fixture({ 'openid.claimed_id': claimedId, 'openid.identity': claimedId })))
      .rejects.toMatchObject({ code: 'STEAM_INVALID_RESPONSE' });
  });

  it.each(SIGNED.split(','))('rejects unsigned critical field %s', async (unsigned) => {
    await expect(verify(fixture({ 'openid.signed': SIGNED.split(',').filter((field) => field !== unsigned).join(',') })))
      .rejects.toMatchObject({ code: 'STEAM_INVALID_RESPONSE' });
  });

  it('rejects duplicate/unknown signed names and missing assertion fields', async () => {
    for (const signed of [`${SIGNED},identity`, `${SIGNED},missing`, `${SIGNED}, bad`]) {
      await expect(verify(fixture({ 'openid.signed': signed }))).rejects.toMatchObject({ code: 'STEAM_INVALID_RESPONSE' });
    }
    const params = fixture();
    params.delete('openid.response_nonce');
    await expect(verify(params)).rejects.toMatchObject({ code: 'STEAM_INVALID_RESPONSE' });
  });

  it.each([
    '', 'invalid', '2026-10-07T12:00:00Z', '2026-10-07T12:00:00Z suffix',
    '2026-10-07T12:00:00.001Zunique', '2026-02-30T12:00:00Zunique',
    '2026-10-07T11:49:59Zunique', '2026-10-07T12:00:31Zunique',
    `2026-10-07T12:00:00Z${'x'.repeat(236)}`,
  ])('rejects malformed/stale/future nonce %s', async (nonce) => {
    await expect(verify(fixture({ 'openid.response_nonce': nonce }))).rejects.toMatchObject({ code: 'STEAM_INVALID_RESPONSE' });
  });

  it('accepts the exact maximum age and future skew boundaries', async () => {
    expect((await verify(fixture({ 'openid.response_nonce': '2026-10-07T11:50:00Zboundary' }))).steamId64).toBe(STEAM_ID);
    expect((await verify(fixture({ 'openid.response_nonce': '2026-10-07T12:00:30Zboundary' }))).steamId64).toBe(STEAM_ID);
  });

  it.each([
    `ns:${NS}\nis_valid:false\n`, `ns:${NS}\nis_valid:trueevil\n`, `ns:${NS}\nis_valid: true\n`,
    `ns:${NS}\nis_valid:false\nis_valid:true\n`, `ns:${NS}\nns:${NS}\nis_valid:true\n`,
    'is_valid:true\n', 'ns:http://wrong.example\nis_valid:true\n', `ns:${NS}\nis_valid=true\n`,
    `ns:${NS}\nis_valid:true\nmalformed`, '',
  ])('rejects malformed or unsuccessful verification response %s', async (raw) => {
    await expect(verify(fixture(), successfulFetch(raw))).rejects.toMatchObject({ statusCode: 400, code: 'STEAM_INVALID_RESPONSE' });
  });

  it('rejects oversized streamed and advertised verification responses', async () => {
    await expect(verify(fixture(), successfulFetch(`ns:${NS}\nis_valid:true\n${'x'.repeat(8192)}`)))
      .rejects.toMatchObject({ code: 'STEAM_INVALID_RESPONSE' });
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(`ns:${NS}\nis_valid:true`, { headers: { 'content-length': '9000' } }));
    await expect(verify(fixture(), fetcher)).rejects.toMatchObject({ code: 'STEAM_INVALID_RESPONSE' });
  });

  it.each([302, 500, 429])('reports provider HTTP %s as unavailable', async (status) => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status }));
    await expect(verify(fixture(), fetcher)).rejects.toMatchObject({ statusCode: 502, code: 'STEAM_UNAVAILABLE' });
  });

  it('reports network/abort/redirect failures without exposing exception details', async () => {
    for (const error of [new Error('secret URL'), new DOMException('timeout', 'TimeoutError'), new TypeError('redirect')]) {
      const fetcher = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error);
      await expect(verify(fixture(), fetcher)).rejects.toMatchObject({ statusCode: 502, code: 'STEAM_UNAVAILABLE', message: 'Steam authentication is temporarily unavailable' });
    }
  });

  it('reports a broken response stream as unavailable', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private upstream detail')); } });
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream));
    await expect(verify(fixture(), fetcher)).rejects.toMatchObject({ statusCode: 502, code: 'STEAM_UNAVAILABLE' });
  });

  it('rejects excessive callback payload without any network request', async () => {
    const fetcher = successfulFetch();
    await expect(verify(fixture({ extra: 'x'.repeat(16385) }), fetcher)).rejects.toMatchObject({ code: 'STEAM_INVALID_RESPONSE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
