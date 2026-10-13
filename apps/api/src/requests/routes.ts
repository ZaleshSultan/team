import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { blockProfileParamsSchema, requestIdParamsSchema, blockResponseSchema, emptyInputSchema, requestListQuerySchema, requestListResponseSchema,
  requestResponseSchema, requestSummaryResponseSchema } from '@squad/shared';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { requireSession } from '../auth/session.js';
import { toAuthUser } from '../auth/routes.js';
import { requestNotFound, targetUnavailable } from './errors.js';
import type { RequestService } from './service.js';

export async function registerRequestRoutes(app: FastifyInstance, deps: {
  prisma: PrismaClient; config: Config; now: () => Date; requests: RequestService;
}) {
  const options = { config: { rateLimit: { max: deps.config.REQUESTS_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } };
  async function actor(request: FastifyRequest) {
    const user = await requireSession(request, deps);
    if (toAuthUser(user, deps.config).onboarding.required) throw new AppError(403, 'ONBOARDING_INCOMPLETE', 'Complete onboarding before using requests');
    return user;
  }
  const id = (raw: unknown) => { const parsed = requestIdParamsSchema.safeParse(raw); if (!parsed.success) throw requestNotFound(); return parsed.data.id; };

  app.post('/api/requests', options, async (request) => {
    const user = await actor(request); emptyInputSchema.parse(request.query);
    return requestResponseSchema.parse(await deps.requests.send(user.id, request.body));
  });
  for (const direction of ['incoming', 'outgoing'] as const) {
    app.get(`/api/requests/${direction}`, options, async (request) => {
      const user = await actor(request);
      return requestListResponseSchema.parse(await deps.requests.list(user.id, direction, requestListQuerySchema.parse(request.query)));
    });
  }
  app.get('/api/requests/summary', options, async (request) => {
    const user = await actor(request); emptyInputSchema.parse(request.query);
    return requestSummaryResponseSchema.parse(await deps.requests.summary(user.id));
  });
  app.get('/api/requests/:id', options, async (request) => {
    const user = await actor(request); emptyInputSchema.parse(request.query);
    return requestResponseSchema.parse(await deps.requests.detail(user.id, id(request.params)));
  });
  for (const action of ['accept', 'decline', 'cancel'] as const) {
    app.post(`/api/requests/:id/${action}`, options, async (request) => {
      const user = await actor(request); emptyInputSchema.parse(request.body ?? {}); emptyInputSchema.parse(request.query);
      return requestResponseSchema.parse(await deps.requests.resolve(user.id, id(request.params), action));
    });
  }
  for (const method of ['POST', 'DELETE'] as const) {
    app.route({ method, url: '/api/blocks/:profileId', ...options, handler: async (request) => {
      const user = await actor(request); emptyInputSchema.parse(request.body ?? {}); emptyInputSchema.parse(request.query);
      const parsed = blockProfileParamsSchema.safeParse(request.params);
      if (!parsed.success) throw method === 'POST' ? targetUnavailable() : new AppError(404, 'BLOCK_NOT_FOUND', 'The block was not found');
      return blockResponseSchema.parse(await deps.requests.block(user.id, parsed.data.profileId, method === 'POST'));
    } });
  }
}
