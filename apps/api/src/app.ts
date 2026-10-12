import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import type { Config } from './config.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerStatsRoutes } from './stats/routes.js';
import { StatsService } from './stats/service.js';
import { SteamProvider } from './stats/providers/steam.js';
import { FaceitProvider } from './stats/providers/faceit.js';
import { sessionRateLimitKey } from './auth/session.js';

export interface AppDependencies {
  prisma?: PrismaClient;
  redis?: Redis | false;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  stats?: StatsService;
}

export async function buildApp(config: Config, dependencies: AppDependencies = {}) {
  const prisma = dependencies.prisma ?? new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const redis = dependencies.redis === false || (dependencies.redis === undefined && config.NODE_ENV === 'test')
    ? null : dependencies.redis ?? new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: (attempt) => Math.min(500 * 2 ** Math.min(attempt, 5), 10_000) });
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.initData', 'token', 'initData', 'startCode', 'callbackState'],
      // OpenID callback URLs and launch URLs contain one-time secrets. Never log URLs.
      serializers: { req: (req) => ({ method: req.method, hostname: req.hostname, remoteAddress: req.ip }) },
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 16_384,
    requestTimeout: 15_000,
  });
  await app.register(cors, { origin: new URL(config.MINIAPP_ORIGIN).origin, credentials: false });
  await app.register(helmet);
  await app.register(cookie);
  if (redis) redis.on('error', () => app.log.error('Redis connection failed'));
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', ...(redis ? { redis } : {}), skipOnError: false,
    keyGenerator: (request) => sessionRateLimitKey(request, { prisma, now: dependencies.now ?? (() => new Date()) }),
    errorResponseBuilder: (_request, context) => new AppError(context.statusCode, 'RATE_LIMITED', 'Too many requests; retry later'),
  });
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
    if (redis) redis.disconnect();
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid request data', requestId: request.id } });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, requestId: request.id } });
    }
    const known = error as FastifyError;
    const status = known.statusCode && known.statusCode >= 400 && known.statusCode < 500 ? known.statusCode : 500;
    if (status === 500) request.log.error({ errorType: known.name ?? 'UnknownError' }, 'Request failed');
    return reply.code(status).send({ error: { code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: status === 500 ? 'An internal error occurred' : 'Invalid request', requestId: request.id } });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id } }));
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/ready', { config: { rateLimit: false } }, async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (redis) await redis.ping();
      return { status: 'ok' };
    } catch {
      throw new AppError(503, 'DEPENDENCIES_UNAVAILABLE', 'Required dependencies are unavailable');
    }
  });
  await registerAuthRoutes(app, { config, prisma, fetch: dependencies.fetch ?? globalThis.fetch, now: dependencies.now ?? (() => new Date()) });
  const stats = dependencies.stats ?? new StatsService(prisma, config, {
    steam: new SteamProvider({ apiKey: config.STEAM_WEB_API_KEY, fetch: dependencies.fetch }),
    faceit: new FaceitProvider({ apiKey: config.FACEIT_API_KEY, fetch: dependencies.fetch }),
  }, undefined, dependencies.now);
  await registerStatsRoutes(app, { config, prisma, stats, now: dependencies.now ?? (() => new Date()) });
  return app;
}
