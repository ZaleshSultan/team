import { randomUUID } from 'node:crypto';
import { PrismaClient, type TeammateRequestStatus } from '@prisma/client';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestListResponseSchema, requestResponseSchema, TelegramContactError,
  type RequestItem,
} from '@squad/shared';
import { buildApp } from '../src/app.js';
import { createSecret, hashSecret } from '../src/auth/secrets.js';
import { loadConfig } from '../src/config.js';
import { DECLINED_REQUEST_COOLDOWN_DAYS } from '../src/feed/query.js';
import { RequestService } from '../src/requests/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const day = 86_400_000;
const initialNow = new Date('2026-10-14T12:00:00.000Z');

describe.runIf(Boolean(databaseUrl))('M6 isolated PostgreSQL request lifecycle and races', () => {
  let prisma: PrismaClient; let app: FastifyInstance; let gameId: string; let otherGameId: string;
  let caller: Awaited<ReturnType<typeof fixture>>; let now = initialNow; let sequence = 0;
  const userIds: string[] = []; const createdGameIds: string[] = [];
  const contactNames = new Map<string, string>();
  const contacts = { getUsername: vi.fn<(id: string) => Promise<string>>() };
  const dispatch = vi.fn(async () => undefined);
  const fetcher = vi.fn().mockRejectedValue(new Error('Integration tests must never contact external providers'));
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl ?? 'postgresql://unused@localhost/squad_test',
    REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
    MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example',
    FEED_RATE_LIMIT_PER_MINUTE: '600', REQUESTS_RATE_LIMIT_PER_MINUTE: '600' });

  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.slice(1).endsWith('_test')) throw new Error('Only a dedicated *_test database is permitted');
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    gameId = (await prisma.game.findUniqueOrThrow({ where: { slug: 'cs2' } })).id;
    const other = await prisma.game.create({ data: { slug: `m6_fixture_${randomUUID()}`, name: 'M6 fixture game' } });
    otherGameId = other.id; createdGameIds.push(other.id);
    app = await buildApp(config, { prisma, redis: false, now: () => now, fetch: fetcher,
      requests: new RequestService(prisma, config, contacts, dispatch, () => now) });
  });
  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }); userIds.length = 0;
    now = new Date(initialNow); contactNames.clear(); dispatch.mockReset(); contacts.getUsername.mockReset();
    contacts.getUsername.mockImplementation(async (id) => {
      const username = contactNames.get(id);
      if (!username) throw new TelegramContactError(false, 0, false);
      return username;
    });
    caller = await fixture();
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.game.deleteMany({ where: { id: { in: createdGameIds } } });
    }
    if (app) await app.close(); else await prisma?.$disconnect();
    expect(fetcher).not.toHaveBeenCalled();
  });

  async function fixture(options: { steam?: boolean; profile?: boolean; published?: boolean; username?: string | null;
    banned?: boolean; botBlocked?: boolean; onboarding?: boolean; unsafeBio?: boolean; share?: boolean } = {}) {
    const token = createSecret(); const serial = ++sequence;
    const steamId64 = 76561198880000000n + BigInt(serial);
    const telegramId = 8_953_000_000_000n + BigInt(serial);
    const user = await prisma.user.create({ data: {
      telegramId, username: options.username === undefined ? `stored_contact_${serial}` : options.username,
      isBanned: options.banned ?? false, botBlocked: options.botBlocked ?? false,
      ...(options.onboarding === false ? {} : { ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM,
        rulesAcceptedAt: now, rulesVersion: config.RULES_VERSION }),
      ...(options.steam === false ? {} : { steamAccount: { create: { steamId64, personaName: 'Fixture Steam',
        profileVisibility: 3, gameDetailsPublic: true, vacBans: 0, gameBans: 0, communityBanned: false, economyBan: 'none' } } }),
      privacySettings: { create: { shareSteamActivity: options.share ?? false } },
      ...(options.profile === false ? {} : { playerProfiles: { create: { gameId, nickname: 'Fixture Player',
        roles: ['entry'], lookingFor: ['duo'], playTimes: ['evening'], languages: ['ru'], region: 'KZ', hasMic: true,
        bio: options.unsafeBio ? '@legacy_contact' : 'Играю по вечерам.', isPublished: options.published ?? true } } }),
      sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(initialNow.getTime() + 20 * day) } },
    }, include: { playerProfiles: true } });
    userIds.push(user.id); const username = `current_contact_${serial}`; contactNames.set(telegramId.toString(), username);
    return { user, profile: user.playerProfiles[0] ?? null, steamId64, currentUsername: username,
      headers: { authorization: `Bearer ${token}` } };
  }
  async function send(target: Awaited<ReturnType<typeof fixture>>, sender = caller, message?: string) {
    return app.inject({ method: 'POST', url: '/api/requests', headers: sender.headers,
      payload: { toProfileId: target.profile!.id, ...(message === undefined ? {} : { message }) } });
  }
  async function sendOk(target: Awaited<ReturnType<typeof fixture>>, sender = caller, message?: string) {
    const response = await send(target, sender, message);
    expect([200, 201]).toContain(response.statusCode);
    return requestResponseSchema.parse(response.json()).request;
  }
  async function action(id: string, kind: 'accept' | 'decline' | 'cancel', actor = caller) {
    return app.inject({ method: 'POST', url: `/api/requests/${id}/${kind}`, headers: actor.headers, payload: {} });
  }
  async function list(direction: 'incoming' | 'outgoing', actor = caller, query = '') {
    const response = await app.inject({ url: `/api/requests/${direction}${query ? `?${query}` : ''}`, headers: actor.headers });
    expect(response.statusCode).toBe(200); return requestListResponseSchema.parse(response.json());
  }
  async function history(from: Awaited<ReturnType<typeof fixture>>, to: Awaited<ReturnType<typeof fixture>>,
    status: TeammateRequestStatus, options: { gameId?: string; createdAt?: Date; resolvedAt?: Date | null; expiresAt?: Date; id?: string; message?: string } = {}) {
    return prisma.teammateRequest.create({ data: { fromUserId: from.user.id, toUserId: to.user.id, gameId: options.gameId ?? gameId,
      status, createdAt: options.createdAt ?? now, resolvedAt: options.resolvedAt === undefined ? status === 'PENDING' ? null : now : options.resolvedAt,
      expiresAt: options.expiresAt ?? new Date(now.getTime() + 7 * day), ...(options.id ? { id: options.id } : {}),
      message: options.message ?? null } });
  }
  function expectCode(response: { statusCode: number; json(): unknown }, status: number, code: string) {
    expect(response.statusCode).toBe(status); expect(response.json()).toMatchObject({ error: { code } });
  }
  function assertNoContacts(body: unknown, participants: Array<Awaited<ReturnType<typeof fixture>>>) {
    const text = JSON.stringify(body);
    for (const forbidden of ['username', 'telegramId', 'fromUserId', 'toUserId', 'steamId64', 'userGames', 'playtimeTotal', 'library']) expect(text).not.toContain(forbidden);
    for (const person of participants) for (const value of [person.user.id, person.user.telegramId.toString(),
      person.steamId64.toString(), person.user.username, person.currentUsername]) if (value) expect(text).not.toContain(value);
  }

  it.each([
    ['POST', '/api/requests', { toProfileId: randomUUID() }], ['GET', '/api/requests/incoming', undefined],
    ['GET', '/api/requests/outgoing', undefined], ['GET', '/api/requests/summary', undefined],
    ['GET', `/api/requests/${randomUUID()}`, undefined], ['POST', `/api/requests/${randomUUID()}/accept`, {}],
    ['POST', `/api/requests/${randomUUID()}/decline`, {}], ['POST', `/api/requests/${randomUUID()}/cancel`, {}],
    ['POST', `/api/blocks/${randomUUID()}`, {}], ['DELETE', `/api/blocks/${randomUUID()}`, undefined],
  ] as const)('requires a session: %s %s', async (method, url, payload) => {
    const response = await app.inject({ method: method as HTTPMethods, url, ...(payload === undefined ? {} : { payload }) });
    expectCode(response, 401, 'SESSION_INVALID');
  });
  it.each([
    ['POST', '/api/requests', { toProfileId: randomUUID() }], ['GET', '/api/requests/incoming', undefined],
    ['GET', '/api/requests/outgoing', undefined], ['GET', '/api/requests/summary', undefined],
    ['GET', `/api/requests/${randomUUID()}`, undefined], ['POST', `/api/requests/${randomUUID()}/accept`, {}],
    ['POST', `/api/requests/${randomUUID()}/decline`, {}], ['POST', `/api/requests/${randomUUID()}/cancel`, {}],
    ['POST', `/api/blocks/${randomUUID()}`, {}], ['DELETE', `/api/blocks/${randomUUID()}`, undefined],
  ] as const)('requires current onboarding: %s %s', async (method, url, payload) => {
    await prisma.user.update({ where: { id: caller.user.id }, data: { rulesVersion: 'old' } });
    const response = await app.inject({ method: method as HTTPMethods, url, headers: caller.headers, ...(payload === undefined ? {} : { payload }) });
    expectCode(response, 403, 'ONBOARDING_INCOMPLETE');
  });
  it.each([
    [{ steam: false }, 'STEAM_REQUIRED', 409], [{ profile: false }, 'PUBLISHED_PROFILE_REQUIRED', 409],
    [{ published: false }, 'PUBLISHED_PROFILE_REQUIRED', 409], [{ unsafeBio: true }, 'PUBLISHED_PROFILE_REQUIRED', 409],
    [{ banned: true }, 'USER_BANNED', 403], [{ botBlocked: true }, 'CONTACT_UNAVAILABLE', 409],
  ] as const)('rejects an ineligible sender: %j', async (options, code, status) => {
    const sender = await fixture(options); const target = await fixture();
    expectCode(await send(target, sender), status, code);
    expect(await prisma.teammateRequest.count({ where: { fromUserId: sender.user.id } })).toBe(0);
  });
  it.each([
    { username: null }, { username: '   ' }, { ageConfirmedAt: null }, { ageMinimumConfirmed: 17 },
    { rulesAcceptedAt: null }, { rulesVersion: 'old' },
  ])('rechecks each current sender onboarding requirement: %j', async (data) => {
    const target = await fixture(); await prisma.user.update({ where: { id: caller.user.id }, data });
    expectCode(await send(target), 403, 'ONBOARDING_INCOMPLETE');
  });
  it.each([
    { steam: false }, { published: false }, { banned: true }, { botBlocked: true },
    { username: null }, { username: '   ' }, { onboarding: false }, { unsafeBio: true },
  ])('rejects unavailable targets without exposing why: %j', async (options) => {
    const target = await fixture(options); expectCode(await send(target), 409, 'REQUEST_TARGET_UNAVAILABLE');
    expect(await prisma.teammateRequest.count({ where: { fromUserId: caller.user.id } })).toBe(0);
  });
  it('rechecks age/rules consent and refuses missing, own and unsupported-game profiles', async () => {
    const target = await fixture();
    await prisma.user.update({ where: { id: target.user.id }, data: { ageMinimumConfirmed: 17, rulesVersion: 'old' } });
    expectCode(await send(target), 409, 'REQUEST_TARGET_UNAVAILABLE');
    expectCode(await send(caller), 409, 'REQUEST_SELF');
    expectCode(await app.inject({ method: 'POST', url: '/api/requests', headers: caller.headers,
      payload: { toProfileId: randomUUID() } }), 409, 'REQUEST_TARGET_UNAVAILABLE');
    const profile = await prisma.playerProfile.create({ data: { userId: target.user.id, gameId: otherGameId,
      nickname: 'Other Game', roles: ['entry'], languages: ['ru'], region: 'KZ', isPublished: true } });
    expectCode(await app.inject({ method: 'POST', url: '/api/requests', headers: caller.headers,
      payload: { toProfileId: profile.id } }), 409, 'REQUEST_TARGET_UNAVAILABLE');
  });
  it('stores the normalized optional message and configured TTL with one durable notification', async () => {
    const target = await fixture(); const request = await sendOk(target, caller, '  Привет!\n Сыграем?  ');
    expect(request).toMatchObject({ status: 'PENDING', message: 'Привет! Сыграем?', createdAt: now.toISOString(),
      resolvedAt: null, expiresAt: new Date(now.getTime() + config.REQUEST_TTL_DAYS * day).toISOString() });
    expect(await prisma.requestNotification.findMany({ where: { requestId: request.id } })).toMatchObject([
      { requestId: request.id, recipientUserId: target.user.id, kind: 'CREATED' },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(contacts.getUsername).not.toHaveBeenCalled();
    assertNoContacts(request, [caller, target]);
  });
  it.each(['@contact', 'https://private.example', 't.me/contact', 'example.com', '192.168.0.1', '+7 777 123 45 67', '😀'.repeat(201)])
  ('rejects unsafe or oversized messages with fixed errors', async (message) => {
    const target = await fixture(); const response = await send(target, caller, message);
    expectCode(response, 400, 'INVALID_INPUT'); expect(response.body).not.toContain(message);
    expect(await prisma.teammateRequest.count({ where: { fromUserId: caller.user.id } })).toBe(0);
  });
  it('accepts a 200-character Unicode message and rejects unexpected contact input fields', async () => {
    const target = await fixture(); expect((await sendOk(target, caller, '😀'.repeat(200))).message).toBe('😀'.repeat(200));
    const response = await app.inject({ method: 'POST', url: '/api/requests', headers: caller.headers,
      payload: { toProfileId: target.profile!.id, username: 'private_contact' } });
    expectCode(response, 400, 'INVALID_INPUT'); expect(response.body).not.toContain('private_contact');
  });
  it.each(['outgoing', 'incoming'] as const)('honors blocks in the %s direction', async (direction) => {
    const target = await fixture(); await prisma.block.create({ data: direction === 'outgoing'
      ? { blockerUserId: caller.user.id, blockedUserId: target.user.id }
      : { blockerUserId: target.user.id, blockedUserId: caller.user.id } });
    expectCode(await send(target), 409, 'REQUEST_TARGET_UNAVAILABLE');
  });
  it.each([
    ['PENDING', 'outgoing', 'REQUEST_ALREADY_SENT'], ['PENDING', 'incoming', 'REQUEST_ALREADY_RECEIVED'],
    ['ACCEPTED', 'outgoing', 'REQUEST_ALREADY_ACCEPTED'], ['ACCEPTED', 'incoming', 'REQUEST_ALREADY_ACCEPTED'],
  ] as const)('honors existing %s requests in the %s direction across all games', async (status, direction, code) => {
    const target = await fixture(); await history(direction === 'outgoing' ? caller : target,
      direction === 'outgoing' ? target : caller, status, { gameId: otherGameId });
    expectCode(await send(target), 409, code);
  });
  it.each([0, -1])('enforces the inclusive 14-day outgoing decline boundary (%s ms)', async (offset) => {
    const target = await fixture(); const boundary = new Date(now.getTime() - DECLINED_REQUEST_COOLDOWN_DAYS * day);
    await history(caller, target, 'DECLINED', { gameId: otherGameId, resolvedAt: new Date(boundary.getTime() + offset) });
    const result = await send(target);
    if (offset === 0) expectCode(result, 409, 'REQUEST_DECLINED_RECENTLY'); else expect([200, 201]).toContain(result.statusCode);
  });
  it('allows a new request after a reverse decline, cancel, expiry or stale pending expiry', async () => {
    const targets = await Promise.all(Array.from({ length: 4 }, () => fixture()));
    await history(targets[0]!, caller, 'DECLINED');
    await history(caller, targets[1]!, 'CANCELED');
    await history(caller, targets[2]!, 'EXPIRED');
    const stale = await history(targets[3]!, caller, 'PENDING', { expiresAt: now });
    for (const target of targets) expect((await sendOk(target)).status).toBe('PENDING');
    expect(await prisma.teammateRequest.findUnique({ where: { id: stale.id } })).toMatchObject({ status: 'EXPIRED', resolvedAt: now });
  });
  it('makes due pending pairs visible in the feed immediately while retaining active pending and accepted exclusions', async () => {
    const due = await fixture(); const active = await fixture(); const accepted = await fixture();
    const expiredPending = await history(caller, due, 'PENDING', { expiresAt: now });
    await history(active, caller, 'PENDING', { expiresAt: new Date(now.getTime() + 1) });
    await history(caller, accepted, 'ACCEPTED', { expiresAt: new Date(now.getTime() - day) });
    const feed = await app.inject({ url: '/api/feed/cs2', headers: caller.headers });
    expect(feed.statusCode).toBe(200); expect(feed.json().items.map((item: RequestItem['player']) => item?.id)).toEqual([due.profile!.id]);
    // No maintenance worker runs here: expiry-aware reads do not depend on it.
    expect(await prisma.teammateRequest.findUnique({ where: { id: expiredPending.id } })).toMatchObject({ status: 'PENDING' });
  });
  it('counts all sends over a rolling 24 hours and exposes the precise next available reset', async () => {
    const historicalTarget = await fixture(); const target = await fixture();
    const resolvedStatuses = ['ACCEPTED', 'DECLINED', 'CANCELED', 'EXPIRED'] as const;
    for (let index = 1; index <= config.REQUESTS_PER_DAY; index++) await history(caller, historicalTarget,
      index === 1 ? 'PENDING' : resolvedStatuses[(index - 2) % resolvedStatuses.length]!,
      { createdAt: new Date(now.getTime() - index * 3_600_000) });
    const response = await send(target); const resetAt = new Date(now.getTime() + (24 - config.REQUESTS_PER_DAY) * 3_600_000);
    expectCode(response, 429, 'DAILY_LIMIT_REACHED'); expect(response.json().error.resetAt).toBe(resetAt.toISOString());
    now = resetAt; expect((await sendOk(target)).status).toBe('PENDING');
  });
  it.each([0, 1])('uses the precise rolling 24-hour boundary (%s ms)', async (offset) => {
    const past = await fixture(); const target = await fixture();
    for (let index = 0; index < config.REQUESTS_PER_DAY - 1; index++) await history(caller, past, 'CANCELED');
    await history(caller, past, 'CANCELED', { createdAt: new Date(now.getTime() - day + offset) });
    if (offset === 1) {
      const response = await send(target); expectCode(response, 429, 'DAILY_LIMIT_REACHED');
      expect(response.json().error.resetAt).toBe(new Date(now.getTime() + 1).toISOString());
      now = new Date(now.getTime() + 1);
    }
    expect((await sendOk(target)).status).toBe('PENDING');
    const another = await fixture(); expectCode(await send(another), 429, 'DAILY_LIMIT_REACHED');
  });
  it('serializes simultaneous sends to the same target and stores one request/event', async () => {
    const target = await fixture(); const responses = await Promise.all([send(target), send(target)]);
    expect(responses.filter((response) => [200, 201].includes(response.statusCode))).toHaveLength(1);
    expectCode(responses.find((response) => response.statusCode === 409)!, 409, 'REQUEST_ALREADY_SENT');
    expect(await prisma.teammateRequest.count({ where: { fromUserId: caller.user.id, toUserId: target.user.id, status: 'PENDING' } })).toBe(1);
    expect(await prisma.requestNotification.count({ where: { recipientUserId: target.user.id } })).toBe(1);
  });
  it('serializes reciprocal sends without deadlocks', async () => {
    const target = await fixture(); const responses = await Promise.all([send(target), send(caller, target)]);
    expect(responses.filter((response) => [200, 201].includes(response.statusCode))).toHaveLength(1);
    expectCode(responses.find((response) => response.statusCode === 409)!, 409, 'REQUEST_ALREADY_RECEIVED');
    expect(await prisma.teammateRequest.count({ where: { OR: [{ fromUserId: caller.user.id, toUserId: target.user.id },
      { fromUserId: target.user.id, toUserId: caller.user.id }] } })).toBe(1);
  });
  it('serializes quota checks even when concurrent sends use different targets', async () => {
    const past = await fixture();
    for (let index = 0; index < config.REQUESTS_PER_DAY - 1; index++) await history(caller, past, 'CANCELED');
    const first = await fixture(); const second = await fixture(); const responses = await Promise.all([send(first), send(second)]);
    expect(responses.filter((response) => [200, 201].includes(response.statusCode))).toHaveLength(1);
    expectCode(responses.find((response) => response.statusCode === 429)!, 429, 'DAILY_LIMIT_REACHED');
    expect(await prisma.teammateRequest.count({ where: { fromUserId: caller.user.id } })).toBe(config.REQUESTS_PER_DAY);
  });
  it('does not roll back a committed request if enqueue fails', async () => {
    const target = await fixture(); dispatch.mockRejectedValueOnce(new Error('queue unavailable'));
    const request = await sendOk(target);
    expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: 'PENDING' });
    expect(await prisma.requestNotification.count({ where: { requestId: request.id, enqueuedAt: null } })).toBe(1);
  });

  it('keeps incoming/outgoing lists and pending detail free of contacts and private account data', async () => {
    const target = await fixture(); await prisma.userGame.create({ data: { userId: target.user.id,
      steamAppId: 730, gameId, playtimeTotal: 12345, playtime2weeks: 678, syncedAt: now } });
    const request = await sendOk(target); const incoming = await list('incoming', target); const outgoing = await list('outgoing');
    expect(incoming.items.map((item) => item.id)).toEqual([request.id]); expect(outgoing.items.map((item) => item.id)).toEqual([request.id]);
    assertNoContacts(incoming, [caller, target]); assertNoContacts(outgoing, [caller, target]);
    expect(outgoing.items[0]?.player).not.toHaveProperty('activity');
    const detail = await app.inject({ url: `/api/requests/${request.id}`, headers: target.headers });
    expect(detail.statusCode).toBe(200); assertNoContacts(detail.json(), [caller, target]);
    expect(contacts.getUsername).not.toHaveBeenCalled();
    await prisma.privacySettings.update({ where: { userId: target.user.id }, data: { shareSteamActivity: true } });
    expect((await list('outgoing')).items[0]?.player?.activity).toEqual({ cs2Hours: 205.75, cs2Hours2weeks: 11.3 });
  });
  it('sanitizes legacy messages and safely represents a banned or deleted profile', async () => {
    const target = await fixture(); const request = await history(caller, target, 'PENDING', { message: '@legacy_contact' });
    expect((await list('outgoing')).items[0]?.message).toBeNull();
    await prisma.user.update({ where: { id: target.user.id }, data: { isBanned: true } });
    expect((await list('outgoing')).items[0]?.player).toBeNull();
    await prisma.user.update({ where: { id: target.user.id }, data: { isBanned: false } });
    await prisma.playerProfile.delete({ where: { id: target.profile!.id } });
    expect((await list('outgoing')).items[0]).toMatchObject({ id: request.id, player: null });
  });
  it('counts only unexpired pending incoming requests in the navigation badge', async () => {
    const senders = await Promise.all(Array.from({ length: 4 }, () => fixture()));
    await history(senders[0]!, caller, 'PENDING'); await history(senders[1]!, caller, 'PENDING', { expiresAt: now });
    await history(senders[2]!, caller, 'ACCEPTED'); await history(senders[3]!, caller, 'DECLINED');
    const response = await app.inject({ url: '/api/requests/summary', headers: caller.headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ pendingIncoming: 1 });
    expect((await list('incoming')).items.find((item) => item.player?.id === senders[1]!.profile!.id)?.status).toBe('EXPIRED');
  });
  it('paginates tied dates without duplicates and binds cursors to the owner and direction', async () => {
    const target = await fixture(); const rows = [];
    for (let index = 1; index <= 5; index++) rows.push(await history(caller, target, 'CANCELED',
      { id: `a6000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
    const first = await list('outgoing', caller, 'limit=2'); expect(first.items.map((item) => item.id)).toEqual(rows.slice(3).reverse().map((row) => row.id));
    const newer = await history(caller, target, 'CANCELED', { createdAt: new Date(now.getTime() + 1000) });
    await prisma.teammateRequest.delete({ where: { id: rows[3]!.id } });
    const second = await list('outgoing', caller, `limit=2&cursor=${first.nextCursor}`);
    const third = await list('outgoing', caller, `limit=2&cursor=${second.nextCursor}`);
    const all = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(all).toEqual(rows.reverse().map((row) => row.id)); expect(new Set(all).size).toBe(5); expect(all).not.toContain(newer.id);
    expect(third.nextCursor).toBeNull();
    expectCode(await app.inject({ url: `/api/requests/incoming?cursor=${first.nextCursor}`, headers: caller.headers }), 400, 'INVALID_CURSOR');
    expectCode(await app.inject({ url: `/api/requests/outgoing?cursor=${first.nextCursor}`, headers: target.headers }), 400, 'INVALID_CURSOR');
    const payload = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()); payload.id = randomUUID();
    expectCode(await app.inject({ url: `/api/requests/outgoing?cursor=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`,
      headers: caller.headers }), 400, 'INVALID_CURSOR');
  });
  it.each(['limit=0', 'limit=51', 'limit=1.5', 'limit=0x10', 'offset=1', 'limit=2&limit=3'])
  ('rejects unsupported pagination queries: %s', async (query) => {
    expectCode(await app.inject({ url: `/api/requests/incoming?${query}`, headers: caller.headers }), 400, 'INVALID_INPUT');
  });
  it.each(['accept', 'decline', 'cancel', 'detail'] as const)('uses identical 404s for a foreign and missing request: %s', async (kind) => {
    const target = await fixture(); const stranger = await fixture(); const request = await sendOk(target);
    const response = (id: string) => kind === 'detail' ? app.inject({ url: `/api/requests/${id}`, headers: stranger.headers }) : action(id, kind, stranger);
    const foreign = await response(request.id); const missing = await response(randomUUID());
    expectCode(foreign, 404, 'REQUEST_NOT_FOUND'); expectCode(missing, 404, 'REQUEST_NOT_FOUND');
    expect(foreign.json().error.message).toBe(missing.json().error.message); expect(contacts.getUsername).not.toHaveBeenCalled();
  });
  it('limits accept/decline to the recipient and cancel to the sender', async () => {
    const target = await fixture(); const request = await sendOk(target);
    expectCode(await action(request.id, 'accept'), 404, 'REQUEST_NOT_FOUND');
    expectCode(await action(request.id, 'decline'), 404, 'REQUEST_NOT_FOUND');
    expectCode(await action(request.id, 'cancel', target), 404, 'REQUEST_NOT_FOUND');
    expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: 'PENDING' });
  });
  it('accepts only after fresh contact checks and rechecks current usernames on every accepted detail', async () => {
    const target = await fixture(); const request = await sendOk(target); const response = await action(request.id, 'accept', target);
    expect(response.statusCode).toBe(200); expect(requestResponseSchema.parse(response.json())).toMatchObject({ request: { status: 'ACCEPTED' }, contact: { username: caller.currentUsername } });
    expect(new Set(contacts.getUsername.mock.calls.map(([id]) => id))).toEqual(new Set([caller.user.telegramId.toString(), target.user.telegramId.toString()]));
    expect(await prisma.requestNotification.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'asc' } })).toHaveLength(2);
    contactNames.set(target.user.telegramId.toString(), 'changed_current_contact');
    const detail = await app.inject({ url: `/api/requests/${request.id}`, headers: caller.headers });
    expect(detail.statusCode).toBe(200); expect(detail.json().contact).toEqual({ username: 'changed_current_contact' });
    expect(detail.body).not.toContain(target.user.username!);
    assertNoContacts(await list('incoming', target), [caller, target]); assertNoContacts(await list('outgoing'), [caller, target]);
    expectCode(await action(request.id, 'cancel'), 409, 'REQUEST_NOT_PENDING');
  });
  it.each([
    ['missing username', new TelegramContactError(false, 0, false)], ['bot blocked', new TelegramContactError(true, 0, false)],
    ['timeout', new TelegramContactError()], ['rate limited', new TelegramContactError(false, 2000)],
  ] as const)('leaves the request pending when the fresh contact check fails: %s', async (_kind, failure) => {
    const target = await fixture(); const request = await sendOk(target);
    contacts.getUsername.mockImplementation(async (id) => {
      if (id === caller.user.telegramId.toString()) throw failure;
      return target.currentUsername;
    });
    const response = await action(request.id, 'accept', target); expectCode(response, 409, 'CONTACT_UNAVAILABLE');
    expect(response.body).not.toContain(caller.currentUsername); expect(response.body).not.toContain(caller.user.username!);
    expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: 'PENDING', resolvedAt: null });
    expect(await prisma.requestNotification.count({ where: { requestId: request.id, kind: 'ACCEPTED' } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: caller.user.id } })).botBlocked).toBe(failure.blocked);
  });
  it('also refuses acceptance when the recipient lost their current contact', async () => {
    const target = await fixture(); const request = await sendOk(target); contactNames.delete(target.user.telegramId.toString());
    expectCode(await action(request.id, 'accept', target), 409, 'CONTACT_UNAVAILABLE');
    expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: 'PENDING' });
  });
  it.each(['incoming', 'outgoing'] as const)('refuses an existing %s block without any contact lookup', async (direction) => {
    const target = await fixture(); const request = await sendOk(target);
    await prisma.block.create({ data: direction === 'outgoing' ? { blockerUserId: caller.user.id, blockedUserId: target.user.id }
      : { blockerUserId: target.user.id, blockedUserId: caller.user.id } });
    expectCode(await action(request.id, 'accept', target), 409, 'CONTACT_UNAVAILABLE');
    expect(contacts.getUsername).not.toHaveBeenCalled();
    expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: 'PENDING' });
  });
  it('rechecks availability after a delayed contact lookup before accepting', async () => {
    const target = await fixture(); const request = await sendOk(target);
    let started!: () => void; let finish!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    contacts.getUsername.mockImplementation(async (id) => {
      if (id === caller.user.telegramId.toString()) { started(); await release; }
      return contactNames.get(id)!;
    });
    const accepting = action(request.id, 'accept', target); await entered;
    await prisma.playerProfile.update({ where: { id: caller.profile!.id }, data: { isPublished: false } }); finish();
    expectCode(await accepting, 409, 'CONTACT_UNAVAILABLE');
    expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: 'PENDING' });
  });
  it('returns no contact if an accepted-detail lookup fails or a concurrent block commits', async () => {
    const target = await fixture(); const request = await sendOk(target); expect((await action(request.id, 'accept', target)).statusCode).toBe(200);
    contacts.getUsername.mockRejectedValueOnce(new TelegramContactError());
    const unavailable = await app.inject({ url: `/api/requests/${request.id}`, headers: caller.headers });
    expectCode(unavailable, 409, 'CONTACT_UNAVAILABLE'); expect(unavailable.body).not.toContain(target.currentUsername);
    let started!: () => void; let finish!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; }); const release = new Promise<void>((resolve) => { finish = resolve; });
    contacts.getUsername.mockImplementation(async (id) => { started(); await release; return contactNames.get(id)!; });
    const pending = app.inject({ url: `/api/requests/${request.id}`, headers: caller.headers }); await entered;
    expect((await app.inject({ method: 'POST', url: `/api/blocks/${caller.profile!.id}`, headers: target.headers, payload: {} })).statusCode).toBe(200);
    finish(); const blocked = await pending; expectCode(blocked, 409, 'CONTACT_UNAVAILABLE'); expect(blocked.body).not.toContain(target.currentUsername);
  });
  it('declines quietly and cancels only pending requests', async () => {
    const first = await fixture(); const declined = await sendOk(first); const notificationsBefore = await prisma.requestNotification.count({ where: { requestId: declined.id } });
    expect((await action(declined.id, 'decline', first)).json().request.status).toBe('DECLINED');
    expect(await prisma.requestNotification.count({ where: { requestId: declined.id } })).toBe(notificationsBefore);
    expectCode(await action(declined.id, 'accept', first), 409, 'REQUEST_NOT_PENDING');
    const second = await fixture(); const canceled = await sendOk(second);
    expect((await action(canceled.id, 'cancel')).json().request.status).toBe('CANCELED');
    expectCode(await action(canceled.id, 'cancel'), 409, 'REQUEST_NOT_PENDING');
    expect(contacts.getUsername).not.toHaveBeenCalled();
  });
  it.each([{ isBanned: true }, { botBlocked: true }, { username: null }, { rulesVersion: 'old' }])
  ('withholds an accepted contact after the other user becomes unavailable: %j', async (data) => {
    const target = await fixture(); const request = await sendOk(target); expect((await action(request.id, 'accept', target)).statusCode).toBe(200);
    await prisma.user.update({ where: { id: target.user.id }, data });
    const response = await app.inject({ url: `/api/requests/${request.id}`, headers: caller.headers });
    expectCode(response, 409, 'CONTACT_UNAVAILABLE'); expect(response.body).not.toContain(target.currentUsername);
    expect(response.json()).not.toHaveProperty('contact');
  });
  it('expires at the exact TTL boundary without contacting Telegram', async () => {
    const target = await fixture(); const request = await history(caller, target, 'PENDING', { expiresAt: now });
    expectCode(await action(request.id, 'accept', target), 409, 'REQUEST_EXPIRED');
    expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: 'EXPIRED', resolvedAt: now });
    expect(contacts.getUsername).not.toHaveBeenCalled();
  });
  it('serializes concurrent accept/decline and creates an accepted event only for an accepted result', async () => {
    const target = await fixture(); const request = await sendOk(target);
    const responses = await Promise.all([action(request.id, 'accept', target), action(request.id, 'decline', target)]);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expectCode(responses.find((response) => response.statusCode === 409)!, 409, 'REQUEST_NOT_PENDING');
    const final = await prisma.teammateRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(['ACCEPTED', 'DECLINED']).toContain(final.status);
    expect(await prisma.requestNotification.count({ where: { requestId: request.id, kind: 'ACCEPTED' } })).toBe(final.status === 'ACCEPTED' ? 1 : 0);
  });
  it('serializes duplicate concurrent accept actions with one accepted event', async () => {
    const target = await fixture(); const request = await sendOk(target);
    const responses = await Promise.all([action(request.id, 'accept', target), action(request.id, 'accept', target)]);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expectCode(responses.find((response) => response.statusCode === 409)!, 409, 'REQUEST_NOT_PENDING');
    expect(await prisma.requestNotification.count({ where: { requestId: request.id, kind: 'ACCEPTED' } })).toBe(1);
  });
  it.each(['sender', 'recipient'] as const)('blocking by the %s cancels pending requests and wins over an in-flight accept', async (blocker) => {
    const target = await fixture(); const request = await sendOk(target);
    let started!: () => void; let finish!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; }); const release = new Promise<void>((resolve) => { finish = resolve; });
    contacts.getUsername.mockImplementation(async (id) => {
      if (id === caller.user.telegramId.toString()) { started(); await release; } return contactNames.get(id)!;
    });
    const accepting = action(request.id, 'accept', target); await entered;
    const actor = blocker === 'sender' ? caller : target; const blocked = blocker === 'sender' ? target : caller;
    expect((await app.inject({ method: 'POST', url: `/api/blocks/${blocked.profile!.id}`, headers: actor.headers, payload: {} })).statusCode).toBe(200);
    finish(); const response = await accepting; expectCode(response, 409, 'REQUEST_NOT_PENDING');
    expect(response.body).not.toContain(caller.currentUsername);
    expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: 'CANCELED' });
    expect(await prisma.requestNotification.count({ where: { requestId: request.id, kind: 'ACCEPTED' } })).toBe(0);
  });
  it('blocks idempotently, cancels both directions across games and unblocks only the caller-owned block', async () => {
    const target = await fixture(); const first = await history(caller, target, 'PENDING');
    const second = await history(target, caller, 'PENDING', { gameId: otherGameId });
    const accepted = await history(caller, target, 'ACCEPTED', { gameId: otherGameId });
    const url = `/api/blocks/${target.profile!.id}`;
    for (let index = 0; index < 2; index++) expect((await app.inject({ method: 'POST', url, headers: caller.headers, payload: {} })).json()).toEqual({ blocked: true });
    expect(await prisma.block.count({ where: { blockerUserId: caller.user.id, blockedUserId: target.user.id } })).toBe(1);
    expect((await prisma.teammateRequest.findMany({ where: { id: { in: [first.id, second.id] } } })).map((request) => request.status)).toEqual(['CANCELED', 'CANCELED']);
    expect(await prisma.teammateRequest.findUnique({ where: { id: accepted.id } })).toMatchObject({ status: 'ACCEPTED' });
    expectCode(await app.inject({ method: 'DELETE', url: `/api/blocks/${caller.profile!.id}`, headers: target.headers }), 404, 'BLOCK_NOT_FOUND');
    expect((await app.inject({ method: 'DELETE', url, headers: caller.headers })).json()).toEqual({ blocked: false });
    expectCode(await app.inject({ method: 'DELETE', url, headers: caller.headers }), 404, 'BLOCK_NOT_FOUND');
    expectCode(await app.inject({ method: 'POST', url: `/api/blocks/${caller.profile!.id}`, headers: caller.headers, payload: {} }), 409, 'BLOCK_SELF');
  });
  it.each(['sender', 'recipient'] as const)('deleting the %s cascades requests, notifications and sessions and removes the feed card', async (removedSide) => {
    const target = await fixture(); const request = await sendOk(target);
    expect((await action(request.id, 'accept', target)).statusCode).toBe(200);
    expect(await prisma.requestNotification.count({ where: { requestId: request.id } })).toBe(2);
    const removed = removedSide === 'sender' ? caller : target; const survivor = removedSide === 'sender' ? target : caller;
    expect((await app.inject({ method: 'DELETE', url: '/api/me', headers: removed.headers, payload: { confirmation: 'DELETE' } })).statusCode).toBe(204);
    expect(await prisma.teammateRequest.count({ where: { id: request.id } })).toBe(0);
    expect(await prisma.requestNotification.count({ where: { requestId: request.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: removed.user.id } })).toBe(0);
    expect(await list(removedSide === 'sender' ? 'incoming' : 'outgoing', survivor)).toEqual({ items: [], nextCursor: null });
    const feed = await app.inject({ url: '/api/feed/cs2', headers: survivor.headers }); expect(feed.statusCode).toBe(200);
    expect(feed.json().items.map((item: RequestItem['player']) => item?.id)).not.toContain(removed.profile!.id);
    expectCode(await app.inject({ url: `/api/requests/${request.id}`, headers: survivor.headers }), 404, 'REQUEST_NOT_FOUND');
    expectCode(await app.inject({ url: '/api/requests/incoming', headers: removed.headers }), 401, 'SESSION_EXPIRED');
  });
});
