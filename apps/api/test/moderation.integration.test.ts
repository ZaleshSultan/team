import { randomUUID } from 'node:crypto';
import { PrismaClient, type ReportReason, type TeammateRequestStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockListResponseSchema, reportResponseSchema } from '@squad/shared';
import { buildApp } from '../src/app.js';
import { createSecret, hashSecret } from '../src/auth/secrets.js';
import { loadConfig } from '../src/config.js';
import { ReportService } from '../src/moderation/service.js';
import { retainModerationData } from '../src/moderation/maintenance.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const day = 86_400_000;
const initialNow = new Date('2026-10-15T12:00:00.000Z');
describe.runIf(Boolean(databaseUrl))('M7 isolated PostgreSQL reports, protection, blocks and retention', () => {
  let prisma: PrismaClient; let app: FastifyInstance; let gameId: string; let sequence = 0;
  let now = initialNow; let caller: Awaited<ReturnType<typeof fixture>>;
  const userIds: string[] = []; const auditIds: string[] = [];
  const dispatch = vi.fn(async () => undefined);
  const fetcher = vi.fn().mockRejectedValue(new Error('M7 fixtures never contact external providers'));
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl ?? 'postgresql://unused@localhost/squad_test',
    REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
    MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example',
    FEED_RATE_LIMIT_PER_MINUTE: '600', REQUESTS_RATE_LIMIT_PER_MINUTE: '600', REPORTS_RATE_LIMIT_PER_MINUTE: '600',
    ADMIN_TELEGRAM_IDS: '12345678,87654321,12345678' });
  beforeAll(async () => {
    if (!databaseUrl || !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)
      || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Only a dedicated loopback *_test database is permitted');
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    gameId = (await prisma.game.findUniqueOrThrow({ where: { slug: 'cs2' } })).id;
    app = await buildApp(config, { prisma, redis: false, now: () => now, fetch: fetcher,
      moderation: new ReportService(prisma, config, dispatch, () => now) });
  });
  beforeEach(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { id: { in: auditIds } } }); auditIds.length = 0;
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }); userIds.length = 0;
    now = new Date(initialNow); dispatch.mockClear(); caller = await fixture();
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.adminAuditLog.deleteMany({ where: { id: { in: auditIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (app) await app.close(); else await prisma?.$disconnect();
    expect(fetcher).not.toHaveBeenCalled();
  });
  async function fixture(options: { steam?: boolean; published?: boolean; onboarding?: boolean; banned?: boolean;
    username?: string | null; createdAt?: Date; share?: boolean; unsafe?: boolean; botBlocked?: boolean } = {}) {
    const serial = ++sequence; const token = createSecret();
    const user = await prisma.user.create({ data: { telegramId: 8_957_000_000_000n + BigInt(serial),
      username: options.username === undefined ? `private_m7_${serial}` : options.username,
      isBanned: options.banned ?? false, botBlocked: options.botBlocked ?? false,
      createdAt: options.createdAt ?? new Date(now.getTime() - 2 * day),
      ...(options.onboarding === false ? {} : { ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM,
        rulesAcceptedAt: now, rulesVersion: config.RULES_VERSION }),
      ...(options.steam === false ? {} : { steamAccount: { create: { steamId64: 76561198970000000n + BigInt(serial),
        personaName: 'Fixture Player', vacBans: 0, gameBans: 0, communityBanned: false, economyBan: 'none' } } }),
      privacySettings: { create: { shareSteamActivity: options.share ?? false } },
      userGames: { create: { steamAppId: 730, gameId, playtimeTotal: 12345, playtime2weeks: 678, syncedAt: now } },
      playerProfiles: { create: { gameId, nickname: 'Fixture Player', roles: ['entry'], lookingFor: ['duo'],
        playTimes: ['evening'], languages: ['ru'], region: 'KZ', hasMic: true,
        bio: options.unsafe ? '@private_legacy_contact' : 'Играю по вечерам.', isPublished: options.published ?? true } },
      sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(now.getTime() + 30 * day) } },
    }, include: { playerProfiles: true } });
    userIds.push(user.id);
    return { user, profile: user.playerProfiles[0]!, headers: { authorization: `Bearer ${token}` } };
  }
  function report(target: Awaited<ReturnType<typeof fixture>>, reporter = caller, details?: string) {
    return app.inject({ method: 'POST', url: '/api/reports', headers: reporter.headers,
      payload: { profileId: target.profile.id, reason: 'SPAM', ...(details === undefined ? {} : { details }) } });
  }
  async function history(from: Awaited<ReturnType<typeof fixture>>, to: Awaited<ReturnType<typeof fixture>>,
    status: TeammateRequestStatus = 'DECLINED', createdAt = now, resolvedAt: Date | null = now) {
    return prisma.teammateRequest.create({ data: { fromUserId: from.user.id, toUserId: to.user.id, gameId, status,
      createdAt, resolvedAt, expiresAt: new Date(createdAt.getTime() + 7 * day) } });
  }
  function expectCode(response: { statusCode: number; json(): unknown }, status: number, code: string) {
    expect(response.statusCode).toBe(status); expect(response.json()).toMatchObject({ error: { code } });
  }
  function noPrivate(body: unknown, people: Array<Awaited<ReturnType<typeof fixture>>>) {
    const text = JSON.stringify(body);
    for (const key of ['username', 'telegramId', 'reportedUserId', 'reporterUserId', 'userId', 'steamId64', 'details', 'resolutionNote', 'playtimeTotal']) expect(text).not.toContain(key);
    for (const person of people) for (const value of [person.user.id, person.user.telegramId.toString(), person.user.username]) if (value) expect(text).not.toContain(value);
  }
  it.each([['POST', '/api/reports'], ['GET', '/api/blocks']] as const)('requires authentication: %s %s', async (method, url) => {
    expectCode(await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) }), 401, 'SESSION_INVALID');
  });
  it('requires current onboarding even for blocked-list reads', async () => {
    const incomplete = await fixture({ onboarding: false }); const target = await fixture();
    expectCode(await report(target, incomplete), 403, 'ONBOARDING_INCOMPLETE');
    expectCode(await app.inject({ url: '/api/blocks', headers: incomplete.headers }), 403, 'ONBOARDING_INCOMPLETE');
  });
  it.each(['SPAM', 'HARASSMENT', 'CHEATING', 'FAKE_PROFILE', 'CONTACT_SPAM', 'UNDERAGE', 'OTHER'] as ReportReason[])('creates a private %s report and only closed response data', async (reason) => {
    const target = await fixture();
    const response = await app.inject({ method: 'POST', url: '/api/reports', headers: caller.headers,
      payload: { profileId: target.profile.id, reason, details: '  private\u200b\n evidence @name https://example.test  ' } });
    expect(response.statusCode).toBe(201); const result = reportResponseSchema.parse(response.json());
    expect(result.duplicate).toBe(false); noPrivate(result, [caller, target]);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: result.report.id } })).toMatchObject({ reporterUserId: caller.user.id,
      reportedUserId: target.user.id, reason, details: 'private evidence @name https://example.test', gameId, requestId: null });
    expect(await prisma.moderationNotification.count({ where: { reportId: result.report.id } })).toBe(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('rejects self reports with a fixed code', async () => {
    expectCode(await report(caller), 409, 'REPORT_SELF'); expect(await prisma.report.count({ where: { reporterUserId: caller.user.id } })).toBe(0);
  });
  it.each([{ published: false }, { banned: true }, { botBlocked: true }, { username: null }, { onboarding: false }, { steam: false }, { unsafe: true }])('returns the same 404 for invisible targets %j', async (options) => {
    const target = await fixture(options); const response = await report(target);
    expectCode(response, 404, 'REPORT_TARGET_NOT_FOUND');
    const missing = await app.inject({ method: 'POST', url: '/api/reports', headers: caller.headers,
      payload: { profileId: randomUUID(), reason: 'SPAM' } });
    expect(missing.json().error.code).toBe(response.json().error.code);
    expect(missing.json().error.message).toBe(response.json().error.message);
  });
  it.each(['forward', 'reverse'])('rejects guessed blocked feed targets (%s)', async (direction) => {
    const target = await fixture();
    await prisma.block.create({ data: { blockerUserId: direction === 'forward' ? caller.user.id : target.user.id,
      blockedUserId: direction === 'forward' ? target.user.id : caller.user.id } });
    expectCode(await report(target), 404, 'REPORT_TARGET_NOT_FOUND');
  });
  it('allows positive VAC/game-ban evidence visible with the include-bans filter', async () => {
    const target = await fixture(); await prisma.steamAccount.update({ where: { userId: target.user.id }, data: { vacBans: 2, gameBans: 1 } });
    expect((await report(target)).statusCode).toBe(201);
  });
  it.each([{ steam: false }, { published: false }])('rejects feed guessing by a caller who cannot access the feed %j', async (options) => {
    const reporter = await fixture(options); const target = await fixture();
    expectCode(await report(target, reporter), 404, 'REPORT_TARGET_NOT_FOUND');
  });
  it('allows an owned request-history report after a target is hidden, banned or blocked', async () => {
    const target = await fixture({ published: false, banned: true }); const request = await history(target, caller);
    await prisma.block.create({ data: { blockerUserId: caller.user.id, blockedUserId: target.user.id } });
    const response = await app.inject({ method: 'POST', url: '/api/reports', headers: caller.headers,
      payload: { requestId: request.id, reason: 'HARASSMENT' } });
    expect(response.statusCode).toBe(201);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: response.json().report.id } })).toMatchObject({ requestId: request.id,
      reportedUserId: target.user.id, gameId });
  });
  it('permits the matching profile target through owned request history even without caller Steam/publication', async () => {
    const reporter = await fixture({ steam: false, published: false }); const target = await fixture({ published: false });
    await history(reporter, target); expect((await report(target, reporter)).statusCode).toBe(201);
  });
  it('returns ownership-safe 404s for foreign or unknown requests', async () => {
    const first = await fixture(); const second = await fixture(); const request = await history(first, second);
    for (const requestId of [request.id, randomUUID()]) expectCode(await app.inject({ method: 'POST', url: '/api/reports', headers: caller.headers,
      payload: { requestId, reason: 'SPAM' } }), 404, 'REPORT_TARGET_NOT_FOUND');
  });
  it('returns an OPEN duplicate before quota and does not replace details or notify again', async () => {
    const target = await fixture(); const service = new ReportService(prisma, { ...config, REPORTS_PER_DAY: 1 }, dispatch, () => now);
    const first = await service.report(caller.user.id, { profileId: target.profile.id, reason: 'SPAM', details: 'Original' });
    await prisma.playerProfile.update({ where: { id: target.profile.id }, data: { isPublished: false, moderationHidden: true } });
    const duplicate = await service.report(caller.user.id, { profileId: target.profile.id, reason: 'OTHER', details: 'Replacement' });
    expect(duplicate).toEqual({ ...first, duplicate: true }); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: first.report.id } })).toMatchObject({ details: 'Original', reason: 'SPAM' });
    expect(await prisma.moderationNotification.count({ where: { reportId: first.report.id } })).toBe(2);
  });
  it('enforces a rolling quota across targets and statuses with an exact reset time', async () => {
    const first = await fixture(); const second = await fixture();
    const service = new ReportService(prisma, { ...config, REPORTS_PER_DAY: 1 }, dispatch, () => now);
    const result = await service.report(caller.user.id, { profileId: first.profile.id, reason: 'SPAM' });
    await prisma.report.update({ where: { id: result.report.id }, data: { status: 'DISMISSED', resolvedAt: now } });
    await expect(service.report(caller.user.id, { profileId: second.profile.id, reason: 'SPAM' })).rejects.toMatchObject({
      code: 'REPORT_DAILY_LIMIT_REACHED', statusCode: 429, resetAt: new Date(now.getTime() + day).toISOString() });
    now = new Date(now.getTime() + day);
    expect((await service.report(caller.user.id, { profileId: second.profile.id, reason: 'SPAM' })).duplicate).toBe(false);
  });
  it('does not treat an OPEN row at exactly 24 hours as a duplicate or active quota row', async () => {
    const target = await fixture(); await prisma.report.create({ data: { reporterUserId: caller.user.id, reportedUserId: target.user.id,
      reason: 'SPAM', createdAt: new Date(now.getTime() - day) } });
    const result = await new ReportService(prisma, { ...config, REPORTS_PER_DAY: 1 }, dispatch, () => now).report(caller.user.id,
      { profileId: target.profile.id, reason: 'OTHER' });
    expect(result.duplicate).toBe(false); expect(await prisma.report.count({ where: { reporterUserId: caller.user.id } })).toBe(2);
  });
  it('serializes concurrent duplicate reports and quota across different targets', async () => {
    const target = await fixture(); const duplicateResults = await Promise.all([report(target), report(target)]);
    expect(duplicateResults.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(new Set(duplicateResults.map((response) => response.json().report.id)).size).toBe(1);
    const reporter = await fixture(); const targets = await Promise.all([fixture(), fixture(), fixture()]);
    const service = new ReportService(prisma, { ...config, REPORTS_PER_DAY: 1 }, dispatch, () => now);
    const results = await Promise.allSettled(targets.map((item) => service.report(reporter.user.id, { profileId: item.profile.id, reason: 'SPAM' })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.report.count({ where: { reporterUserId: reporter.user.id } })).toBe(1);
  });
  it('hides and flags a profile at three distinct old Steam-linked reporters without exposing the outcome', async () => {
    const target = await fixture(); const reporters = [caller, await fixture(), await fixture()];
    const responses = await Promise.all(reporters.map((reporter) => report(target, reporter)));
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    const profile = await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profile.id } });
    expect(profile).toMatchObject({ isPublished: false, moderationHidden: true, moderationWasPublished: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).moderationFlaggedAt).toEqual(now);
    for (const response of responses) expect(Object.keys(response.json()).sort()).toEqual(['duplicate', 'report']);
    const publish = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: target.headers, payload: { published: true } });
    expect(publish.statusCode).toBe(409); expect(publish.json()).toMatchObject({ error: { requirements: [{ code: 'MODERATION_HIDDEN' }] } });
    // The report+optional-block UI remains useful even when this report was the
    // threshold-crossing event and the target disappeared from discovery.
    await prisma.playerProfile.update({ where: { id: caller.profile.id }, data: { isPublished: false } });
    const block = await app.inject({ method: 'POST', url: `/api/blocks/${target.profile.id}`, headers: caller.headers, payload: {} });
    expect(block.statusCode).toBe(200); expect(block.json()).toEqual({ blocked: true });
  });
  it('counts repeated reports by one reporter only once', async () => {
    const target = await fixture();
    for (let count = 0; count < 3; count += 1) {
      const response = await report(target);
      await prisma.report.update({ where: { id: response.json().report.id }, data: { status: 'REVIEWED', resolvedAt: now } });
    }
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profile.id } })).isPublished).toBe(true);
    expect((await report(target, await fixture())).statusCode).toBe(201);
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profile.id } })).isPublished).toBe(true);
  });
  it.each(['new', 'boundary', 'unlinked', 'banned', 'dismissed', 'old-report'])('excludes %s reporters/reports from automatic protection counts', async (condition) => {
    const target = await fixture(); const oldReporter = await fixture();
    const excluded = await fixture({ ...(condition === 'new' ? { createdAt: new Date(now.getTime() - 60_000) } : {}),
      ...(condition === 'boundary' ? { createdAt: new Date(now.getTime() - day) } : {}),
      ...(condition === 'unlinked' ? { steam: false } : {}), ...(condition === 'banned' ? { banned: true } : {}) });
    await prisma.report.createMany({ data: [{ reporterUserId: oldReporter.user.id, reportedUserId: target.user.id, reason: 'SPAM', createdAt: now },
      { reporterUserId: excluded.user.id, reportedUserId: target.user.id, reason: 'SPAM',
        status: condition === 'dismissed' ? 'DISMISSED' : 'OPEN', createdAt: condition === 'old-report' ? new Date(now.getTime() - 7 * day - 1) : now }] });
    expect((await report(target)).statusCode).toBe(201);
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profile.id } })).isPublished).toBe(true);
  });
  it('includes a qualifying report at the exact seven-day boundary', async () => {
    const target = await fixture(); const reporters = [await fixture(), await fixture()];
    await prisma.report.createMany({ data: reporters.map((reporter) => ({ reporterUserId: reporter.user.id,
      reportedUserId: target.user.id, reason: 'SPAM' as const, createdAt: new Date(now.getTime() - 7 * day) })) });
    expect((await report(target)).statusCode).toBe(201);
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profile.id } })).moderationHidden).toBe(true);
  });
  it('paginates only caller blocks through unpublished/banned profiles and never reveals contacts or exact private activity', async () => {
    const targets = [await fixture({ published: false }), await fixture({ banned: true }), await fixture()];
    for (const target of targets) await prisma.block.create({ data: { blockerUserId: caller.user.id, blockedUserId: target.user.id, createdAt: now } });
    const foreign = await fixture(); await prisma.block.create({ data: { blockerUserId: foreign.user.id, blockedUserId: caller.user.id } });
    const first = await app.inject({ url: '/api/blocks?limit=2', headers: caller.headers }); expect(first.statusCode).toBe(200);
    const page = blockListResponseSchema.parse(first.json()); expect(page.items).toHaveLength(2); expect(page.nextCursor).not.toBeNull();
    const next = await app.inject({ url: `/api/blocks?limit=2&cursor=${page.nextCursor}`, headers: caller.headers });
    const second = blockListResponseSchema.parse(next.json()); expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
    const all = [...page.items, ...second.items]; expect(new Set(all.map((item) => item.profileId))).toEqual(new Set(targets.map((target) => target.profile.id)));
    for (const item of all) expect(item.player?.activity).toBeUndefined(); noPrivate(all, [caller, ...targets, foreign]);
    expectCode(await app.inject({ url: `/api/blocks?cursor=${page.nextCursor}`, headers: foreign.headers }), 400, 'INVALID_CURSOR');
  });
  it('keeps an unblock handle for an unsafe legacy card and allows an unpublished caller to unblock an unpublished target', async () => {
    const target = await fixture({ published: false, unsafe: true });
    await prisma.block.create({ data: { blockerUserId: caller.user.id, blockedUserId: target.user.id } });
    await prisma.playerProfile.update({ where: { id: caller.profile.id }, data: { isPublished: false } });
    await prisma.steamAccount.delete({ where: { userId: caller.user.id } });
    const response = await app.inject({ url: '/api/blocks', headers: caller.headers }); expect(response.statusCode).toBe(200);
    expect(blockListResponseSchema.parse(response.json()).items[0]).toMatchObject({ profileId: target.profile.id, player: null });
    const removed = await app.inject({ method: 'DELETE', url: `/api/blocks/${target.profile.id}`, headers: caller.headers });
    expect(removed.statusCode).toBe(200); expect(removed.json()).toEqual({ blocked: false });
    expect(await prisma.block.count({ where: { blockerUserId: caller.user.id } })).toBe(0);
  });
  it('returns the same ownership-safe 404 for missing, malformed, self and foreign unblock IDs', async () => {
    const foreign = await fixture(); const failures = [];
    for (const profileId of [randomUUID(), 'invalid', caller.profile.id, foreign.profile.id]) {
      const response = await app.inject({ method: 'DELETE', url: `/api/blocks/${profileId}`, headers: caller.headers });
      expectCode(response, 404, 'BLOCK_NOT_FOUND'); failures.push(response.json().error.message);
    }
    expect(new Set(failures).size).toBe(1);
  });
  it('does not disclose a non-CS2 profile through the unblock endpoint', async () => {
    const target = await fixture();
    const game = await prisma.game.create({ data: { slug: `m7_other_${randomUUID()}`, name: 'Other fixture game' } });
    try {
      const profile = await prisma.playerProfile.create({ data: { userId: target.user.id, gameId: game.id, region: 'KZ' } });
      expectCode(await app.inject({ method: 'DELETE', url: `/api/blocks/${profile.id}`, headers: caller.headers }), 404, 'BLOCK_NOT_FOUND');
    } finally { await prisma.game.delete({ where: { id: game.id } }); }
  });
  it('permits a first feed-card block by an unpublished caller when the feed publication gate is disabled', async () => {
    const target = await fixture(); await prisma.playerProfile.update({ where: { id: caller.profile.id }, data: { isPublished: false } });
    const relaxed = await buildApp({ ...config, FEED_REQUIRES_PUBLISHED_PROFILE: false }, {
      prisma: new PrismaClient({ datasourceUrl: databaseUrl }), redis: false, now: () => now, fetch: fetcher });
    try {
      const response = await relaxed.inject({ method: 'POST', url: `/api/blocks/${target.profile.id}`, headers: caller.headers, payload: {} });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ blocked: true });
      expect(await prisma.block.count({ where: { blockerUserId: caller.user.id, blockedUserId: target.user.id } })).toBe(1);
    } finally { await relaxed.close(); }
  });
  it('rejects unknown report fields/query and invalid block paging', async () => {
    const target = await fixture();
    for (const payload of [{ profileId: target.profile.id, requestId: randomUUID(), reason: 'SPAM' }, { profileId: target.profile.id, reason: 'SPAM', admin: true }]) {
      expect((await app.inject({ method: 'POST', url: '/api/reports', headers: caller.headers, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/reports?unknown=true', headers: caller.headers,
      payload: { profileId: target.profile.id, reason: 'SPAM' } })).statusCode).toBe(400);
    for (const query of ['offset=1', 'limit=51', 'cursor=invalid']) expect((await app.inject({ url: `/api/blocks?${query}`, headers: caller.headers })).statusCode).toBe(400);
  });
  it('retains OPEN/accepted/pending and recent resolutions while deleting only old resolved data; audit survives', async () => {
    const target = await fixture(); const old = new Date(now.getTime() - 181 * day);
    const resolved = await prisma.report.create({ data: { reporterUserId: caller.user.id, reportedUserId: target.user.id,
      reason: 'OTHER', status: 'ACTIONED', createdAt: old, resolvedAt: old } });
    const open = await prisma.report.create({ data: { reporterUserId: caller.user.id, reportedUserId: target.user.id, reason: 'OTHER', createdAt: old } });
    const recent = await prisma.report.create({ data: { reporterUserId: caller.user.id, reportedUserId: target.user.id,
      reason: 'OTHER', status: 'REVIEWED', createdAt: old, resolvedAt: now } });
    const audit = await prisma.adminAuditLog.create({ data: { adminTelegramId: 12345678n, action: 'ACTION', reportId: resolved.id, targetUserId: target.user.id, reason: 'MODERATION_ACTION' } });
    auditIds.push(audit.id);
    const expired = await history(caller, target, 'EXPIRED', new Date(now.getTime() - 91 * day), new Date(now.getTime() - 91 * day));
    const canceled = await history(caller, target, 'CANCELED', new Date(now.getTime() - 91 * day), null);
    const declined = await history(caller, target, 'DECLINED', new Date(now.getTime() - 91 * day), new Date(now.getTime() - 91 * day));
    const accepted = await history(caller, target, 'ACCEPTED', old, old);
    const pending = await history(caller, target, 'PENDING', old, null);
    const newlyResolved = await history(caller, target, 'DECLINED', old, now);
    await prisma.report.update({ where: { id: open.id }, data: { requestId: expired.id } });
    expect(await retainModerationData(prisma, config, now)).toEqual({ reports: 1, requests: 3 });
    expect(await prisma.report.findUnique({ where: { id: resolved.id } })).toBeNull();
    expect((await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: audit.id } })).reportId).toBeNull();
    expect((await prisma.report.findUniqueOrThrow({ where: { id: open.id } })).requestId).toBeNull();
    expect(await prisma.report.findUnique({ where: { id: recent.id } })).not.toBeNull();
    for (const request of [expired, canceled, declined]) expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toBeNull();
    for (const request of [accepted, pending, newlyResolved]) expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).not.toBeNull();
  });
  it('bounds each resolved report retention batch to 500 rows', async () => {
    const target = await fixture(); const old = new Date(now.getTime() - 181 * day);
    await prisma.report.createMany({ data: Array.from({ length: 501 }, () => ({ reporterUserId: caller.user.id,
      reportedUserId: target.user.id, reason: 'OTHER' as const, status: 'DISMISSED' as const, createdAt: old, resolvedAt: old })) });
    expect(await retainModerationData(prisma, config, now)).toEqual({ reports: 500, requests: 0 });
    expect(await prisma.report.count({ where: { reporterUserId: caller.user.id } })).toBe(1);
  });
  it('serializes owned old-request reports against concurrent request retention without a foreign-key error', async () => {
    const service = new ReportService(prisma, config, dispatch, () => now);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const target = await fixture(); const old = new Date(now.getTime() - 91 * day);
      const request = await history(caller, target, 'DECLINED', old, old);
      const [reported, retained] = await Promise.allSettled([
        service.report(caller.user.id, { requestId: request.id, reason: 'HARASSMENT' }),
        retainModerationData(prisma, config, now),
      ]);
      expect(retained.status).toBe('fulfilled');
      if (reported.status === 'rejected') expect(reported.reason).toMatchObject({ code: 'REPORT_TARGET_NOT_FOUND', statusCode: 404 });
      // A shared report-FK lock can make this scan skip the old request. The next
      // invocation removes it and anonymizes only the request reference.
      await retainModerationData(prisma, config, now);
      expect(await prisma.teammateRequest.findUnique({ where: { id: request.id } })).toBeNull();
      if (reported.status === 'fulfilled') expect((await prisma.report.findUniqueOrThrow({ where: { id: reported.value.report.id } })).requestId).toBeNull();
    }
  });
  it('applies a dedicated per-user report quota even when two callers share one IP', async () => {
    const target = await fixture(); const second = await fixture();
    const testConfig = { ...config, REPORTS_RATE_LIMIT_PER_MINUTE: 1 };
    const isolated = await buildApp(testConfig, { prisma: new PrismaClient({ datasourceUrl: databaseUrl }), redis: false,
      now: () => now, fetch: fetcher, moderation: new ReportService(prisma, testConfig, dispatch, () => now) });
    try {
      const payload = { profileId: target.profile.id, reason: 'SPAM' };
      expect((await isolated.inject({ method: 'POST', url: '/api/reports', headers: caller.headers, payload })).statusCode).toBe(201);
      expect((await isolated.inject({ method: 'POST', url: '/api/reports', headers: caller.headers, payload })).statusCode).toBe(429);
      expect((await isolated.inject({ method: 'POST', url: '/api/reports', headers: second.headers, payload })).statusCode).toBe(201);
    } finally { await isolated.close(); }
  });
});
