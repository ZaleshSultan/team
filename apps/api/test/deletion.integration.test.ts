import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashSecret } from '../src/auth/secrets.js';
import { loadConfig } from '../src/config.js';

// Opt-in only; never use the running application's database or truncate tables.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.runIf(Boolean(databaseUrl))('account deletion PostgreSQL cascades', () => {
  it('revokes every session and deletes all owned data while preserving other users and catalog data', async () => {
    if (!new URL(databaseUrl!).pathname.slice(1).endsWith('_test')) throw new Error('TEST_DATABASE_URL must select a dedicated database whose name ends in _test');
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const now = new Date('2026-10-12T12:00:00.000Z');
    const suffix = randomUUID().replaceAll('-', '');
    const userIds = [randomUUID(), randomUUID(), randomUUID()];
    const [ownerId, peerId, thirdId] = userIds as [string, string, string];
    const gameId = randomUUID();
    const token = 'C'.repeat(43);
    const secondToken = 'D'.repeat(43);
    const telegramBase = 8_300_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000));
    const steamId64 = 76_561_198_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000));
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl!, REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot', MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' });
    const app = await buildApp(config, { prisma, redis: false, now: () => now });
    try {
      await prisma.user.createMany({ data: userIds.map((id, index) => ({ id, telegramId: telegramBase + BigInt(index), username: `delete_${suffix.slice(0, 20)}` })) });
      await prisma.game.create({ data: { id: gameId, slug: `delete_${suffix}`, name: 'Deletion fixture catalog' } });
      await prisma.privacySettings.create({ data: { userId: ownerId } });
      await prisma.statsSync.create({ data: { userId: ownerId } });
      await prisma.session.createMany({ data: [token, secondToken].map((value) => ({ userId: ownerId, tokenHash: hashSecret(value), expiresAt: new Date(now.getTime() + 60_000) })) });
      await prisma.steamAccount.create({ data: { userId: ownerId, steamId64 } });
      await prisma.faceitAccount.create({ data: { userId: ownerId, steamId64, playerId: `delete_${suffix}`, nickname: 'Deletion fixture' } });
      await prisma.userGame.create({ data: { userId: ownerId, steamAppId: 730, gameId, playtimeTotal: 120, playtime2weeks: 60, syncedAt: now } });
      await prisma.playerProfile.create({ data: { userId: ownerId, gameId, region: 'fixture' } });
      const link = await prisma.steamLink.create({ data: { userId: ownerId, startCodeHash: hashSecret(suffix), expiresAt: new Date(now.getTime() + 60_000) } });
      const nonce = `deletion_${suffix}`;
      await prisma.steamOpenIdNonce.create({ data: { nonce, steamLinkId: link.id, expiresAt: new Date(now.getTime() + 60_000) } });
      await prisma.teammateRequest.createMany({ data: [
        { fromUserId: ownerId, toUserId: peerId, gameId, status: 'ACCEPTED' },
        { fromUserId: peerId, toUserId: ownerId, gameId, status: 'DECLINED' },
      ] });
      await prisma.block.createMany({ data: [{ blockerUserId: ownerId, blockedUserId: peerId }, { blockerUserId: peerId, blockedUserId: ownerId }] });
      await prisma.report.createMany({ data: [
        { reporterUserId: ownerId, reportedUserId: peerId, reason: 'OTHER' },
        { reporterUserId: peerId, reportedUserId: ownerId, reason: 'OTHER', details: 'private evidence @deletion_fixture' },
      ] });
      const reviewed = await prisma.report.create({ data: { reporterUserId: peerId, reportedUserId: thirdId, resolvedBy: ownerId, reason: 'OTHER', status: 'REVIEWED' } });
      const audit = await prisma.adminAuditLog.create({ data: { adminTelegramId: telegramBase, action: 'USER_READ', targetUserId: ownerId, reportId: reviewed.id } });

      const response = await app.inject({ method: 'DELETE', url: '/api/me', headers: { authorization: `Bearer ${token}` }, payload: { confirmation: 'DELETE' } });
      expect(response.statusCode).toBe(204);
      for (const value of [token, secondToken]) expect((await app.inject({ url: '/api/me', headers: { authorization: `Bearer ${value}` } })).statusCode).toBe(401);
      expect(await prisma.user.findUnique({ where: { id: ownerId } })).toBeNull();
      const ownedCounts = await Promise.all([
        prisma.session.count({ where: { userId: ownerId } }), prisma.privacySettings.count({ where: { userId: ownerId } }),
        prisma.statsSync.count({ where: { userId: ownerId } }),
        prisma.steamAccount.count({ where: { userId: ownerId } }), prisma.faceitAccount.count({ where: { userId: ownerId } }),
        prisma.userGame.count({ where: { userId: ownerId } }), prisma.playerProfile.count({ where: { userId: ownerId } }),
        prisma.steamLink.count({ where: { userId: ownerId } }), prisma.steamOpenIdNonce.count({ where: { nonce } }),
        prisma.teammateRequest.count({ where: { OR: [{ fromUserId: ownerId }, { toUserId: ownerId }] } }),
        prisma.block.count({ where: { OR: [{ blockerUserId: ownerId }, { blockedUserId: ownerId }] } }),
        prisma.report.count({ where: { OR: [{ reporterUserId: ownerId }, { reportedUserId: ownerId }] } }),
      ]);
      expect(ownedCounts).toEqual(Array(12).fill(0));
      expect(await prisma.user.count({ where: { id: { in: [peerId, thirdId] } } })).toBe(2);
      expect(await prisma.game.count({ where: { id: gameId } })).toBe(1);
      expect((await prisma.report.findUniqueOrThrow({ where: { id: reviewed.id } })).resolvedBy).toBeNull();
      const anonymized = await prisma.report.findFirstOrThrow({ where: { reporterUserId: peerId, reportedUserId: null } });
      expect(anonymized).toMatchObject({ details: null, status: 'REVIEWED', resolvedBy: null, resolvedAt: now, resolutionNote: 'ACCOUNT_DELETED' });
      expect((await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: audit.id } })).targetUserId).toBeNull();
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.game.deleteMany({ where: { id: gameId } });
      await app.close();
    }
  });
});
