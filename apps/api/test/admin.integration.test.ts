import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from '../../bot/src/admin.js';
import { loadConfig as loadBotConfig } from '../../bot/src/config.js';
import { buildApp } from '../src/app.js';
import { createSecret, hashSecret } from '../src/auth/secrets.js';
import { loadConfig } from '../src/config.js';
import { RequestService } from '../src/requests/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminTelegramId = '8951099000001'; const secondAdmin = '8951099000002';
const now = new Date('2026-10-14T12:00:00.000Z');
describe.runIf(Boolean(databaseUrl))('M7 isolated PostgreSQL bot administration', () => {
  let prisma: PrismaClient; let app: FastifyInstance; let gameId: string; let otherGameId: string; let serial = 0;
  let service: AdminService; let requests: RequestService; let target: Awaited<ReturnType<typeof fixture>>; let viewer: Awaited<ReturnType<typeof fixture>>;
  const ids: string[] = []; const fetcher = vi.fn().mockRejectedValue(new Error('External providers forbidden'));
  const contacts = { getUsername: vi.fn(async () => 'Fresh_validated_contact') }; const dispatch = vi.fn(async () => undefined);
  const values = { NODE_ENV: 'test', DATABASE_URL: databaseUrl ?? 'postgresql://test@localhost/squad_test', REDIS_URL: 'redis://localhost:6379',
    BOT_TOKEN: '123456:TEST_TOKEN_NEVER_A_REAL_BOT_12345', BOT_USERNAME: 'squad_test_bot', MINIAPP_URL: 'https://app.example',
    PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example', ADMIN_TELEGRAM_IDS: `${adminTelegramId},${secondAdmin}`,
    FEED_RATE_LIMIT_PER_MINUTE: '600', REQUESTS_RATE_LIMIT_PER_MINUTE: '600' };
  const config = loadConfig(values); const botConfig = loadBotConfig(values);
  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.slice(1).endsWith('_test') || !['127.0.0.1', 'localhost'].includes(new URL(databaseUrl).hostname)) throw new Error('Dedicated loopback *_test database required');
    prisma = new PrismaClient({ datasourceUrl: databaseUrl, log: [] }); gameId = (await prisma.game.findUniqueOrThrow({ where: { slug: 'cs2' } })).id;
    otherGameId = (await prisma.game.create({ data: { slug: `m7_admin_${randomUUID()}`, name: 'Admin test game' } })).id;
    requests = new RequestService(prisma, config, contacts, dispatch, () => now);
    service = new AdminService(prisma, botConfig, contacts, dispatch, () => now);
    app = await buildApp(config, { prisma, redis: false, now: () => now, fetch: fetcher, requests });
  });
  async function cleanup() {
    await prisma.adminAuditLog.deleteMany({ where: { adminTelegramId: { in: [BigInt(adminTelegramId), BigInt(secondAdmin)] } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } }); ids.length = 0;
  }
  beforeEach(async () => { await cleanup(); target = await fixture(); viewer = await fixture(); dispatch.mockClear(); });
  afterAll(async () => {
    if (prisma) { await cleanup(); await prisma.game.deleteMany({ where: { id: otherGameId } }); }
    if (app) await app.close(); else await prisma?.$disconnect(); expect(fetcher).not.toHaveBeenCalled();
  });
  async function fixture(telegramId?: bigint) {
    const token = createSecret(); const next = ++serial;
    const user = await prisma.user.create({ data: { telegramId: telegramId ?? 8_951_000_000_000n + BigInt(next), username: `private_admin_fixture_${next}`,
      ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM, rulesAcceptedAt: now, rulesVersion: config.RULES_VERSION,
      steamAccount: { create: { steamId64: 76_561_198_790_000_000n + BigInt(next), personaName: 'Fixture player', vacBans: 0, gameBans: 0, communityBanned: false, economyBan: 'none' } },
      playerProfiles: { create: { gameId, nickname: 'Fixture player', roles: ['awp'], languages: ['ru'], lookingFor: ['duo'], playTimes: ['evening'], region: 'KZ', hasMic: true, bio: 'Team player', isPublished: true } },
      sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(now.getTime() + 86_400_000) } } }, include: { playerProfiles: true } });
    ids.push(user.id); return { user, profileId: user.playerProfiles[0]!.id, headers: { authorization: `Bearer ${token}` } };
  }
  async function prepare(action: 'ban' | 'unban', admin = adminTelegramId) {
    const reply = await service.execute(admin, action, `${target.user.id}${action === 'ban' ? ' repeated spam' : ''}`);
    return reply.buttons![0]![0]!.callback_data;
  }
  async function ban() { await service.callback(adminTelegramId, await prepare('ban')); }
  async function pending(from: string, to: string, game = gameId) {
    return prisma.teammateRequest.create({ data: { fromUserId: from, toUserId: to, gameId: game, expiresAt: new Date(now.getTime() + 86_400_000) } });
  }
  it('ban is confirmed once, removes feed visibility and sessions, cancels both directions across games', async () => {
    const third = await fixture();
    const before = await app.inject({ url: '/api/feed/cs2', headers: viewer.headers }); expect(before.json().items.some((item: { id: string }) => item.id === target.profileId)).toBe(true);
    const requests = [await pending(target.user.id, viewer.user.id), await pending(third.user.id, target.user.id, otherGameId)];
    const accepted = await prisma.teammateRequest.create({ data: { fromUserId: target.user.id, toUserId: third.user.id, gameId, status: 'ACCEPTED', resolvedAt: now, expiresAt: now } });
    const callback = await prepare('ban'); expect((await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).isBanned).toBe(false);
    await service.callback(adminTelegramId, callback);
    expect(await prisma.session.count({ where: { userId: target.user.id } })).toBe(0);
    expect((await prisma.teammateRequest.findMany({ where: { id: { in: requests.map((r) => r.id) } } })).every((r) => r.status === 'CANCELED' && r.resolvedAt?.getTime() === now.getTime())).toBe(true);
    expect((await prisma.teammateRequest.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe('ACCEPTED');
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profileId } }))).toMatchObject({ isPublished: false, moderationHidden: true, moderationWasPublished: true });
    const after = await app.inject({ url: '/api/feed/cs2', headers: viewer.headers }); expect(after.json().items.some((item: { id: string }) => item.id === target.profileId)).toBe(false);
    expect((await app.inject({ url: '/api/me', headers: target.headers })).statusCode).toBe(401);
    await expect(service.callback(adminTelegramId, callback)).rejects.toMatchObject({ code: 'confirmationExpired' });
    expect(await prisma.moderationNotification.count({ where: { recipientUserId: target.user.id, kind: 'BAN_NOTICE' } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { adminTelegramId: BigInt(adminTelegramId), action: 'BAN', targetUserId: target.user.id } })).toBe(1);
  });
  it('another configured admin cannot use a confirmation token; the exact expiry boundary is rejected', async () => {
    const callback = await prepare('ban'); await expect(service.callback(secondAdmin, callback)).rejects.toMatchObject({ code: 'confirmationExpired' });
    await prisma.adminActionConfirmation.updateMany({ where: { targetUserId: target.user.id }, data: { expiresAt: now } });
    await expect(service.callback(adminTelegramId, callback)).rejects.toMatchObject({ code: 'confirmationExpired' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).isBanned).toBe(false);
  });
  it('concurrent confirmation double-click commits one ban and one durable notice', async () => {
    const callback = await prepare('ban'); const outcomes = await Promise.allSettled([service.callback(adminTelegramId, callback), service.callback(adminTelegramId, callback)]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect(await prisma.moderationNotification.count({ where: { recipientUserId: target.user.id } })).toBe(1);
  });
  it('unban restores access only; explicit validated unhide restores the saved publication state', async () => {
    await ban(); await service.callback(adminTelegramId, await prepare('unban'));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).isBanned).toBe(false);
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profileId } }))).toMatchObject({ isPublished: false, moderationHidden: true });
    await service.execute(adminTelegramId, 'unhide', target.user.id);
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profileId } }))).toMatchObject({ isPublished: true, moderationHidden: false, moderationWasPublished: false });
  });
  it('unban also hides a legacy banned user whose profile was incorrectly still published', async () => {
    await prisma.user.update({ where: { id: target.user.id }, data: { isBanned: true } });
    await service.callback(adminTelegramId, await prepare('unban'));
    expect(await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profileId } })).toMatchObject({ isPublished: false, moderationHidden: true, moderationWasPublished: true });
  });
  it('hidden users cannot self-publish; unhide fails if consent/profile is no longer valid', async () => {
    await service.execute(adminTelegramId, 'hide', target.user.id);
    const selfPublish = await app.inject({ method: 'PUT', url: '/api/me/profile/cs2/publish', headers: target.headers, payload: { published: true } });
    expect(selfPublish.statusCode).toBe(409);
    await prisma.user.update({ where: { id: target.user.id }, data: { rulesVersion: 'outdated' } });
    await expect(service.execute(adminTelegramId, 'unhide', target.user.id)).rejects.toMatchObject({ code: 'cannotRestore' });
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: target.profileId } })).isPublished).toBe(false);
  });
  it('resolution uses null reviewer without Squad registration and registered admin id when available', async () => {
    const report = await prisma.report.create({ data: { reporterUserId: viewer.user.id, reportedUserId: target.user.id, reason: 'SPAM' } });
    await service.execute(adminTelegramId, 'dismiss', `${report.id} private @evidence`);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).toMatchObject({ status: 'DISMISSED', resolvedBy: null, resolutionNote: 'private @evidence' });
    const registered = await fixture(BigInt(adminTelegramId)); await service.execute(adminTelegramId, 'action', report.id);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).toMatchObject({ status: 'ACTIONED', resolvedBy: registered.user.id });
    const audit = await prisma.adminAuditLog.findMany({ where: { reportId: report.id } }); expect(audit).toHaveLength(2); expect(audit.every((row) => row.reason === 'REPORT_RESOLVED')).toBe(true);
  });
  it('target deletion anonymizes reports and preserves admin audit rows with null target', async () => {
    const report = await prisma.report.create({ data: { reporterUserId: viewer.user.id, reportedUserId: target.user.id, reason: 'HARASSMENT', details: '@private_evidence' } });
    await service.execute(adminTelegramId, 'user', target.user.id);
    const response = await app.inject({ method: 'DELETE', url: '/api/me', headers: target.headers, payload: { confirmation: 'DELETE' } });
    expect(response.statusCode).toBe(204);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).toMatchObject({ reportedUserId: null, details: null, status: 'REVIEWED' });
    const audit = await prisma.adminAuditLog.findMany({ where: { adminTelegramId: BigInt(adminTelegramId), action: 'USER_READ' } });
    expect(audit).toHaveLength(1); expect(audit[0]!.targetUserId).toBeNull();
  });
  it('a concurrent ban/send leaves no pending request involving the banned account', async () => {
    const callback = await prepare('ban'); const results = await Promise.allSettled([service.callback(adminTelegramId, callback), requests.send(viewer.user.id, { toProfileId: target.profileId })]);
    expect(results[0]!.status).toBe('fulfilled');
    expect(await prisma.teammateRequest.count({ where: { status: 'PENDING', OR: [{ fromUserId: target.user.id }, { toUserId: target.user.id }] } })).toBe(0);
  });
  it('a concurrent ban/accept commits no accepted contact after ban wins and leaves no pending state', async () => {
    const invitation = await requests.send(viewer.user.id, { toProfileId: target.profileId }); const callback = await prepare('ban');
    const results = await Promise.allSettled([service.callback(adminTelegramId, callback), requests.resolve(target.user.id, invitation.request.id, 'accept')]);
    expect(results[0]!.status).toBe('fulfilled');
    const request = await prisma.teammateRequest.findUniqueOrThrow({ where: { id: invitation.request.id } }); expect(['CANCELED', 'ACCEPTED']).toContain(request.status);
    if (request.status === 'CANCELED') expect(results[1]!.status).toBe('rejected');
    await expect(requests.detail(viewer.user.id, invitation.request.id)).resolves.toMatchObject({ request: { status: request.status } });
  });
});
