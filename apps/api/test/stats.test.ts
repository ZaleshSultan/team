import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { loadConfig } from '../src/config.js';
import { serializeOwnStats, serializeSync, type StatsUser } from '../src/stats/serializer.js';
import { isStale, nextRefreshAt, retryDelay, staleAccountsWhere, SyncRetryError } from '../src/stats/policy.js';
import { createProviderGate, scanStaleAccounts } from '../src/stats/queue.js';
import { StatsService, type StatsProviders } from '../src/stats/service.js';
import { ProviderError } from '../src/stats/providers/http.js';
import { buildApp } from '../src/app.js';

const now = new Date('2026-10-12T12:00:00.000Z');
const userId = '9a131420-1868-428b-82ef-3167c48c8108';
const sqlText = (sql: any): string => sql.sql ?? sql.join('');
const steamId64 = 76561198000000000n;
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379', BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', BOT_USERNAME: 'squad_test_bot',
  MINIAPP_URL: 'https://app.example', PUBLIC_API_URL: 'https://app.example', MINIAPP_ORIGIN: 'https://app.example' });
function harness() {
  let state: any = { userId, status: 'IDLE', nextRefreshAt: now, lockedUntil: null, lockToken: null, manualAvailableAt: null,
    lastAttemptAt: null, lastSuccessAt: null, lastErrorCode: null };
  const account = { userId, steamId64, syncedAt: null };
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: userId, is_banned: false }]),
    $executeRaw: vi.fn().mockResolvedValue(3),
    steamAccount: { findUnique: vi.fn().mockResolvedValue(account), update: vi.fn().mockResolvedValue({}) },
    userGame: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    game: { findMany: vi.fn().mockResolvedValue([{ id: randomUUID(), steamAppId: 730 }]) },
    faceitAccount: { upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    statsSync: { findUnique: vi.fn(async () => state), update: vi.fn(async ({ data }) => { state = { ...state, ...data }; return state; }) } };
  const prisma = { $disconnect: vi.fn(), $transaction: vi.fn(async (fn) => fn(tx)),
    user: { findUnique: vi.fn().mockResolvedValue({ id: userId, isBanned: false, steamAccount: account, faceitAccount: null }) },
    steamAccount: { findUnique: vi.fn().mockResolvedValue(account), findMany: vi.fn() },
    statsSync: { upsert: vi.fn(async () => state), findUnique: vi.fn(async () => state),
      updateMany: vi.fn(async ({ data }) => { state = { ...state, ...data }; return { count: 1 }; }) } };
  const steam = { steamId64: steamId64.toString(), personaName: 'Fixture', avatarUrl: null, profileUrl: null,
    visibility: 3, timeCreated: null, gameDetailsPublic: true,
    games: [{ steamAppId: 730, name: 'CS2', playtimeTotal: 120, playtime2weeks: 60 },
      { steamAppId: 570, name: 'Dota 2', playtimeTotal: 240, playtime2weeks: 30 }],
    vacBans: 0, gameBans: 0, daysSinceLastBan: 0, communityBanned: false, economyBan: 'none' };
  const faceit = { playerId: randomUUID(), nickname: 'Fixture', steamId64: steamId64.toString(), profileUrl: null,
    level: 8, elo: 1800, kd: 1.2, winRate: 55, favoriteMaps: ['de_mirage'] };
  const providers: StatsProviders = { steam: { configured: true, sync: vi.fn().mockResolvedValue(steam) },
    faceit: { configured: true, findBySteamId: vi.fn().mockResolvedValue(faceit), findByNickname: vi.fn().mockResolvedValue(faceit),
      findByPlayerId: vi.fn().mockResolvedValue(faceit), sync: vi.fn().mockResolvedValue(faceit) }, onRateLimit: vi.fn() };
  const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const service = new StatsService(prisma as unknown as PrismaClient, config, providers, queue, () => now, () => 0);
  return { service, prisma, tx, providers, queue, steam, faceit, account, state: () => state };
}

describe('stats scheduling policy', () => {
  it('selects unsynced/due accounts, excludes live leases, future deadlines, and bans', () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale({ nextRefreshAt: now, lockedUntil: null }, now)).toBe(true);
    expect(isStale({ nextRefreshAt: now, lockedUntil: new Date(now.getTime() + 1) }, now)).toBe(false);
    expect(isStale({ nextRefreshAt: new Date(now.getTime() + 1), lockedUntil: null }, now)).toBe(false);
    expect(isStale({ nextRefreshAt: now, lockedUntil: now }, now)).toBe(true);
    expect(staleAccountsWhere(now)).toMatchObject({ user: { isBanned: false, OR: expect.any(Array) } });
  });
  it('keeps refresh jitter positive and backoff exponential; Retry-After is a floor', () => {
    expect(nextRefreshAt(now, 6, () => 0).getTime() - now.getTime()).toBe(6 * 3_600_000);
    expect(nextRefreshAt(now, 6, () => 0.5).getTime() - now.getTime()).toBe(6 * 3_600_000 + 150_000);
    expect([1, 2, 3].map((attempt) => retryDelay(attempt, 0, () => 0))).toEqual([30_000, 60_000, 120_000]);
    expect(retryDelay(1, 120_000, () => 0)).toBe(120_000);
    expect(retryDelay(30, 0, () => 0)).toBe(900_000);
  });
  it('spaces provider requests, defers globally on429 and never calls sleep for a blocked request', async () => {
    const redis = { eval: vi.fn().mockResolvedValueOnce(125).mockResolvedValueOnce(0).mockResolvedValueOnce(-60_000).mockResolvedValue(1) };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const gate = createProviderGate(redis as any, 'steam', 1000, sleep);
    await gate.beforeRequest(); expect(sleep).toHaveBeenCalledWith(125);
    await expect(gate.beforeRequest()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 60_000, retryable: true });
    expect(sleep).toHaveBeenCalledTimes(1);
    await gate.blockFor(60_000);
    expect(redis.eval.mock.calls[3]?.slice(1)).toEqual([1, 'squad:stats:provider:steam:blocked', 60_000]);
  });
  it('re-checks a new provider cooldown after sleeping for a reserved slot', async () => {
    const redis = { eval: vi.fn().mockResolvedValueOnce(1000).mockResolvedValueOnce(90_000) };
    const gate = createProviderGate(redis as any, 'faceit', 1000, async () => {});
    await expect(gate.beforeRequest()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 90_000 });
  });
  it('one queue failure does not block the next stale user', async () => {
    const h = harness();
    h.prisma.steamAccount.findMany.mockResolvedValue([{ userId: 'first' }, { userId: 'second' }]);
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('fixture')).mockResolvedValue(undefined);
    await scanStaleAccounts(h.prisma as any, enqueue, now, () => 0.5);
    expect(enqueue.mock.calls).toEqual([['first', 30_000], ['second', 30_000]]);
    expect(h.prisma.steamAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });
});

describe('stats sync service', () => {
  it('upserts all game minutes in bulk and maps catalog IDs', async () => {
    const h = harness(); await h.service.refreshUser(userId);
    const sql = h.tx.$executeRaw.mock.calls[0]?.[0];
    expect(sql.sql).toContain('ON CONFLICT (user_id, steam_app_id)');
    expect(sql.values).toEqual(expect.arrayContaining([730, 570, 120, 60, 240, 30, 'Dota 2']));
    expect(h.tx.steamAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ syncedAt: now, gameDetailsPublic: true }) }));
    expect(h.state()).toMatchObject({ status: 'IDLE', lockToken: null, lastSuccessAt: now });
  });
  it.each([false, true])('clears all cached games for hidden or empty libraries (public=%s)', async (gameDetailsPublic) => {
    const h = harness(); vi.mocked(h.providers.steam.sync).mockResolvedValue({ ...h.steam, gameDetailsPublic, games: [] });
    await h.service.refreshUser(userId);
    expect(h.tx.userGame.deleteMany).toHaveBeenCalledWith({ where: { userId } });
    expect(h.tx.$executeRaw.mock.calls.some(([sql]) => sqlText(sql).includes('INSERT INTO user_games'))).toBe(false);
  });
  it('preserves successful Steam data if FACEIT fails and retries using429 Retry-After', async () => {
    const h = harness(); vi.mocked(h.providers.faceit.findBySteamId).mockRejectedValue(new ProviderError('faceit', 'RATE_LIMITED', true, 120_000, 429));
    await expect(h.service.refreshUser(userId)).rejects.toMatchObject({ retryAfterMs: 120_000 });
    expect(h.tx.steamAccount.update).toHaveBeenCalled();
    expect(h.tx.faceitAccount.upsert).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ status: 'FAILED', lastErrorCode: 'FACEIT_RATE_LIMITED', lockToken: null });
    expect(h.providers.onRateLimit).toHaveBeenCalledWith(expect.objectContaining({ retryAfterMs: 120_000 }));
  });
  it('preserves old Steam cache on provider failure while saving FACEIT success', async () => {
    const h = harness(); vi.mocked(h.providers.steam.sync).mockRejectedValue(new ProviderError('steam', 'UNAVAILABLE', true));
    await expect(h.service.refreshUser(userId)).rejects.toBeInstanceOf(SyncRetryError);
    expect(h.tx.steamAccount.update).not.toHaveBeenCalled(); expect(h.tx.userGame.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.faceitAccount.upsert).toHaveBeenCalled();
  });
  it('persists Steam success even if publishing a FACEIT cooldown to Redis fails', async () => {
    const h = harness(); vi.mocked(h.providers.faceit.findBySteamId).mockRejectedValue(new ProviderError('faceit', 'RATE_LIMITED', true, 60_000));
    vi.mocked(h.providers.onRateLimit!).mockRejectedValue(new Error('fixture Redis outage'));
    await expect(h.service.refreshUser(userId)).rejects.toBeInstanceOf(SyncRetryError);
    expect(h.tx.steamAccount.update).toHaveBeenCalled(); expect(h.state().lockedUntil).toBeNull();
  });
  it('isolates a FACEIT write conflict with a savepoint while committing Steam', async () => {
    const h = harness(); h.tx.faceitAccount.upsert.mockRejectedValue(new Error('fixture conflict'));
    await h.service.refreshUser(userId);
    expect(h.tx.steamAccount.update).toHaveBeenCalled();
    expect(h.tx.$executeRaw.mock.calls.map(([sql]) => sqlText(sql))).toContain('ROLLBACK TO SAVEPOINT faceit_cache');
    expect(h.state().lastErrorCode).toBe('FACEIT_INVALID_RESPONSE');
  });
  it('invalidates a stored FACEIT ownership mismatch but manual mismatch keeps old data', async () => {
    const h = harness(); h.prisma.user.findUnique.mockResolvedValue({ id: userId, isBanned: false, steamAccount: h.account, faceitAccount: h.faceit });
    vi.mocked(h.providers.faceit.findByPlayerId).mockRejectedValue(new ProviderError('faceit', 'STEAM_ID_MISMATCH'));
    await h.service.refreshUser(userId);
    expect(h.tx.faceitAccount.deleteMany).toHaveBeenCalledWith({ where: { userId } });
  });
  it('skips absent keys, deleted/banned users and occupied leases', async () => {
    const h = harness(); h.providers.steam.configured = false; h.providers.faceit.configured = false;
    await h.service.refreshUser(userId); expect(h.providers.steam.sync).not.toHaveBeenCalled(); expect(h.providers.faceit.findBySteamId).not.toHaveBeenCalled();
    h.prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ isBanned: true, steamAccount: h.account });
    await h.service.refreshUser(userId); await h.service.refreshUser(userId);
    expect(h.prisma.statsSync.upsert).toHaveBeenCalledTimes(1);
    h.prisma.statsSync.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(h.service.refreshUser(userId)).rejects.toBeInstanceOf(SyncRetryError);
  });
  it('does not resurrect an account deleted while provider requests were in flight', async () => {
    const h = harness(); h.tx.$queryRaw.mockResolvedValue([]);
    await h.service.refreshUser(userId);
    expect(h.tx.steamAccount.update).not.toHaveBeenCalled(); expect(h.tx.faceitAccount.upsert).not.toHaveBeenCalled();
  });
  it('does not overwrite data after its lease expired', async () => {
    const h = harness(); h.tx.statsSync.findUnique.mockResolvedValue({ lockToken: 'different', lockedUntil: new Date(now.getTime() + 60_000) });
    await h.service.refreshUser(userId); expect(h.tx.steamAccount.update).not.toHaveBeenCalled();
  });
  it('refreshes linked FACEIT by stable ID so renames do not break sync', async () => {
    const h = harness(); h.prisma.user.findUnique.mockResolvedValue({ id: userId, isBanned: false, steamAccount: h.account, faceitAccount: h.faceit });
    await h.service.refreshUser(userId);
    expect(h.providers.faceit.findByPlayerId).toHaveBeenCalledWith(h.faceit.playerId, steamId64.toString());
    expect(h.providers.faceit.findByNickname).not.toHaveBeenCalled();
  });
  it('rejects FACEIT Steam mismatches without any account mutation', async () => {
    const h = harness(); vi.mocked(h.providers.faceit.findByNickname).mockRejectedValue(new ProviderError('faceit', 'STEAM_ID_MISMATCH'));
    await expect(h.service.linkFaceit(userId, 'other')).rejects.toMatchObject({ statusCode: 409, code: 'FACEIT_STEAM_MISMATCH' });
    expect(h.tx.faceitAccount.upsert).not.toHaveBeenCalled(); expect(h.state().lockedUntil).toBeNull();
  });
  it('FACEIT linking does not postpone the first missing Steam sync', async () => {
    const h = harness(); vi.spyOn(h.service, 'get').mockResolvedValue({} as any);
    await h.service.linkFaceit(userId, 'Fixture');
    expect(h.state().nextRefreshAt).toEqual(now);
  });
  it('reserves a persistent manual cooldown before enqueuing and resets on queue failure', async () => {
    const h = harness(); await h.service.manualRefresh(userId);
    expect(h.queue.enqueue).toHaveBeenCalledWith(userId);
    expect(h.state().manualAvailableAt).toEqual(new Date(now.getTime() + 300_000));
    h.prisma.statsSync.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(h.service.manualRefresh(userId)).rejects.toMatchObject({ statusCode: 429, code: 'STATS_SYNC_COOLDOWN' });
    h.queue.enqueue.mockRejectedValue(new Error('fixture internal URL key=never-print'));
    await expect(h.service.manualRefresh(userId)).rejects.toMatchObject({ code: 'STATS_UNAVAILABLE' });
    expect(h.state().lastErrorCode).toBe('STATS_UNAVAILABLE');
  });
});

describe('owner-only cached API serializer', () => {
  const statsUser = { steamAccount: { steamId64, personaName: 'Fixture', profileUrl: null, avatarUrl: null, profileVisibility: 3,
    gameDetailsPublic: true, timeCreated: null, syncedAt: now, vacBans: 0, gameBans: 0, daysSinceLastBan: 0, communityBanned: false, economyBan: 'none' },
    faceitAccount: null, statsSync: null,
    userGames: [{ steamAppId: 730, gameId: randomUUID(), name: 'CS2', playtimeTotal: 120, playtime2weeks: 60, syncedAt: now }] } as StatsUser;
  it('keeps exact activity and library available to the owner', () => {
    const own = serializeOwnStats(statsUser, { steam: true, faceit: false });
    expect(own.steam?.cs2?.playtimeTotal).toBe(120); expect(own.steam?.games).toHaveLength(1);
  });
  it('exposes private profile guidance without fake zero playtimes', () => {
    const own = serializeOwnStats({ ...statsUser, steamAccount: { ...statsUser.steamAccount!, profileVisibility: 1, gameDetailsPublic: false }, userGames: [] }, { steam: true, faceit: true });
    expect(own.guidance).toEqual(['STEAM_PROFILE_PRIVATE', 'STEAM_GAME_DETAILS_HIDDEN']); expect(own.steam?.cs2).toBeNull();
  });
  it('exposes expired worker leases as recoverable failure rather than permanent running', () => {
    expect(serializeSync({ status: 'RUNNING', lockedUntil: now } as any, now)).toMatchObject({ status: 'FAILED', lastErrorCode: 'STATS_UNAVAILABLE' });
  });
  it('stats GET only reads cached rows and rejects anonymous access', async () => {
    const h = harness(); h.prisma.user.findUnique.mockResolvedValue(statsUser);
    const prisma = { ...h.prisma, session: { findUnique: vi.fn().mockResolvedValue({ userId, expiresAt: new Date(now.getTime() + 60_000), user: { id: userId, isBanned: false } }) } };
    const app = await buildApp(config, { prisma: prisma as any, redis: false, stats: h.service, now: () => now });
    const response = await app.inject({ url: '/api/me/stats', headers: { authorization: `Bearer ${'A'.repeat(43)}` } });
    expect(response.statusCode).toBe(200); expect(response.json().steam.cs2.playtimeTotal).toBe(120);
    expect(prisma.session.findUnique).toHaveBeenCalledTimes(1);
    expect(h.providers.steam.sync).not.toHaveBeenCalled(); expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect((await app.inject('/api/me/stats')).statusCode).toBe(401); await app.close();
  });
});
