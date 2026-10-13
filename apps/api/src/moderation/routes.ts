import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { blockListQuerySchema, blockListResponseSchema, emptyInputSchema, reportResponseSchema } from '@squad/shared';
import { requireSession } from '../auth/session.js';
import { toAuthUser } from '../auth/routes.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { ReportService } from './service.js';

export async function registerModerationRoutes(app: FastifyInstance, deps: {
  prisma: PrismaClient; config: Config; now: () => Date; moderation: ReportService;
}) {
  const options = { config: { rateLimit: { max: deps.config.REPORTS_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } };
  async function actor(request: FastifyRequest) {
    const user = await requireSession(request, deps);
    if (toAuthUser(user, deps.config).onboarding.required) throw new AppError(403, 'ONBOARDING_INCOMPLETE', 'Complete onboarding before using reports');
    return user;
  }
  app.post('/api/reports', options, async (request, reply) => {
    const user = await actor(request); emptyInputSchema.parse(request.query);
    const response = reportResponseSchema.parse(await deps.moderation.report(user.id, request.body));
    reply.code(response.duplicate ? 200 : 201); return response;
  });
  app.get('/api/blocks', { config: { rateLimit: { max: deps.config.REQUESTS_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (request) => {
    const user = await actor(request);
    return blockListResponseSchema.parse(await deps.moderation.listBlocks(user.id, blockListQuerySchema.parse(request.query)));
  });
}
