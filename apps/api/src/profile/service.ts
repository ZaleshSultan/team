import { Prisma, type PrismaClient } from '@prisma/client';
import { profileResponseSchema, publishResponseSchema, type ProfileResponse } from '@squad/shared';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { cs2GameProvider, ProfileValidationError } from '../games/cs2.js';
import { profileInput, publishRequirements } from './gate.js';
import { PublishGateError } from './errors.js';
import { serializePublicPlayerCard } from './serializer.js';

const includes = { steamAccount: true, faceitAccount: true, privacySettings: true,
  playerProfiles: { where: { game: { slug: 'cs2' } } },
  userGames: { where: { steamAppId: 730 } } } as const;
type ProfileUser = Prisma.UserGetPayload<{ include: typeof includes }>;
const transactionOptions = { maxWait: 10_000, timeout: 10_000 };

export class ProfileService {
  constructor(private readonly prisma: PrismaClient, private readonly config: Config) {}

  private response(user: ProfileUser): ProfileResponse {
    const profile = user.playerProfiles[0] ?? null;
    return profileResponseSchema.parse({
      profile: profile ? { ...profileInput(profile), id: profile.id, gameSlug: 'cs2', updatedAt: profile.updatedAt.toISOString() } : null,
      published: profile?.isPublished ?? false,
      requirements: publishRequirements(user, profile, cs2GameProvider, this.config),
      privacy: { shareSteamActivity: user.privacySettings?.shareSteamActivity ?? false },
      badges: cs2GameProvider.isVerified({ steamId64: user.steamAccount?.steamId64.toString() ?? null,
        faceitSteamId64: user.faceitAccount?.steamId64.toString() ?? null }), options: cs2GameProvider.profileOptions,
    });
  }

  private async user(userId: string, db: PrismaClient | Prisma.TransactionClient = this.prisma): Promise<ProfileUser> {
    const user = await db.user.findUnique({ where: { id: userId }, include: includes });
    if (!user) throw new AppError(401, 'SESSION_EXPIRED', 'The session has expired');
    return user;
  }

  get(userId: string) { return this.user(userId).then((user) => this.response(user)); }

  async save(userId: string, body: unknown): Promise<ProfileResponse> {
    // The route fixes the provider; clients cannot select another game's schema.
    if (body && typeof body === 'object' && !Array.isArray(body) && 'gameSlug' in body)
      throw new ProfileValidationError([{ code: 'UNKNOWN_FIELD', field: 'gameSlug' }]);
    const profile = cs2GameProvider.validateProfile(body && typeof body === 'object' && !Array.isArray(body)
      ? { ...body, gameSlug: 'cs2' } : body);
    const { gameSlug: _slug, ...data } = profile;
    return this.prisma.$transaction(async (tx) => {
      // Serialize against deletion, bans and concurrent publication. No network
      // requests take place while holding this short row lock.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const current = await this.user(userId, tx);
      if (current.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
      const game = await tx.game.findUnique({ where: { slug: cs2GameProvider.slug } });
      if (!game) throw new AppError(503, 'GAME_UNAVAILABLE', 'The game catalog is unavailable');
      await tx.playerProfile.upsert({ where: { userId_gameId: { userId, gameId: game.id } },
        create: { userId, gameId: game.id, ...data }, update: data });
      return this.response(await this.user(userId, tx));
    }, transactionOptions);
  }

  async publish(userId: string, published: boolean) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const user = await this.user(userId, tx);
      const profile = user.playerProfiles[0] ?? null;
      const requirements = publishRequirements(user, profile, cs2GameProvider, this.config);
      if (published && requirements.length) throw new PublishGateError(requirements);
      // Idempotent even without a profile, Steam, current consent or an active
      // account. A valid, unexpired owner session is still required.
      if (profile) await tx.playerProfile.update({ where: { id: profile.id }, data: { isPublished: published } });
      return publishResponseSchema.parse({ published, requirements });
    }, transactionOptions);
  }

  async preview(userId: string) {
    const user = await this.user(userId);
    const profile = user.playerProfiles[0];
    if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Save a profile before previewing it');
    return serializePublicPlayerCard({ profile, steam: user.steamAccount, faceit: user.faceitAccount,
      shareSteamActivity: user.privacySettings?.shareSteamActivity ?? false, cs2Game: user.userGames[0] ?? null });
  }
}
