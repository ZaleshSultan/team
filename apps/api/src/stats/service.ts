import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { ProviderError } from './providers/http.js';
import type { SteamProvider, SteamSnapshot } from './providers/steam.js';
import type { FaceitProvider, FaceitSnapshot } from './providers/faceit.js';
import { nextRefreshAt, STATS_LEASE_MS, SyncRetryError } from './policy.js';
import { serializeOwnStats, serializeSync, statsIncludes } from './serializer.js';

export interface SyncEnqueuer { enqueue(userId: string, delay?: number): Promise<void> }
export interface StatsProviders {
  steam: Pick<SteamProvider, 'configured' | 'sync'>;
  faceit: Pick<FaceitProvider, 'configured' | 'findBySteamId' | 'findByNickname' | 'findByPlayerId' | 'sync'>;
  onRateLimit?: (error: ProviderError) => Promise<void>;
}
const transactionOptions = { maxWait: 10_000, timeout: 10_000 };
const leaseAvailable = (now: Date) => ({ OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] });
const safeError = (error: unknown, provider: 'steam' | 'faceit') => error instanceof ProviderError
  ? error : new ProviderError(provider, 'UNAVAILABLE', true);
const errorCode = (error: ProviderError) => error.code === 'STEAM_ID_MISMATCH' ? 'FACEIT_STEAM_MISMATCH' : error.message;

export class StatsService {
  constructor(private readonly prisma: PrismaClient, private readonly config: Config,
    private readonly providers: StatsProviders, private readonly queue?: SyncEnqueuer,
    private readonly now: () => Date = () => new Date(), private readonly random = Math.random) {}

  async get(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: statsIncludes });
    if (!user) throw new AppError(401, 'SESSION_EXPIRED', 'The account no longer exists');
    return serializeOwnStats(user, { steam: this.providers.steam.configured, faceit: this.providers.faceit.configured }, this.now());
  }

  private async ensureState(userId: string) {
    // FK failure on concurrent account deletion must not recreate the user.
    return this.prisma.statsSync.upsert({ where: { userId }, create: { userId, nextRefreshAt: this.now() }, update: {} });
  }

  async manualRefresh(userId: string) {
    if (!this.queue || (!this.providers.steam.configured && !this.providers.faceit.configured)) {
      throw new AppError(503, 'STATS_UNAVAILABLE', 'Stats are currently unavailable');
    }
    const account = await this.prisma.steamAccount.findUnique({ where: { userId } });
    if (!account) throw new AppError(409, 'STEAM_NOT_LINKED', 'Link Steam first');
    const previous = await this.ensureState(userId);
    const now = this.now();
    const manualAvailableAt = new Date(now.getTime() + this.config.STATS_MANUAL_COOLDOWN_SECONDS * 1000);
    const claimed = await this.prisma.statsSync.updateMany({ where: { userId,
      AND: [leaseAvailable(now), { OR: [{ manualAvailableAt: null }, { manualAvailableAt: { lte: now } }] }],
    }, data: { manualAvailableAt, status: 'QUEUED', nextRefreshAt: new Date(now.getTime() + 5 * 60_000) } });
    if (claimed.count !== 1) throw new AppError(429, 'STATS_SYNC_COOLDOWN', 'Wait before refreshing again');
    try { await this.queue.enqueue(userId); }
    catch {
      await this.prisma.statsSync.updateMany({ where: { userId, manualAvailableAt, status: 'QUEUED', lockedUntil: null },
        data: { status: 'FAILED', lastErrorCode: 'STATS_UNAVAILABLE', manualAvailableAt: previous.manualAvailableAt, nextRefreshAt: now } });
      throw new AppError(503, 'STATS_UNAVAILABLE', 'Stats are currently unavailable');
    }
    return { sync: serializeSync(await this.prisma.statsSync.findUnique({ where: { userId } }), this.now()) };
  }

  private async acquire(userId: string) {
    await this.ensureState(userId);
    const now = this.now();
    const token = randomUUID();
    const lease = await this.prisma.statsSync.updateMany({ where: { userId, ...leaseAvailable(now) },
      data: { status: 'RUNNING', lockedUntil: new Date(now.getTime() + STATS_LEASE_MS), lockToken: token, lastAttemptAt: now } });
    return lease.count === 1 ? token : null;
  }

  private async persist(userId: string, token: string, data: { steam?: SteamSnapshot; faceit?: FaceitSnapshot; errors: ProviderError[]; independentFaceit?: boolean; invalidateFaceit?: boolean }, steamId64: bigint) {
    return this.prisma.$transaction(async (tx) => {
      // Lock only while writing, never during provider requests. This serializes
      // deletion/bans and prevents an in-flight sync resurrecting deleted data.
      const users = await tx.$queryRaw<{ id: string; is_banned: boolean }[]>`SELECT id, is_banned FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (!users[0] || users[0].is_banned) return false;
      const state = await tx.statsSync.findUnique({ where: { userId } });
      if (!state || state.lockToken !== token || !state.lockedUntil || state.lockedUntil <= this.now()) return false;
      const account = await tx.steamAccount.findUnique({ where: { userId } });
      if (!account || account.steamId64 !== steamId64) return false;
      const syncedAt = this.now();
      if (data.steam) {
        const steam = data.steam;
        await tx.steamAccount.update({ where: { userId }, data: { personaName: steam.personaName,
          avatarUrl: steam.avatarUrl, profileUrl: steam.profileUrl, profileVisibility: steam.visibility,
          gameDetailsPublic: steam.gameDetailsPublic, timeCreated: steam.timeCreated, vacBans: steam.vacBans,
          gameBans: steam.gameBans, daysSinceLastBan: steam.daysSinceLastBan, communityBanned: steam.communityBanned,
          economyBan: steam.economyBan, syncedAt } });
        const games = steam.gameDetailsPublic ? steam.games : [];
        const catalog = await tx.game.findMany({ select: { id: true, steamAppId: true } });
        const catalogIds = new Map(catalog.map((game) => [game.steamAppId, game.id]));
        // Delete removed/hidden games too: cached private activity must disappear.
        await tx.userGame.deleteMany({ where: { userId, ...(games.length ? { steamAppId: { notIn: games.map((game) => game.steamAppId) } } : {}) } });
        // PostgreSQL bulk upsert avoids one round-trip per title for large libraries.
        for (let offset = 0; offset < games.length; offset += 500) {
          const rows = games.slice(offset, offset + 500).map((game) => Prisma.sql`(${randomUUID()}::uuid, ${userId}::uuid,
            ${game.steamAppId}, ${catalogIds.get(game.steamAppId) ?? null}::uuid, ${game.name}, ${game.playtimeTotal}, ${game.playtime2weeks}, ${syncedAt})`);
          await tx.$executeRaw(Prisma.sql`INSERT INTO user_games (id, user_id, steam_app_id, game_id, name, playtime_total, playtime_2weeks, synced_at)
            VALUES ${Prisma.join(rows)} ON CONFLICT (user_id, steam_app_id) DO UPDATE SET
            game_id = EXCLUDED.game_id, name = EXCLUDED.name, playtime_total = EXCLUDED.playtime_total,
            playtime_2weeks = EXCLUDED.playtime_2weeks, synced_at = EXCLUDED.synced_at`);
        }
      }
      if (data.invalidateFaceit) await tx.faceitAccount.deleteMany({ where: { userId } });
      if (data.faceit) {
        const faceit = data.faceit;
        if (faceit.steamId64 !== steamId64.toString()) throw new ProviderError('faceit', 'STEAM_ID_MISMATCH');
        const fields = { playerId: faceit.playerId, steamId64, nickname: faceit.nickname, profileUrl: faceit.profileUrl,
          level: faceit.level, elo: faceit.elo, kd: faceit.kd, winRate: faceit.winRate, favoriteMaps: faceit.favoriteMaps, syncedAt };
        if (data.independentFaceit) await tx.$executeRaw`SAVEPOINT faceit_cache`;
        try { await tx.faceitAccount.upsert({ where: { userId }, create: { userId, ...fields }, update: fields }); }
        catch (error) {
          if (!data.independentFaceit) throw error;
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT faceit_cache`;
          data.errors.push(new ProviderError('faceit', 'INVALID_RESPONSE'));
        } finally { if (data.independentFaceit) await tx.$executeRaw`RELEASE SAVEPOINT faceit_cache`; }
      }
      const failed = data.errors.length > 0;
      const next = nextRefreshAt(syncedAt, this.config.STATS_REFRESH_HOURS, this.random);
      // FACEIT-only linking must not postpone a missing or stale Steam refresh.
      const steamDue = this.providers.steam.configured && !data.steam
        ? new Date((account.syncedAt?.getTime() ?? 0) + this.config.STATS_REFRESH_HOURS * 3_600_000) : next;
      await tx.statsSync.update({ where: { userId }, data: { status: failed ? 'FAILED' : 'IDLE',
        lastErrorCode: data.errors[0] ? errorCode(data.errors[0]) : null, lockToken: null, lockedUntil: null,
        ...(!failed ? { lastSuccessAt: syncedAt } : {}),
        nextRefreshAt: failed ? new Date(syncedAt.getTime() + 10 * 60_000) : new Date(Math.max(syncedAt.getTime(), Math.min(next.getTime(), steamDue.getTime()))) } });
      return true;
    }, transactionOptions);
  }

  async refreshUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { steamAccount: true, faceitAccount: true } });
    if (!user || user.isBanned || !user.steamAccount) return;
    const token = await this.acquire(userId);
    if (!token) throw new SyncRetryError(30_000);
    const steamId64 = user.steamAccount.steamId64;
    const errors: ProviderError[] = [];
    let steam: SteamSnapshot | undefined;
    let faceit: FaceitSnapshot | undefined;
    let invalidateFaceit = false;
    const recordError = async (error: ProviderError) => {
      errors.push(error);
      // Publish immediately, rather than waiting for the other provider to finish.
      if (error.code === 'RATE_LIMITED') {
        try { await this.providers.onRateLimit?.(error); } catch { /* Keep independently successful cache data. */ }
      }
    };
    await Promise.all([
      (async () => {
        if (!this.providers.steam.configured) return;
        try { steam = await this.providers.steam.sync(steamId64.toString()); }
        catch (error) { await recordError(safeError(error, 'steam')); }
      })(),
      (async () => {
        if (!this.providers.faceit.configured) return;
        try {
          const player = user.faceitAccount
            ? await this.providers.faceit.findByPlayerId(user.faceitAccount.playerId, steamId64.toString())
            : await this.providers.faceit.findBySteamId(steamId64.toString());
          if (player) faceit = await this.providers.faceit.sync(player);
          else if (user.faceitAccount) {
            invalidateFaceit = true;
            errors.push(new ProviderError('faceit', 'NOT_FOUND'));
          }
        } catch (error) {
          const safe = safeError(error, 'faceit');
          if (user.faceitAccount && safe.code === 'STEAM_ID_MISMATCH') invalidateFaceit = true;
          await recordError(safe);
        }
      })(),
    ]);
    try { if (!await this.persist(userId, token, { steam, faceit, errors, independentFaceit: true, invalidateFaceit }, steamId64)) return; }
    catch {
      await this.prisma.statsSync.updateMany({ where: { userId, lockToken: token }, data: {
        status: 'FAILED', lastErrorCode: 'STATS_UNAVAILABLE', lockToken: null, lockedUntil: null,
        nextRefreshAt: new Date(this.now().getTime() + 10 * 60_000) } });
      throw new SyncRetryError();
    }
    const retryable = errors.filter((error) => error.retryable);
    if (retryable.length) throw new SyncRetryError(Math.max(...retryable.map((error) => error.retryAfterMs ?? 0)));
  }

  async linkFaceit(userId: string, nickname: string) {
    if (!this.providers.faceit.configured) throw new AppError(503, 'FACEIT_UNAVAILABLE', 'FACEIT stats are unavailable');
    const account = await this.prisma.steamAccount.findUnique({ where: { userId } });
    if (!account) throw new AppError(409, 'STEAM_NOT_LINKED', 'Link Steam first');
    const token = await this.acquire(userId);
    if (!token) throw new AppError(409, 'FACEIT_LINK_CONFLICT', 'Stats are being refreshed; retry shortly');
    try {
      const player = await this.providers.faceit.findByNickname(nickname, account.steamId64.toString());
      if (!player) throw new ProviderError('faceit', 'NOT_FOUND');
      const faceit = await this.providers.faceit.sync(player);
      const stored = await this.persist(userId, token, { faceit, errors: [] }, account.steamId64);
      if (!stored) throw new AppError(409, 'FACEIT_LINK_CONFLICT', 'Account changed; retry shortly');
    } catch (error) {
      const safe = safeError(error, 'faceit');
      if (safe.code === 'RATE_LIMITED') {
        try { await this.providers.onRateLimit?.(safe); } catch { /* Lease release must still happen. */ }
      }
      await this.prisma.statsSync.updateMany({ where: { userId, lockToken: token }, data: { status: 'FAILED',
        lastErrorCode: errorCode(safe), lockToken: null, lockedUntil: null } });
      if (error instanceof AppError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new AppError(409, 'FACEIT_ACCOUNT_IN_USE', 'This FACEIT account is already linked');
      throw new AppError(safe.code === 'STEAM_ID_MISMATCH' ? 409 : safe.code === 'NOT_FOUND' ? 404 : 503,
        errorCode(safe), 'Unable to link FACEIT');
    }
    return this.get(userId);
  }
}
