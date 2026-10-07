import { createHash, createHmac, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// Opt in with an explicitly separate test database. Never truncate shared data:
// cleanup deletes only Telegram identities allocated by this suite.
const databaseUrl = process.env.TEST_DATABASE_URL;
const botToken = '123456789:integration_only_abcdefghijklmnopqrstuvwx';
const origin = 'https://app.example';
const startTime = new Date('2026-10-07T12:00:00.000Z');
const fixturePrefix = randomUUID().replaceAll('-', '').slice(0, 12);
const telegramBase = 8_100_000_000_000n + BigInt(Math.floor(Math.random() * 100_000_000));
const steamBase = 76_561_198_000_000_000n + BigInt(Math.floor(Math.random() * 100_000_000));

type Login = { token: string; expiresAt: string; user: { id: string; username: string | null } };
type Flow = { id: string; url: string; expiresAt: string };
type StartedFlow = Flow & { cookie: string; returnTo: string; state: string };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const authorization = (token: string) => ({ authorization: `Bearer ${token}` });

function signedInitData(telegramId: bigint, now: Date, username?: string) {
  const user = { id: Number(telegramId), language_code: 'ru', ...(username ? { username } : {}) };
  const params = new URLSearchParams({
    auth_date: String(Math.floor(now.getTime() / 1000)),
    query_id: `integration_${randomUUID()}`,
    user: JSON.stringify(user),
  });
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', key).update(checkString).digest('hex'));
  return params.toString();
}

describe.runIf(Boolean(databaseUrl))('Telegram and Steam authentication with PostgreSQL', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let now: Date;
  let nextFixture = 0;
  let nextSteam = 0;
  let steamValid: boolean;
  let steamOffline: boolean;
  let holdSteamCheck: (() => Promise<void>) | undefined;
  const ownTelegramIds = new Set<bigint>();
  const telegramUsernames = new Map<string, string | null>();
  const steamChecks: URLSearchParams[] = [];

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl ?? 'postgresql://unused:unused@localhost:5432/squad_test',
    REDIS_URL: 'redis://localhost:6379',
    BOT_TOKEN: botToken,
    BOT_USERNAME: 'squad_integration_bot',
    MINIAPP_URL: origin,
    PUBLIC_API_URL: origin,
    MINIAPP_ORIGIN: origin,
    SESSION_TTL_SECONDS: '3600',
    TELEGRAM_AUTH_MAX_AGE_SECONDS: '300',
    STEAM_LINK_TTL_SECONDS: '600',
    AGE_MINIMUM: '18',
    RULES_VERSION: '2026-10-07',
  });

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://api.telegram.org' && url.pathname === `/bot${botToken}/getChat`) {
      expect(init?.method?.toUpperCase()).toBe('POST');
      const rawBody = String(init?.body ?? '');
      const body = rawBody.startsWith('{') ? JSON.parse(rawBody) as { chat_id: string | number }
        : { chat_id: new URLSearchParams(rawBody).get('chat_id') };
      const id = String(body.chat_id);
      if (!telegramUsernames.has(id)) throw new Error('Unexpected Telegram fixture');
      const username = telegramUsernames.get(id);
      return new Response(JSON.stringify({ ok: true, result: {
        id: Number(id), type: 'private', ...(username ? { username } : {}),
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.origin === 'https://steamcommunity.com' && url.pathname === '/openid/login') {
      expect(init?.method?.toUpperCase()).toBe('POST');
      const params = new URLSearchParams(String(init?.body ?? ''));
      expect(params.get('openid.mode')).toBe('check_authentication');
      steamChecks.push(params);
      await holdSteamCheck?.();
      if (steamOffline) throw new TypeError('Fake Steam outage');
      return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${steamValid}\n`, {
        status: 200, headers: { 'content-type': 'text/plain' },
      });
    }
    throw new Error(`Unexpected external provider: ${url.origin}${url.pathname}`);
  };

  beforeAll(async () => {
    // A naming guard catches accidental use of the normal local squad database.
    if (!new URL(databaseUrl!).pathname.slice(1).endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must select a dedicated database whose name ends in _test');
    }
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    await prisma.$connect();
  });

  beforeEach(async () => {
    now = new Date(startTime);
    steamValid = true;
    steamOffline = false;
    holdSteamCheck = undefined;
    telegramUsernames.clear();
    steamChecks.length = 0;
    app = await buildApp(config, { prisma, fetch: fakeFetch, redis: false, now: () => new Date(now) });
  });

  afterEach(async () => {
    await app?.close();
    if (ownTelegramIds.size) {
      await prisma.user.deleteMany({ where: { telegramId: { in: [...ownTelegramIds] } } });
      ownTelegramIds.clear();
    }
  });

  afterAll(async () => {
    // Also covers fixture creation followed by a failed assertion before afterEach.
    if (prisma && ownTelegramIds.size) {
      await prisma.user.deleteMany({ where: { telegramId: { in: [...ownTelegramIds] } } });
    }
    await prisma?.$disconnect();
  });

  async function login(username: string | null = `it_${fixturePrefix}_${++nextFixture}`): Promise<Login> {
    const telegramId = telegramBase + BigInt(++nextFixture);
    ownTelegramIds.add(telegramId);
    telegramUsernames.set(String(telegramId), username);
    const response = await app.inject({ method: 'POST', url: '/api/auth/telegram',
      payload: { initData: signedInitData(telegramId, now, username ?? undefined) } });
    expect(response.statusCode).toBe(200);
    return response.json<Login>();
  }

  async function onboard(account: Login, changes: Record<string, unknown> = {}) {
    return app.inject({ method: 'POST', url: '/api/onboarding', headers: authorization(account.token),
      payload: { ageConfirmed: true, minimumAge: 18, rulesAccepted: true, rulesVersion: '2026-10-07',
        language: 'ru', shareSteamActivity: false, ...changes } });
  }

  async function readyAccount(): Promise<Login> {
    const account = await login();
    expect((await onboard(account)).statusCode).toBe(200);
    return account;
  }

  async function createFlow(account: Login): Promise<Flow> {
    const response = await app.inject({ method: 'POST', url: '/api/auth/steam/link',
      headers: authorization(account.token), payload: {} });
    expect(response.statusCode).toBe(200);
    return response.json<Flow>();
  }

  async function startFlow(flow: Flow): Promise<StartedFlow> {
    const launch = new URL(flow.url);
    const response = await app.inject({ method: 'GET', url: `${launch.pathname}${launch.search}` });
    expect(response.statusCode).toBe(302);
    const cookies = response.headers['set-cookie'];
    const setCookie = (Array.isArray(cookies) ? cookies : [cookies])
      .find((value) => value?.startsWith(`steam_bind_${flow.id}=`));
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(setCookie).toMatch(/;\s*Path=\/api\/auth\/steam/i);
    const location = new URL(String(response.headers.location));
    expect(location.origin).toBe('https://steamcommunity.com');
    expect(location.pathname).toBe('/openid/login');
    const returnTo = location.searchParams.get('openid.return_to')!;
    const callback = new URL(returnTo);
    expect(callback.origin).toBe(origin);
    expect(callback.searchParams.get('id')).toBe(flow.id);
    const state = callback.searchParams.get('state')!;
    expect(state.length).toBeGreaterThanOrEqual(32);
    return { ...flow, cookie: setCookie!.split(';')[0]!, returnTo, state };
  }

  const steamId = () => String(steamBase + BigInt(++nextSteam));
  const nonce = () => `${now.toISOString().replace('.000', '')}${randomUUID()}`;

  function assertion(flow: StartedFlow, claimedSteamId = steamId(), responseNonce = nonce()) {
    const callback = new URL(flow.returnTo);
    const identity = `https://steamcommunity.com/openid/id/${claimedSteamId}`;
    const params = {
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.claimed_id': identity,
      'openid.identity': identity,
      'openid.return_to': flow.returnTo,
      'openid.response_nonce': responseNonce,
      'openid.assoc_handle': `fixture_${fixturePrefix}`,
      'openid.signed': 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
      'openid.sig': Buffer.from('provider signature is checked by fake Steam').toString('base64'),
    };
    for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
    return `${callback.pathname}${callback.search}`;
  }

  async function callback(flow: StartedFlow, claimedSteamId = steamId(), responseNonce = nonce()) {
    return app.inject({ method: 'GET', url: assertion(flow, claimedSteamId, responseNonce),
      headers: { cookie: flow.cookie } });
  }

  async function poll(account: Login, id: string) {
    return app.inject({ method: 'GET', url: `/api/auth/steam/links/${id}`,
      headers: authorization(account.token) });
  }

  it('verifies Telegram initData and persists only an opaque session token hash', async () => {
    const account = await login();
    expect(account.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(account.token.split('.')).toHaveLength(1);
    const stored = await prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256(account.token) } });
    expect(stored.userId).toBe(account.user.id);
    expect(stored.tokenHash).not.toBe(account.token);
    expect(stored.expiresAt.toISOString()).toBe(account.expiresAt);
    expect((await prisma.privacySettings.findUniqueOrThrow({ where: { userId: account.user.id } })).shareSteamActivity).toBe(false);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: authorization(account.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(account.user.id);
    expect((await app.inject('/api/me')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/me', headers: authorization('unissued_token') })).statusCode).toBe(401);
  });

  it('handles concurrent first Telegram logins as one user with two working sessions', async () => {
    const telegramId = telegramBase + BigInt(++nextFixture);
    ownTelegramIds.add(telegramId);
    const username = `it_${fixturePrefix}_${nextFixture}`;
    const initData = signedInitData(telegramId, now, username);
    expect(await prisma.user.findUnique({ where: { telegramId } })).toBeNull();
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/auth/telegram', payload: { initData } }),
      app.inject({ method: 'POST', url: '/api/auth/telegram', payload: { initData } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const accounts = responses.map((response) => response.json<Login>());
    expect(accounts[0]!.user.id).toBe(accounts[1]!.user.id);
    expect(accounts[0]!.token).not.toBe(accounts[1]!.token);
    expect(await prisma.user.count({ where: { telegramId } })).toBe(1);
    const userId = accounts[0]!.user.id;
    expect(await prisma.privacySettings.count({ where: { userId } })).toBe(1);
    expect(await prisma.session.count({ where: { userId } })).toBe(2);
    for (const account of accounts) {
      const me = await app.inject({ url: '/api/me', headers: authorization(account.token) });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.id).toBe(userId);
      expect((await prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256(account.token) } })).userId).toBe(userId);
    }
  });

  it('rejects tampered Telegram data without creating a user or session', async () => {
    const telegramId = telegramBase + BigInt(++nextFixture);
    ownTelegramIds.add(telegramId);
    const params = new URLSearchParams(signedInitData(telegramId, now, `it_${fixturePrefix}`));
    params.set('user', JSON.stringify({ id: Number(telegramId), username: 'tampered_name' }));
    const response = await app.inject({ method: 'POST', url: '/api/auth/telegram', payload: { initData: params.toString() } });
    expect(response.statusCode).toBe(401);
    expect(await prisma.user.findUnique({ where: { telegramId } })).toBeNull();
  });

  it('rejects sessions at their exact expiry boundary and revoked sessions after logout', async () => {
    const expired = await login();
    await prisma.session.update({ where: { tokenHash: sha256(expired.token) }, data: { expiresAt: new Date(now) } });
    expect((await app.inject({ url: '/api/me', headers: authorization(expired.token) })).statusCode).toBe(401);
    const active = await login();
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authorization(active.token), payload: {} });
    expect(logout.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/me', headers: authorization(active.token) })).statusCode).toBe(401);
    expect(await prisma.session.findUnique({ where: { tokenHash: sha256(active.token) } })).toBeNull();
  });

  it('rejects banned users on both existing sessions and fresh Telegram login', async () => {
    const account = await login();
    const user = await prisma.user.update({ where: { id: account.user.id }, data: { isBanned: true } });
    expect((await app.inject({ url: '/api/me', headers: authorization(account.token) })).statusCode).toBe(403);
    const before = await prisma.session.count({ where: { userId: user.id } });
    const response = await app.inject({ method: 'POST', url: '/api/auth/telegram',
      payload: { initData: signedInitData(user.telegramId, now, user.username ?? undefined) } });
    expect(response.statusCode).toBe(403);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(before);
  });

  it('requires a username and current age/rules consent before onboarding', async () => {
    const noUsername = await login(null);
    const missingContact = await onboard(noUsername);
    expect(missingContact.statusCode).toBe(409);
    expect(missingContact.json().error.code).toBe('USERNAME_REQUIRED');
    const account = await login();
    for (const invalid of [
      { ageConfirmed: false }, { rulesAccepted: false }, { minimumAge: 17 }, { rulesVersion: 'old-rules' },
    ]) {
      expect((await onboard(account, invalid)).statusCode).toBe(400);
    }
    const before = await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } });
    expect(before.ageConfirmedAt).toBeNull();
    expect(before.rulesAcceptedAt).toBeNull();
    expect((await onboard(account, { language: 'en', shareSteamActivity: true })).statusCode).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } });
    expect(after.ageConfirmedAt?.toISOString()).toBe(now.toISOString());
    expect(after.ageMinimumConfirmed).toBe(18);
    expect(after.rulesVersion).toBe('2026-10-07');
    expect(after.rulesAcceptedAt?.toISOString()).toBe(now.toISOString());
    expect(after.language).toBe('en');
    expect((await prisma.privacySettings.findUniqueOrThrow({ where: { userId: after.id } })).shareSteamActivity).toBe(true);
  });

  it('refreshes contact username from Telegram and handles its removal', async () => {
    const account = await login(null);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } });
    telegramUsernames.set(String(user.telegramId), `new_${fixturePrefix}`);
    const refreshed = await app.inject({ method: 'POST', url: '/api/me/telegram/refresh',
      headers: authorization(account.token), payload: {} });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().user.username).toBe(`new_${fixturePrefix}`);
    expect((await onboard(account)).statusCode).toBe(200);
    telegramUsernames.set(String(user.telegramId), null);
    const removed = await app.inject({ method: 'POST', url: '/api/me/telegram/refresh',
      headers: authorization(account.token), payload: {} });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().user.username).toBeNull();
    expect((await onboard(account)).statusCode).toBe(409);
  });

  it('requires onboarding before creating any Steam linking attempt', async () => {
    const account = await login();
    const response = await app.inject({ method: 'POST', url: '/api/auth/steam/link',
      headers: authorization(account.token), payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ONBOARDING_REQUIRED');
    expect(await prisma.steamLink.count({ where: { userId: account.user.id } })).toBe(0);
  });

  it('creates a hash-only Steam flow and scopes polling to its owner', async () => {
    const account = await readyAccount();
    const stranger = await readyAccount();
    const flow = await createFlow(account);
    const code = new URL(flow.url).searchParams.get('code')!;
    expect(code.length).toBeGreaterThanOrEqual(32);
    const pending = await prisma.steamLink.findUniqueOrThrow({ where: { id: flow.id } });
    expect(pending.userId).toBe(account.user.id);
    expect(pending.startCodeHash).toBe(sha256(code));
    expect(pending.startCodeHash).not.toBe(code);
    expect(pending.status).toBe('PENDING');
    expect(pending.callbackStateHash).toBeNull();
    expect((await poll(account, flow.id)).json().status).toBe('PENDING');
    expect((await poll(stranger, flow.id)).statusCode).toBe(404);
    expect((await poll(account, randomUUID())).statusCode).toBe(404);
    expect((await app.inject(`/api/auth/steam/links/${flow.id}`)).statusCode).toBe(401);
    const started = await startFlow(flow);
    const persisted = await prisma.steamLink.findUniqueOrThrow({ where: { id: flow.id } });
    expect(persisted.status).toBe('STARTED');
    expect(persisted.callbackStateHash).toBe(sha256(started.state));
    expect(persisted.browserBindingHash).toBe(sha256(started.cookie.slice(started.cookie.indexOf('=') + 1)));
    expect(persisted.returnTo).toBe(`${origin}/api/auth/steam/callback?id=${flow.id}`);
    expect(persisted.returnTo).not.toContain(started.state);
    expect((await poll(stranger, flow.id)).statusCode).toBe(404);
  });

  it('consumes each external-browser start code once even under concurrent requests', async () => {
    const flow = await createFlow(await readyAccount());
    const url = new URL(flow.url);
    const path = `${url.pathname}${url.search}`;
    const responses = await Promise.all([app.inject(path), app.inject(path)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([302, 410]);
    expect((await app.inject(path)).statusCode).toBe(410);
    expect((await prisma.steamLink.findUniqueOrThrow({ where: { id: flow.id } })).status).toBe('STARTED');
  });

  it('serializes concurrent Steam link creation to exactly one pending attempt', async () => {
    const account = await readyAccount();
    const flows = await Promise.all([createFlow(account), createFlow(account)]);
    expect(flows[0]!.id).not.toBe(flows[1]!.id);
    const rows = await prisma.steamLink.findMany({ where: { userId: account.user.id } });
    expect(rows).toHaveLength(2);
    const active = rows.filter((row) => ['PENDING', 'STARTED', 'VERIFYING'].includes(row.status));
    expect(active).toHaveLength(1);
    expect(active[0]!.status).toBe('PENDING');
    const statuses = await Promise.all(flows.map(async (flow) => {
      const response = await poll(account, flow.id);
      expect(response.statusCode).toBe(200);
      return response.json<{ status: string; failureCode: string | null }>();
    }));
    expect(statuses.map((status) => status.status).sort()).toEqual(['FAILED', 'PENDING']);
    expect(statuses.find((status) => status.status === 'FAILED')!.failureCode).toBe('STEAM_LINK_SUPERSEDED');
  });

  it('rejects a start code at its exact expiry boundary before any Steam request', async () => {
    const flow = await createFlow(await readyAccount());
    now = new Date(now.getTime() + 600_000);
    const url = new URL(flow.url);
    expect((await app.inject(`${url.pathname}${url.search}`)).statusCode).toBe(410);
    expect(steamChecks).toHaveLength(0);
  });

  it('verifies callback in the same browser, completes the account, and rejects state replay', async () => {
    const account = await readyAccount();
    const flow = await startFlow(await createFlow(account));
    const id64 = steamId();
    const responseNonce = nonce();
    const url = assertion(flow, id64, responseNonce);
    const completed = await app.inject({ method: 'GET', url, headers: { cookie: flow.cookie } });
    expect(completed.statusCode).toBe(200);
    expect(completed.headers['content-type']).toContain('text/html');
    expect(steamChecks).toHaveLength(1);
    expect(steamChecks[0]!.get('openid.return_to')).toBe(flow.returnTo);
    expect((await prisma.steamAccount.findUniqueOrThrow({ where: { userId: account.user.id } })).steamId64).toBe(BigInt(id64));
    expect((await poll(account, flow.id)).json().status).toBe('COMPLETED');
    expect((await prisma.steamOpenIdNonce.findUniqueOrThrow({ where: { nonce: responseNonce } })).steamLinkId).toBe(flow.id);
    expect((await app.inject({ method: 'GET', url, headers: { cookie: flow.cookie } })).statusCode).toBe(410);
    expect(steamChecks).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/auth/steam/link',
      headers: authorization(account.token), payload: {} })).statusCode).toBe(409);
  });

  it('rejects missing/wrong browser cookies and wrong state without consuming the legitimate flow', async () => {
    const account = await readyAccount();
    const flow = await startFlow(await createFlow(account));
    const url = assertion(flow);
    expect((await app.inject(url)).statusCode).toBe(400);
    expect((await app.inject({ url, headers: { cookie: `steam_bind_${flow.id}=${'A'.repeat(43)}` } })).statusCode).toBe(400);
    const wrongState = new URL(url, origin);
    wrongState.searchParams.set('state', 'B'.repeat(43));
    expect((await app.inject({ url: `${wrongState.pathname}${wrongState.search}`,
      headers: { cookie: flow.cookie } })).statusCode).toBe(400);
    expect(steamChecks).toHaveLength(0);
    expect((await poll(account, flow.id)).json().status).toBe('STARTED');
    expect((await app.inject({ url, headers: { cookie: flow.cookie } })).statusCode).toBe(200);
  });

  it('rejects cancellation and records a terminal failed link', async () => {
    const account = await readyAccount();
    const flow = await startFlow(await createFlow(account));
    const cancelled = new URL(flow.returnTo);
    cancelled.searchParams.set('openid.mode', 'cancel');
    const response = await app.inject({ url: `${cancelled.pathname}${cancelled.search}`, headers: { cookie: flow.cookie } });
    expect(response.statusCode).toBe(400);
    expect((await poll(account, flow.id)).json()).toMatchObject({ status: 'FAILED', failureCode: 'STEAM_CANCELLED' });
    expect(await prisma.steamAccount.findUnique({ where: { userId: account.user.id } })).toBeNull();
  });

  it('does not create an account when Steam rejects the assertion', async () => {
    const account = await readyAccount();
    const flow = await startFlow(await createFlow(account));
    steamValid = false;
    expect((await callback(flow)).statusCode).toBe(400);
    expect((await poll(account, flow.id)).json().status).toBe('FAILED');
    expect(await prisma.steamAccount.findUnique({ where: { userId: account.user.id } })).toBeNull();
  });

  it('reports an upstream Steam failure without completing an account', async () => {
    const account = await readyAccount();
    const flow = await startFlow(await createFlow(account));
    steamOffline = true;
    expect((await callback(flow)).statusCode).toBe(502);
    expect((await poll(account, flow.id)).json().status).toBe('FAILED');
    expect(await prisma.steamAccount.findUnique({ where: { userId: account.user.id } })).toBeNull();
  });

  it('rejects a nonce replay across two distinct otherwise valid linking flows', async () => {
    const first = await readyAccount();
    const second = await readyAccount();
    const flow1 = await startFlow(await createFlow(first));
    const flow2 = await startFlow(await createFlow(second));
    const responseNonce = nonce();
    expect((await callback(flow1, steamId(), responseNonce)).statusCode).toBe(200);
    const replay = await callback(flow2, steamId(), responseNonce);
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    expect(replay.statusCode).toBeLessThan(500);
    expect(await prisma.steamAccount.findUnique({ where: { userId: second.user.id } })).toBeNull();
    expect((await poll(second, flow2.id)).json().status).toBe('FAILED');
    expect(await prisma.steamOpenIdNonce.count({ where: { nonce: responseNonce } })).toBe(1);
  });

  it('does not transfer a Steam identity already owned by another user', async () => {
    const owner = await readyAccount();
    const other = await readyAccount();
    const ownedId = steamId();
    expect((await callback(await startFlow(await createFlow(owner)), ownedId)).statusCode).toBe(200);
    const conflicting = await startFlow(await createFlow(other));
    expect((await callback(conflicting, ownedId)).statusCode).toBe(409);
    expect((await prisma.steamAccount.findUniqueOrThrow({ where: { steamId64: BigInt(ownedId) } })).userId).toBe(owner.user.id);
    expect(await prisma.steamAccount.findUnique({ where: { userId: other.user.id } })).toBeNull();
    expect((await poll(other, conflicting.id)).json().status).toBe('FAILED');
  });

  it('rechecks bans and required onboarding before completing an external-browser callback', async () => {
    for (const invalidated of [{ isBanned: true }, { username: null }, { ageMinimumConfirmed: 17 }]) {
      const account = await readyAccount();
      const flow = await startFlow(await createFlow(account));
      await prisma.user.update({ where: { id: account.user.id }, data: invalidated });
      expect((await callback(flow)).statusCode).toBe(403);
      expect(await prisma.steamAccount.findUnique({ where: { userId: account.user.id } })).toBeNull();
      expect((await prisma.steamLink.findUniqueOrThrow({ where: { id: flow.id } })).status).toBe('FAILED');
    }
  });

  it('does not replace a completed account through an older still-pending callback', async () => {
    const account = await readyAccount();
    const oldFlow = await startFlow(await createFlow(account));
    const completedFlow = await startFlow(await createFlow(account));
    const establishedId = steamId();
    expect((await callback(completedFlow, establishedId)).statusCode).toBe(200);
    expect((await callback(oldFlow, steamId())).statusCode).toBe(410);
    expect((await prisma.steamAccount.findUniqueOrThrow({ where: { userId: account.user.id } })).steamId64).toBe(BigInt(establishedId));
    expect((await poll(account, oldFlow.id)).json()).toMatchObject({ status: 'FAILED', failureCode: 'STEAM_LINK_SUPERSEDED' });
  });

  it('claims a callback once while verification is in flight', async () => {
    const account = await readyAccount();
    const flow = await startFlow(await createFlow(account));
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    holdSteamCheck = async () => { entered(); await releasePromise; };
    const url = assertion(flow);
    const first = app.inject({ url, headers: { cookie: flow.cookie } }).then((response) => response);
    try {
      await enteredPromise;
      expect((await app.inject({ url, headers: { cookie: flow.cookie } })).statusCode).toBe(410);
    } finally {
      release();
    }
    expect((await first).statusCode).toBe(200);
    expect(steamChecks).toHaveLength(1);
  });

  it('rechecks a ban applied while OpenID verification is in flight', async () => {
    const account = await readyAccount();
    const flow = await startFlow(await createFlow(account));
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    holdSteamCheck = async () => { entered(); await releasePromise; };
    const pending = callback(flow).then((response) => response);
    try {
      await enteredPromise;
      await prisma.user.update({ where: { id: account.user.id }, data: { isBanned: true } });
    } finally {
      release();
    }
    expect((await pending).statusCode).toBe(403);
    expect(await prisma.steamAccount.findUnique({ where: { userId: account.user.id } })).toBeNull();
    expect((await prisma.steamLink.findUniqueOrThrow({ where: { id: flow.id } }))).toMatchObject({
      status: 'FAILED', failureCode: 'ONBOARDING_REQUIRED',
    });
  });

  it('rejects held OpenID verification when a new Steam attempt supersedes it', async () => {
    const account = await readyAccount();
    const oldFlow = await startFlow(await createFlow(account));
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    holdSteamCheck = async () => { entered(); await releasePromise; };
    const pending = callback(oldFlow).then((response) => response);
    let newFlow!: Flow;
    try {
      await enteredPromise;
      expect((await prisma.steamLink.findUniqueOrThrow({ where: { id: oldFlow.id } })).status).toBe('VERIFYING');
      newFlow = await createFlow(account);
      expect((await poll(account, oldFlow.id)).json()).toMatchObject({
        status: 'FAILED', failureCode: 'STEAM_LINK_SUPERSEDED',
      });
    } finally {
      release();
    }
    expect((await pending).statusCode).toBe(410);
    expect(await prisma.steamAccount.findUnique({ where: { userId: account.user.id } })).toBeNull();
    expect(await prisma.steamOpenIdNonce.count({ where: { steamLinkId: oldFlow.id } })).toBe(0);
    expect((await poll(account, newFlow.id)).json().status).toBe('PENDING');
    expect((await poll(account, oldFlow.id)).json()).toMatchObject({
      status: 'FAILED', failureCode: 'STEAM_LINK_SUPERSEDED',
    });
  });

  it('checks the exact flow expiry boundary again after slow OpenID verification', async () => {
    const account = await readyAccount();
    const flow = await startFlow(await createFlow(account));
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    holdSteamCheck = async () => { entered(); await releasePromise; };
    const pending = callback(flow).then((response) => response);
    try {
      await enteredPromise;
      now = new Date(now.getTime() + 600_000);
    } finally {
      release();
    }
    expect((await pending).statusCode).toBe(410);
    expect((await poll(account, flow.id)).json()).toMatchObject({ status: 'FAILED', failureCode: 'STEAM_LINK_EXPIRED' });
    expect(await prisma.steamAccount.findUnique({ where: { userId: account.user.id } })).toBeNull();
  });
});
