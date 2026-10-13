import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { createStatsRuntime } from './stats/queue.js';
import { createRequestsRuntime } from './requests/queue.js';
import { RequestService } from './requests/service.js';
import { TelegramContacts } from '@squad/shared';
import { ReportService } from './moderation/service.js';

let shutdown: (() => Promise<void>) | undefined;
try {
  const config = loadConfig();
  const prisma = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: (attempt) => Math.min(500 * 2 ** Math.min(attempt, 5), 10_000) });
  const stats = createStatsRuntime(config, prisma, redis, { logError: (message) => console.error(message) });
  const requestRuntime = createRequestsRuntime(config, prisma, { logError: (message) => console.error(message) });
  const requests = new RequestService(prisma, config, new TelegramContacts(config.BOT_TOKEN,
    { timeoutMs: config.TELEGRAM_CONTACT_TIMEOUT_MS }), () => requestRuntime.dispatch());
  const moderation = new ReportService(prisma, config, () => requestRuntime.dispatch());
  const app = await buildApp(config, { prisma, redis, stats: stats.service, requests, moderation });
  app.addHook('onClose', () => stats.close());
  app.addHook('onClose', () => requestRuntime.close());
  shutdown = async () => { await app.close(); };
  await prisma.$connect();
  await redis.connect();
  await stats.start();
  await requestRuntime.start();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Invalid environment:') ? error.message : 'API startup failed. Check configuration and database/cache connectivity.');
  await shutdown?.();
  process.exitCode = 1;
}
