import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { emptyInputSchema, faceitLinkInputSchema, manualSyncResponseSchema } from '@squad/shared';
import type { Config } from '../config.js';
import { hashSecret } from '../auth/secrets.js';
import { toAuthUser } from '../auth/routes.js';
import { AppError } from '../errors.js';
import type { StatsService } from './service.js';

export async function registerStatsRoutes(app: FastifyInstance, deps: {
  prisma: PrismaClient; config: Config; now: () => Date; stats: StatsService;
}) {
  // M2 session validation; shared with the global limiter in the hardening commit.
  const requireUser = async (request: FastifyRequest) => {
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new AppError(401, 'SESSION_INVALID', 'A valid session is required');
    const session = await deps.prisma.session.findUnique({ where: { tokenHash: hashSecret(token) },
      include: { user: { include: { steamAccount: true, privacySettings: true } } } });
    if (!session || session.expiresAt <= deps.now()) throw new AppError(401, 'SESSION_EXPIRED', 'The session has expired');
    if (session.user.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
    return session.user;
  };
  app.get('/api/me/stats', async (request) => deps.stats.get((await requireUser(request)).id));
  app.post('/api/me/sync', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await requireUser(request);
    emptyInputSchema.parse(request.body ?? {});
    if (toAuthUser(user, deps.config).onboarding.required) throw new AppError(409, 'ONBOARDING_REQUIRED', 'Complete onboarding first');
    const result = await deps.stats.manualRefresh(user.id);
    reply.code(202);
    return manualSyncResponseSchema.parse(result);
  });
  app.post('/api/me/faceit/link', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, async (request) => {
    const user = await requireUser(request);
    const body = faceitLinkInputSchema.parse(request.body);
    if (toAuthUser(user, deps.config).onboarding.required) throw new AppError(409, 'ONBOARDING_REQUIRED', 'Complete onboarding first');
    return deps.stats.linkFaceit(user.id, body.nickname);
  });
}
