import { Queue, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { RedisOptions } from 'ioredis';
import { NOTIFICATION_QUEUE_NAME, notificationRetryDelay, TelegramContacts } from '@squad/shared';
import type { BotConfig } from './config.js';
import { NotificationRetryError, RequestNotificationProcessor } from './notifications.js';

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
  const queue = new Queue(NOTIFICATION_QUEUE_NAME, { connection: { ...connection, maxRetriesPerRequest: 1 } });
  queue.on('error', () => logError('Notification queue connection failed'));
  try { await queue.setGlobalConcurrency(config.NOTIFICATION_CONCURRENCY); }
  catch { await queue.close().catch(() => undefined); throw new Error('NOTIFICATION_WORKER_START_FAILED'); }
  const processor = new RequestNotificationProcessor(prisma, config,
    new TelegramContacts(config.BOT_TOKEN, { timeoutMs: config.TELEGRAM_CONTACT_TIMEOUT_MS }));
  const worker = new Worker(NOTIFICATION_QUEUE_NAME, async (job) => {
    try { await processor.process(job); }
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
  return { async close() { await worker.close(); await queue.close(); } };
}
