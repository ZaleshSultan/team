import { Queue, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Redis, RedisOptions } from 'ioredis';
import { moderationNotificationJobId, NOTIFICATION_BATCH_SIZE, NOTIFICATION_QUEUE_NAME, notificationRetryDelay, TelegramContacts } from '@squad/shared';
import type { BotConfig } from './config.js';
import { NotificationRetryError, RequestNotificationProcessor } from './notifications.js';
import { ModerationNotificationProcessor } from './moderation-notifications.js';

function connectionOptions(url: string): RedisOptions {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    db: Number(parsed.pathname.slice(1) || 0), ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null, retryStrategy: (attempt: number) => Math.min(500 * 2 ** Math.min(attempt, 5), 10_000) };
}

export async function startNotificationWorker(config: BotConfig, prisma: PrismaClient,
  logError: (message: string) => void = (message) => console.error(message)) {
  const connection = connectionOptions(config.REDIS_URL);
  const queue = new Queue(NOTIFICATION_QUEUE_NAME, { connection: { ...connection, maxRetriesPerRequest: 1 },
    defaultJobOptions: { attempts: config.NOTIFICATION_MAX_ATTEMPTS, backoff: { type: 'notifications' },
      removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 7 * 86_400, count: 10_000 } } });
  queue.on('error', () => logError('Notification queue connection failed'));
  try { await queue.setGlobalConcurrency(config.NOTIFICATION_CONCURRENCY); }
  catch { await queue.close().catch(() => undefined); throw new Error('NOTIFICATION_WORKER_START_FAILED'); }
  const processor = new RequestNotificationProcessor(prisma, config,
    new TelegramContacts(config.BOT_TOKEN, { timeoutMs: config.TELEGRAM_CONTACT_TIMEOUT_MS }));
  const moderation = new ModerationNotificationProcessor(prisma, config,
    new TelegramContacts(config.BOT_TOKEN, { timeoutMs: config.TELEGRAM_CONTACT_TIMEOUT_MS }));
  const worker = new Worker(NOTIFICATION_QUEUE_NAME, async (job) => {
    try { await (job.name === 'moderation-notification' ? moderation : processor).process(job); }
    catch (error) {
      // Extend the global pause on flood control, but use regular failed attempts
      // so repeated429 responses still consume the bounded retry budget.
      if (error instanceof NotificationRetryError && error.rateLimited && error.retryAfterMs > 0) {
        await worker.rateLimit(error.retryAfterMs).catch(() => undefined);
      }
      throw error instanceof NotificationRetryError ? error : new NotificationRetryError();
    }
  }, { connection, concurrency: config.NOTIFICATION_CONCURRENCY,
    limiter: { max: config.NOTIFICATION_RATE_LIMIT_PER_SECOND, duration: 1_000 },
    settings: { backoffStrategy: (attempts, _type, error) => notificationRetryDelay(attempts,
      config.NOTIFICATION_BACKOFF_MS, error instanceof NotificationRetryError ? error.retryAfterMs : 0) } });
  worker.on('error', () => logError('Notification worker connection failed'));
  worker.on('failed', () => logError('Notification delivery failed; automatic retry policy applies'));
  return {
    async dispatchModeration() { return dispatchModerationNotifications(prisma, queue); },
    async isHealthy() { return worker.isRunning() && await ((await queue.client) as unknown as Pick<Redis, 'ping'>).ping() === 'PONG'; },
    async close() { await worker.close(); await queue.close(); },
  };
}

/** Immediate ban dispatch shares the existing global Telegram queue/limiter.
 * API maintenance performs the same durable recovery scan after outages. */
export async function dispatchModerationNotifications(prisma: PrismaClient, queue: Pick<Queue, 'add' | 'getJob'>, now = new Date()) {
  const events = await prisma.moderationNotification.findMany({ where: { deliveredAt: null,
    AND: [{ OR: [{ enqueuedAt: null }, { enqueuedAt: { lte: new Date(now.getTime() - 15 * 60_000) } }] },
      { OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] }] },
    select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: NOTIFICATION_BATCH_SIZE });
  let count = 0;
  for (const event of events) {
    try {
      const jobId = moderationNotificationJobId(event.id); const existing = await queue.getJob(jobId);
      if (existing && ['failed', 'completed'].includes(await existing.getState())) {
        await prisma.moderationNotification.updateMany({ where: { id: event.id, deliveredAt: null }, data: { deliveredAt: now, claimToken: null, claimedUntil: null } }); continue;
      }
      await queue.add('moderation-notification', { eventId: event.id }, { jobId });
      await prisma.moderationNotification.updateMany({ where: { id: event.id, deliveredAt: null }, data: { enqueuedAt: now } }); count += 1;
    } catch { /* One enqueue failure never blocks later users; recovery scans retry. */ }
  }
  return count;
}
