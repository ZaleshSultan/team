import type { PrismaClient } from '@prisma/client';
import type { FeedFilters, PublicPlayerCard } from '@squad/shared';
import { ZodError } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { cs2GameProvider } from '../games/cs2.js';
import type { GameProvider } from '../games/provider.js';
import { serializePublicPlayerCard } from '../profile/serializer.js';
import { buildFeedQuery, feedRowSource, type FeedPosition, type FeedRow } from './query.js';

export interface FeedPageInput {
  callerId: string; filters: FeedFilters; position: FeedPosition | null; limit: number; now: Date;
}
export interface FeedPage {
  items: PublicPlayerCard[]; hasMore: boolean; position: FeedPosition | null;
}

export class FeedService {
  constructor(private readonly prisma: PrismaClient,
    private readonly config: Pick<Config, 'AGE_MINIMUM' | 'RULES_VERSION'>,
    private readonly provider: GameProvider = cs2GameProvider) {}

  async listPage(input: FeedPageInput): Promise<FeedPage> {
    const game = await this.prisma.game.findUnique({ where: { slug: this.provider.slug }, select: { id: true } });
    if (!game) throw new AppError(503, 'GAME_UNAVAILABLE', 'The game catalog is unavailable');
    const valid: Array<{ item: PublicPlayerCard; position: FeedPosition }> = [];
    const batchSize = Math.max(100, input.limit + 1);
    let scanPosition = input.position;
    // Legacy published rows can predate provider validation. Scan in batches,
    // skip unsafe rows, and never expose them or issue per-player DB queries.
    while (valid.length <= input.limit) {
      const rows = await this.prisma.$queryRaw<FeedRow[]>(buildFeedQuery({ ...input, gameId: game.id,
        provider: this.provider, position: scanPosition, limit: batchSize,
        minimumAge: this.config.AGE_MINIMUM, rulesVersion: this.config.RULES_VERSION }));
      for (const row of rows) {
        try {
          valid.push({ item: serializePublicPlayerCard(feedRowSource(row)), position: { id: row.id, createdAt: row.createdAt } });
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'PROFILE_INVALID') && !(error instanceof ZodError)) throw error;
        }
        if (valid.length > input.limit) break;
      }
      if (valid.length > input.limit || rows.length < batchSize) break;
      const lastRow = rows.at(-1);
      if (!lastRow) break;
      scanPosition = { id: lastRow.id, createdAt: lastRow.createdAt };
    }
    const page = valid.slice(0, input.limit);
    return { items: page.map(({ item }) => item), hasMore: valid.length > input.limit,
      position: page.at(-1)?.position ?? null };
  }
}
