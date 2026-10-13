import { Queue, Worker } from 'bullmq';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { RedisOptions } from 'ioredis';
import { NOTIFICATION_BATCH_SIZE, NOTIFICATION_QUEUE_NAME, notificationJobId,
  REQUEST_MAINTENANCE_INTERVAL_MS, REQUEST_MAINTENANCE_QUEUE_NAME } from '@squad/shared';
import type { Config } from '../config.js';
import { dispatchModerationNotifications, retainModerationData } from '../moderation/maintenance.js';

const OUTBOX_RECHECK_MS = 15 * 60_000;
const EXPIRY_BATCH_SIZE = 500;

function connectionOptions(url: string): RedisOptions {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    db: Number(parsed.pathname.slice(1) || 0), ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null, retryStrategy: (attempt: number) => Math.min(500 * 2 ** Math.min(attempt, 5), 10_000) };
}

/** No user-row lock is acquired after the request locks. The conditional UPDATE
 * serializes with accept/cancel and cannot overwrite a newly resolved request. */
export async function expirePendingRequests(prisma: PrismaClient, now = new Date()): Promise<number> {
  return prisma.$transaction(async (transaction) => {
    const due = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM teammate_requests WHERE status = 'PENDING' AND expires_at <= ${now}
      ORDER BY expires_at ASC, id ASC LIMIT ${EXPIRY_BATCH_SIZE} FOR UPDATE SKIP LOCKED`);
    if (!due.length) return 0;
    const result = await transaction.teammateRequest.updateMany({
      where: { id: { in: due.map(({ id }) => id) }, status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED', resolvedAt: now },
    });
    return result.count;
  });
}

type OutboxQueue = Pick<Queue, 'add' | 'getJob'>;

/** A committed DB outbox survives an enqueue failure or a lost Redis dataset.
 * Only opaque IDs enter Redis; names, messages and contacts stay out of jobs. */
export async function dispatchRequestNotifications(prisma: PrismaClient, queue: OutboxQueue, now = new Date()): Promise<number> {
  const events = await prisma.requestNotification.findMany({ where: { deliveredAt: null,
    AND: [{ OR: [{ enqueuedAt: null }, { enqueuedAt: { lte: new Date(now.getTime() - OUTBOX_RECHECK_MS) } }] },
      { OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] }] },
    select: { id: true, requestId: true, kind: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: NOTIFICATION_BATCH_SIZE });
  let enqueued = 0;
  for (const event of events) {
    try {
      const jobId = notificationJobId(event.requestId, event.kind);
      const existing = await queue.getJob(jobId);
      if (existing && ['failed', 'completed'].includes(await existing.getState())) {
        // A terminal job can outlive a brief DB outage at its final marker write.
        await prisma.requestNotification.updateMany({ where: { id: event.id, deliveredAt: null },
          data: { deliveredAt: now, claimToken: null, claimedUntil: null } });
        continue;
      }
      await queue.add('request-notification', { eventId: event.id }, { jobId });
      await prisma.requestNotification.updateMany({ where: { id: event.id, deliveredAt: null }, data: { enqueuedAt: now } });
      enqueued += 1;
    } catch { /* A later scan retries this event; one failed enqueue never blocks the rest. */ }
  }
  return enqueued;
}

export function createRequestsRuntime(config: Config, prisma: PrismaClient, options: {
  now?: () => Date; logError?: (message: string) => void;
} = {}) {
  const connection = connectionOptions(config.REDIS_URL);
  const notifications = new Queue(NOTIFICATION_QUEUE_NAME, { connection: { ...connection, maxRetriesPerRequest: 1 },
    defaultJobOptions: { attempts: config.NOTIFICATION_MAX_ATTEMPTS, backoff: { type: 'notifications' },
      removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 7 * 86_400, count: 10_000 } } });
  const maintenance = new Queue(REQUEST_MAINTENANCE_QUEUE_NAME, { connection: { ...connection, maxRetriesPerRequest: 1 },
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: true, removeOnFail: true } });
  notifications.on('error', () => options.logError?.('Notification queue connection failed'));
  maintenance.on('error', () => options.logError?.('Request maintenance queue connection failed'));
  let worker: Worker | undefined;
  let currentDispatch: Promise<number> | undefined;
  const dispatch = () => currentDispatch ??= Promise.all([
    dispatchRequestNotifications(prisma, notifications, options.now?.() ?? new Date()),
    dispatchModerationNotifications(prisma, notifications, options.now?.() ?? new Date()),
  ]).then((counts) => counts.reduce((sum, count) => sum + count, 0))
    .finally(() => { currentDispatch = undefined; });
  return { dispatch,
    async start() {
      await maintenance.setGlobalConcurrency(1);
      worker = new Worker(REQUEST_MAINTENANCE_QUEUE_NAME, async (job) => {
        if (job.name !== 'request-maintenance') return;
        try {
          await expirePendingRequests(prisma, options.now?.() ?? new Date());
          await retainModerationData(prisma, config, options.now?.() ?? new Date());
          await dispatch();
        } catch { throw new Error('REQUEST_MAINTENANCE_FAILED'); }
      }, { connection, concurrency: 1 });
      worker.on('error', () => options.logError?.('Request maintenance worker connection failed'));
      worker.on('failed', () => options.logError?.('Request maintenance failed; automatic retry policy applies'));
      await maintenance.upsertJobScheduler('requests-maintenance', { every: REQUEST_MAINTENANCE_INTERVAL_MS },
        { name: 'request-maintenance', data: {} });
      await dispatch();
    },
    async close() { await worker?.close(); await notifications.close(); await maintenance.close(); },
  };
}
