import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import type { Config } from './config.js';

export async function buildApp(config: Config) {
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
  app.get('/health', async () => ({ status: 'ok', milestone: 'M1' }));
  return app;
}
