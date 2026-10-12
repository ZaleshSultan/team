import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { StatsService } from '../src/stats/service.js';
import { ProviderError } from '../src/stats/providers/http.js';
import { scanStaleAccounts } from '../src/stats/queue.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.runIf(Boolean(databaseUrl))('M3 PostgreSQL cache and concurrency', () => {
  let prisma: PrismaClient;
  const ownedUserIds: string[] = [];
  const now = new Date('2026-10-12T12:00:00.000Z');
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl ?? 'postgresql://unused@localhost/squad_test',
    REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
    MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' });
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.slice(1).endsWith('_test')) throw new Error('Only a dedicated *_test database is permitted');
    prisma = new PrismaClient({ datasourceUrl: databaseUrl }); await prisma.$connect();
  });
  afterAll(async () => { await prisma.user.deleteMany({ where: { id: { in: ownedUserIds } } }); await prisma.$disconnect(); });
  async function fixture() {
    const suffix = randomUUID();
    const steamId64 = 76561198000000000n + BigInt(Math.floor(Math.random() * 1_000_000_000));
    const user = await prisma.user.create({ data: { telegramId: 8_700_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000)),
      username: 'stats_fixture', steamAccount: { create: { steamId64 } } } });
    ownedUserIds.push(user.id);
    const steam = { steamId64: steamId64.toString(), personaName: 'Fixture', avatarUrl: null, profileUrl: null, visibility: 3,
      timeCreated: new Date('2009-01-01T00:00:00Z'), gameDetailsPublic: true, games: [
        { steamAppId: 730, name: 'Counter-Strike 2', playtimeTotal: 123456, playtime2weeks: 780 },
        { steamAppId: 570, name: 'Dota 2', playtimeTotal: 900, playtime2weeks: 120 },
        { steamAppId: 440, name: 'Team Fortress 2', playtimeTotal: 360, playtime2weeks: 0 },
      ], vacBans: 1, gameBans: 0, daysSinceLastBan: 500, communityBanned: false, economyBan: 'none' };
    const faceit = { playerId: suffix, nickname: 'Fixture', steamId64: steamId64.toString(), profileUrl: null,
      level: 8, elo: 1800, kd: 1.2, winRate: 55, favoriteMaps: ['de_mirage'] };
    const providers = { steam: { configured: true, sync: vi.fn().mockResolvedValue(steam) }, faceit: { configured: true,
      findBySteamId: vi.fn().mockResolvedValue(faceit), findByNickname: vi.fn().mockResolvedValue(faceit),
      findByPlayerId: vi.fn().mockResolvedValue(faceit), sync: vi.fn().mockResolvedValue(faceit) } };
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const service = new StatsService(prisma, config, providers, queue, () => now, () => 0);
    return { user, steamId64, steam, faceit, providers, queue, service };
  }
  it('stores all games in minutes, maps catalog IDs and updates cached data idempotently', async () => {
    const h = await fixture(); await h.service.refreshUser(h.user.id);
    const games = await prisma.userGame.findMany({ where: { userId: h.user.id }, orderBy: { steamAppId: 'asc' } });
    expect(games.map((game) => game.steamAppId)).toEqual([440, 570, 730]);
    expect(games.find((game) => game.steamAppId === 730)).toMatchObject({ playtimeTotal: 123456, playtime2weeks: 780, gameId: expect.any(String) });
    expect(games.find((game) => game.steamAppId === 570)?.gameId).toBeNull();
    h.providers.steam.sync.mockResolvedValue({ ...h.steam, games: [{ steamAppId: 730, name: 'CS2 updated', playtimeTotal: 123999, playtime2weeks: 600 }] });
    await h.service.refreshUser(h.user.id);
    expect(await prisma.userGame.count({ where: { userId: h.user.id } })).toBe(1);
    expect((await h.service.get(h.user.id)).steam?.cs2).toEqual({ playtimeTotal: 123999, playtime2weeks: 600 });
    expect(await prisma.faceitAccount.findUnique({ where: { userId: h.user.id } })).toMatchObject({ steamId64: h.steamId64, level: 8, elo: 1800, kd: 1.2, winRate: 55 });
  });
  it('private details clear a previous public library and preserve ban summary', async () => {
    const h = await fixture(); await h.service.refreshUser(h.user.id);
    h.providers.steam.sync.mockResolvedValue({ ...h.steam, visibility: 1, gameDetailsPublic: false, games: [] });
    await h.service.refreshUser(h.user.id);
    expect(await prisma.userGame.count({ where: { userId: h.user.id } })).toBe(0);
    const stats = await h.service.get(h.user.id);
    expect(stats.guidance).toContain('STEAM_PROFILE_PRIVATE'); expect(stats.steam?.bans.vacBans).toBe(1);
  });
  it('auto FACEIT uniqueness conflict uses a savepoint so successful Steam cache still commits', async () => {
    const owner = await fixture(); await owner.service.refreshUser(owner.user.id);
    const other = await fixture(); other.providers.faceit.sync.mockResolvedValue({ ...other.faceit, playerId: owner.faceit.playerId });
    await other.service.refreshUser(other.user.id);
    expect(await prisma.userGame.count({ where: { userId: other.user.id } })).toBe(3);
    expect(await prisma.steamAccount.findUnique({ where: { userId: other.user.id } })).toMatchObject({ personaName: 'Fixture', syncedAt: now });
    expect(await prisma.faceitAccount.findUnique({ where: { userId: other.user.id } })).toBeNull();
    expect((await other.service.get(other.user.id)).sync.lastErrorCode).toBe('FACEIT_INVALID_RESPONSE');
  });
  it('manual FACEIT mismatch leaves the existing association and cache intact', async () => {
    const h = await fixture(); await h.service.refreshUser(h.user.id);
    h.providers.faceit.findByNickname.mockRejectedValue(new ProviderError('faceit', 'STEAM_ID_MISMATCH'));
    await expect(h.service.linkFaceit(h.user.id, 'Other')).rejects.toMatchObject({ code: 'FACEIT_STEAM_MISMATCH' });
    expect((await prisma.faceitAccount.findUnique({ where: { userId: h.user.id } }))?.playerId).toBe(h.faceit.playerId);
  });
  it('concurrent manual refresh requests reserve exactly one cooldown and queue job', async () => {
    const h = await fixture(); const results = await Promise.allSettled([h.service.manualRefresh(h.user.id), h.service.manualRefresh(h.user.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.queue.enqueue).toHaveBeenCalledTimes(1);
    expect((await prisma.statsSync.findUnique({ where: { userId: h.user.id } }))?.manualAvailableAt).toEqual(new Date(now.getTime() + 300_000));
  });
  it('in-flight sync cannot recreate a deleted user or any cascaded cache rows', async () => {
    const h = await fixture(); let resume!: () => void; let started!: () => void;
    const wait = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    h.providers.steam.sync.mockImplementation(async () => { started(); await wait; return h.steam; });
    const sync = h.service.refreshUser(h.user.id); await entered;
    await prisma.user.delete({ where: { id: h.user.id } }); resume(); await sync;
    expect(await prisma.statsSync.count({ where: { userId: h.user.id } })).toBe(0);
    expect(await prisma.userGame.count({ where: { userId: h.user.id } })).toBe(0);
  });
  it('database stale selection excludes future refreshes, active leases and bans', async () => {
    const stale = await fixture(); const future = await fixture(); const locked = await fixture(); const banned = await fixture();
    await prisma.statsSync.create({ data: { userId: future.user.id, nextRefreshAt: new Date(now.getTime() + 60_000) } });
    await prisma.statsSync.create({ data: { userId: locked.user.id, nextRefreshAt: now, lockedUntil: new Date(now.getTime() + 60_000) } });
    await prisma.user.update({ where: { id: banned.user.id }, data: { isBanned: true } });
    const enqueue = vi.fn().mockResolvedValue(undefined); await scanStaleAccounts(prisma, enqueue, now, () => 0);
    const ids = enqueue.mock.calls.map(([id]) => id);
    expect(ids).toContain(stale.user.id); expect(ids).not.toContain(future.user.id); expect(ids).not.toContain(locked.user.id); expect(ids).not.toContain(banned.user.id);
  });
});
