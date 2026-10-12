import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { emptyInputSchema, faceitLinkInputSchema, manualSyncResponseSchema } from '@squad/shared';
import type { Config } from '../config.js';
import { requireSession } from '../auth/session.js';
import { toAuthUser } from '../auth/routes.js';
import { AppError } from '../errors.js';
import type { StatsService } from './service.js';

export async function registerStatsRoutes(app: FastifyInstance, deps: {
  prisma: PrismaClient; config: Config; now: () => Date; stats: StatsService;
}) {
  app.get('/api/me/stats', async (request) => deps.stats.get((await requireSession(request, deps)).id));
  app.post('/api/me/sync', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await requireSession(request, deps);
    emptyInputSchema.parse(request.body ?? {});
    if (toAuthUser(user, deps.config).onboarding.required) throw new AppError(409, 'ONBOARDING_REQUIRED', 'Complete onboarding first');
    const result = await deps.stats.manualRefresh(user.id);
    reply.code(202);
    return manualSyncResponseSchema.parse(result);
  });
  app.post('/api/me/faceit/link', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, async (request) => {
    const user = await requireSession(request, deps);
    const body = faceitLinkInputSchema.parse(request.body);
    if (toAuthUser(user, deps.config).onboarding.required) throw new AppError(409, 'ONBOARDING_REQUIRED', 'Complete onboarding first');
    return deps.stats.linkFaceit(user.id, body.nickname);
  });
}
