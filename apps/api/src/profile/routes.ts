import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { meResponseSchema, privacyInputSchema, publishInputSchema } from '@squad/shared';
import type { Config } from '../config.js';
import { requireSession } from '../auth/session.js';
import { toAuthUser } from '../auth/routes.js';
import { AppError } from '../errors.js';
import { ProfileService } from './service.js';

export async function registerProfileRoutes(app: FastifyInstance, deps: { prisma: PrismaClient; config: Config; now: () => Date }) {
  const { prisma, config, now } = deps;
  const service = new ProfileService(prisma, config);
  app.get('/api/me/profile/cs2', async (request) => service.get((await requireSession(request, deps)).id));
  app.put('/api/me/profile/cs2', async (request) => service.save((await requireSession(request, deps)).id, request.body));
  app.get('/api/me/profile/cs2/preview', async (request) => service.preview((await requireSession(request, deps)).id));
  app.put('/api/me/profile/cs2/publish', async (request) => {
    const user = await requireSession(request, deps, { allowBanned: true });
    const { published } = publishInputSchema.parse(request.body);
    return service.publish(user.id, published);
  });
  app.patch('/api/me/privacy', async (request) => {
    const session = await requireSession(request, { prisma, now });
    const body = privacyInputSchema.parse(request.body);
    const user = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${session.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: session.id } });
      if (!current) throw new AppError(401, 'SESSION_EXPIRED', 'The session has expired');
      if (current.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
      return tx.user.update({ where: { id: session.id }, data: { privacySettings: {
        upsert: { create: body, update: body },
      } }, include: { steamAccount: true, privacySettings: true } });
    }, { maxWait: 10_000, timeout: 10_000 });
    return meResponseSchema.parse({ user: toAuthUser(user, config) });
  });
}
