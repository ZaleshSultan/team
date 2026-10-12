import { Queue, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Redis, RedisOptions } from 'ioredis';
import type { Config } from '../config.js';
import { SteamProvider } from './providers/steam.js';
import { FaceitProvider } from './providers/faceit.js';
import { ProviderError, type ProviderName } from './providers/http.js';
import { StatsService } from './service.js';
import { retryDelay, STATS_BATCH_SIZE, STATS_SCAN_MS, staleAccountsWhere, SyncRetryError } from './policy.js';

const queueName = 'squad-stats-v1';
// Redis TIME gives every API replica the same clock. An atomic reservation spaces
// outgoing requests globally; a provider-wide cooldown suppresses requests on429.
const reserveScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local blocked = tonumber(redis.call('GET', KEYS[2]) or '0')
if blocked > now then return -(blocked - now) end
local next = math.max(now, tonumber(redis.call('GET', KEYS[1]) or '0'))
if next - now > 10000 then return -(next - now) end
redis.call('SET', KEYS[1], next + tonumber(ARGV[1]), 'PX', 60000)
return next - now`;
const blockScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local untilAt = math.max(tonumber(redis.call('GET', KEYS[1]) or '0'), now + tonumber(ARGV[1]))
redis.call('SET', KEYS[1], untilAt, 'PX', untilAt - now)
return untilAt`;
const blockedScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
return math.max(0, tonumber(redis.call('GET', KEYS[1]) or '0') - now)`;

export function createProviderGate(redis: Pick<Redis, 'eval'>, provider: ProviderName, intervalMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const prefix = `squad:stats:provider:${provider}`;
  return {
    async beforeRequest() {
      const delay = Number(await redis.eval(reserveScript, 2, `${prefix}:next`, `${prefix}:blocked`, intervalMs));
      if (!Number.isFinite(delay)) throw new ProviderError(provider, 'UNAVAILABLE', true);
      if (delay < 0) throw new ProviderError(provider, 'RATE_LIMITED', true, -delay, 429);
      if (delay > 0) {
        await sleep(delay);
        // Another replica may have received429 while this reservation slept.
        const blocked = Number(await redis.eval(blockedScript, 1, `${prefix}:blocked`));
        if (!Number.isFinite(blocked)) throw new ProviderError(provider, 'UNAVAILABLE', true);
        if (blocked > 0) throw new ProviderError(provider, 'RATE_LIMITED', true, blocked, 429);
      }
    },
    async blockFor(ms: number) {
      if (ms > 0 && Number.isFinite(ms)) await redis.eval(blockScript, 1, `${prefix}:blocked`, Math.ceil(ms));
    },
  };
}

function redisConnection(url: string): RedisOptions {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    db: Number(parsed.pathname.slice(1) || 0), ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null, retryStrategy: (attempt: number) => Math.min(500 * 2 ** Math.min(attempt, 5), 10_000) };
}

export async function scanStaleAccounts(prisma: PrismaClient, enqueue: (userId: string, delay: number) => Promise<void>,
  now = new Date(), random = Math.random) {
  const accounts = await prisma.steamAccount.findMany({ where: staleAccountsWhere(now), select: { userId: true },
    orderBy: [{ linkedAt: 'asc' }, { userId: 'asc' }], take: STATS_BATCH_SIZE });
  // A queue failure for one user is independent of other users in the batch.
  for (const account of accounts) {
    try {
      await prisma.statsSync.upsert({ where: { userId: account.userId }, create: { userId: account.userId, nextRefreshAt: now }, update: {} });
      const claim = await prisma.statsSync.updateMany({ where: { userId: account.userId, nextRefreshAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
        data: { status: 'QUEUED', nextRefreshAt: new Date(now.getTime() + 5 * 60_000) } });
      if (claim.count) await enqueue(account.userId, Math.floor(random() * STATS_SCAN_MS));
    } catch { /* Next scan retries; never include DB/provider errors or user data in logs. */ }
  }
  return accounts.length;
}

export function createStatsRuntime(config: Config, prisma: PrismaClient, redis: Redis, options: {
  fetch?: typeof globalThis.fetch; now?: () => Date; logError?: (message: string) => void;
} = {}) {
  const connection = redisConnection(config.REDIS_URL);
  const queue = new Queue(queueName, { connection: { ...connection, maxRetriesPerRequest: 1 },
    defaultJobOptions: { attempts: 4, backoff: { type: 'stats' }, removeOnComplete: true, removeOnFail: true } });
  const gates = { steam: createProviderGate(redis, 'steam', config.STATS_STEAM_INTERVAL_MS),
    faceit: createProviderGate(redis, 'faceit', config.STATS_FACEIT_INTERVAL_MS) };
  const enqueue = async (userId: string, delay = 0) => {
    await queue.add('refresh-user', { userId }, { jobId: `user-${userId}`, delay });
  };
  const service = new StatsService(prisma, config, {
    steam: new SteamProvider({ apiKey: config.STEAM_WEB_API_KEY, fetch: options.fetch, beforeRequest: gates.steam.beforeRequest }),
    faceit: new FaceitProvider({ apiKey: config.FACEIT_API_KEY, fetch: options.fetch, beforeRequest: gates.faceit.beforeRequest }),
    onRateLimit: (error) => gates[error.provider].blockFor(error.retryAfterMs ?? 60_000),
  }, { enqueue }, options.now);
  let worker: Worker | undefined;
  queue.on('error', () => options.logError?.('Stats queue connection failed'));
  return { service,
    async start() {
      await queue.setGlobalConcurrency(config.STATS_WORKER_CONCURRENCY);
      worker = new Worker(queueName, async (job) => {
        try {
          if (job.name === 'scan-stale') {
            if (config.STEAM_WEB_API_KEY || config.FACEIT_API_KEY) await scanStaleAccounts(prisma, enqueue, options.now?.() ?? new Date());
          } else if (job.name === 'refresh-user' && typeof job.data.userId === 'string' && /^[0-9a-f-]{36}$/i.test(job.data.userId)) {
            await service.refreshUser(job.data.userId);
          }
        } catch (error) {
          if (job.name === 'refresh-user' && job.attemptsMade + 1 < (job.opts.attempts ?? 1)) {
            await prisma.statsSync.updateMany({ where: { userId: job.data.userId, status: 'FAILED', lockedUntil: null },
              data: { status: 'QUEUED' } }).catch(() => undefined);
          }
          // BullMQ persists failedReason/stacktrace: discard raw exceptions here too.
          throw error instanceof SyncRetryError ? error : new SyncRetryError();
        }
      }, { connection, concurrency: config.STATS_WORKER_CONCURRENCY,
        settings: { backoffStrategy: (attempts, _type, error) => error instanceof SyncRetryError && !error.retryable
          ? -1 : retryDelay(attempts, error instanceof SyncRetryError ? error.retryAfterMs : 0) } });
      worker.on('error', () => options.logError?.('Stats worker connection failed'));
      worker.on('failed', () => options.logError?.('Stats job failed; automatic retry policy applies'));
      await queue.upsertJobScheduler('stale-accounts', { every: STATS_SCAN_MS }, { name: 'scan-stale', data: {},
        opts: { attempts: 4, backoff: { type: 'stats' }, removeOnComplete: true, removeOnFail: true } });
    },
    async close() { await worker?.close(); await queue.close(); },
  };
}
