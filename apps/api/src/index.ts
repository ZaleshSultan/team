import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';

let shutdown: (() => Promise<void>) | undefined;
try {
  const config = loadConfig();
  const prisma = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: (attempt) => Math.min(500 * 2 ** Math.min(attempt, 5), 10_000) });
  const app = await buildApp(config, { prisma, redis });
  shutdown = async () => { await app.close(); };
  await prisma.$connect();
  await redis.connect();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Invalid environment:') ? error.message : 'API startup failed. Check configuration and database/cache connectivity.');
  await shutdown?.();
  process.exitCode = 1;
}
