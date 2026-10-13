import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { feedResponseSchema } from '@squad/shared';
import type { Config } from '../config.js';
import { requireSession } from '../auth/session.js';
import { cs2GameProvider } from '../games/cs2.js';
import { FeedAccessError, feedRequirements } from './access.js';
import { FeedCursorCodec } from './cursor.js';
import { parseFeedQuery } from './filters.js';
import { FeedService } from './service.js';

export async function registerFeedRoutes(app: FastifyInstance, deps: { prisma: PrismaClient; config: Config; now: () => Date }) {
  const { prisma, config, now } = deps;
  const provider = cs2GameProvider;
  const service = new FeedService(prisma, config, provider);
  const cursors = new FeedCursorCodec(config.BOT_TOKEN);
  app.get('/api/feed/cs2', { config: { rateLimit: { max: config.FEED_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (request) => {
    const user = await requireSession(request, deps);
    const query = parseFeedQuery(request.query, provider);
    const { cursor, limit, filters } = query;
    const ownProfile = config.FEED_REQUIRES_PUBLISHED_PROFILE
      ? await prisma.playerProfile.findFirst({ where: { userId: user.id, game: { slug: provider.slug }, isPublished: true }, select: { id: true } })
      : null;
    const requirements = feedRequirements(user, Boolean(ownProfile), config);
    if (requirements.length) throw new FeedAccessError(requirements);
    const scope = { callerId: user.id, gameSlug: provider.slug, filters };
    const position = cursor ? cursors.decode(cursor, scope) : null;
    const page = await service.listPage({ callerId: user.id, filters, position, limit, now: now() });
    return feedResponseSchema.parse({ items: page.items,
      nextCursor: page.hasMore && page.position ? cursors.encode(page.position, scope) : null });
  });
}
