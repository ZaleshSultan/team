import { Prisma, type PrismaClient } from '@prisma/client';
import { feedFiltersSchema, reportInputSchema, reportResponseSchema,
  type BlockListResponse, type ReportResponse } from '@squad/shared';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { FeedCursorCodec } from '../feed/cursor.js';
import { buildFeedQuery, feedRowSource, type FeedRow } from '../feed/query.js';
import { cs2GameProvider } from '../games/cs2.js';
import { serializePublicPlayerCard } from '../profile/serializer.js';

const DAY_MS = 86_400_000;
export const REPORT_DUPLICATE_WINDOW_MS = DAY_MS;
export const REPORT_AUTO_HIDE_WINDOW_MS = 7 * DAY_MS;
export const REPORTER_MINIMUM_AGE_MS = DAY_MS;
type Tx = Prisma.TransactionClient;
const actorSelect = { id: true, isBanned: true, username: true, ageConfirmedAt: true, ageMinimumConfirmed: true,
  rulesAcceptedAt: true, rulesVersion: true, steamAccount: { select: { userId: true } },
  playerProfiles: { where: { game: { slug: 'cs2' } }, select: { isPublished: true, moderationHidden: true } } } as const;
type Actor = Prisma.UserGetPayload<{ select: typeof actorSelect }>;
const targetNotFound = () => new AppError(404, 'REPORT_TARGET_NOT_FOUND', 'The report target was not found');

export class DailyReportLimitError extends AppError {
  constructor(readonly resetAt: string) {
    super(429, 'REPORT_DAILY_LIMIT_REACHED', 'The daily report limit has been reached');
  }
}

/** State changes always lock both user rows in UUID order. The reporter lock
 * serializes their quota; the target lock serializes distinct-reporter counts. */
export class ReportService {
  private readonly cursors: FeedCursorCodec;
  constructor(private readonly prisma: PrismaClient, private readonly config: Config,
    private readonly dispatch: () => Promise<unknown> = async () => undefined,
    private readonly now: () => Date = () => new Date()) {
    this.cursors = new FeedCursorCodec(config.BOT_TOKEN);
  }
  private actor(user: Actor | null) {
    if (!user) throw new AppError(401, 'SESSION_EXPIRED', 'The session has expired');
    if (user.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
    if (!user.username?.trim() || !user.ageConfirmedAt || user.ageMinimumConfirmed !== this.config.AGE_MINIMUM
      || !user.rulesAcceptedAt || user.rulesVersion !== this.config.RULES_VERSION) {
      throw new AppError(403, 'ONBOARDING_INCOMPLETE', 'Complete onboarding before using reports');
    }
    return user;
  }
  private async visible(tx: Tx, caller: Actor, profileId: string, targetId: string, gameId: string, now: Date) {
    // Request participants retain a legitimate moderation path after publication,
    // consent, ban or block state changes. A guessed foreign request is never used.
    const history = await tx.teammateRequest.findFirst({ where: { OR: [
      { fromUserId: caller.id, toUserId: targetId }, { fromUserId: targetId, toUserId: caller.id },
    ] }, select: { id: true } });
    if (history) return true;
    if (!caller.steamAccount || (this.config.FEED_REQUIRES_PUBLISHED_PROFILE
      && !caller.playerProfiles.some((profile) => profile.isPublished && !profile.moderationHidden))) return false;
    const rows = await tx.$queryRaw<FeedRow[]>(buildFeedQuery({ gameId, callerId: caller.id,
      provider: cs2GameProvider, filters: feedFiltersSchema.parse({ noBans: false }), position: null,
      limit: 1, now, minimumAge: this.config.AGE_MINIMUM, rulesVersion: this.config.RULES_VERSION,
      targetProfileId: profileId }));
    if (!rows[0]) return false;
    try { serializePublicPlayerCard(feedRowSource(rows[0])); return true; } catch { return false; }
  }
  async report(callerId: string, raw: unknown): Promise<ReportResponse> {
    const input = reportInputSchema.parse(raw);
    const response = await this.prisma.$transaction(async (tx) => {
      const sourceRequest = input.requestId ? await tx.teammateRequest.findFirst({ where: {
        id: input.requestId, OR: [{ fromUserId: callerId }, { toUserId: callerId }],
      }, select: { id: true, fromUserId: true, toUserId: true, gameId: true } }) : null;
      const sourceProfile = input.profileId ? await tx.playerProfile.findFirst({ where: {
        id: input.profileId, game: { slug: 'cs2' },
      }, select: { id: true, userId: true, gameId: true } }) : null;
      if (!sourceRequest && !sourceProfile) throw targetNotFound();
      const targetId = sourceRequest ? sourceRequest.fromUserId === callerId ? sourceRequest.toUserId : sourceRequest.fromUserId : sourceProfile!.userId;
      if (targetId === callerId) throw new AppError(409, 'REPORT_SELF', 'You cannot report yourself');
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id IN (${callerId}::uuid, ${targetId}::uuid) ORDER BY id FOR UPDATE`);
      const caller = this.actor(await tx.user.findUnique({ where: { id: callerId }, select: actorSelect }));
      if (!await tx.user.findUnique({ where: { id: targetId }, select: { id: true } })) throw targetNotFound();
      const now = this.now();
      const existing = await tx.report.findFirst({ where: { reporterUserId: callerId, reportedUserId: targetId,
        status: 'OPEN', createdAt: { gt: new Date(now.getTime() - REPORT_DUPLICATE_WINDOW_MS) } },
        select: { id: true, status: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      // Return the committed result even if auto-protection has since hidden the
      // target. Duplicate retries neither consume quota nor re-notify admins.
      if (existing) return reportResponseSchema.parse({ report: { ...existing, createdAt: existing.createdAt.toISOString() }, duplicate: true });
      if (sourceRequest) {
        // Retention may delete old terminal requests. Hold a key-share row lock
        // before attaching the report FK; a concurrent cleanup then skips it.
        await tx.$queryRaw(Prisma.sql`SELECT id FROM teammate_requests WHERE id = ${sourceRequest.id}::uuid FOR KEY SHARE`);
        const owned = await tx.teammateRequest.findFirst({ where: { id: sourceRequest.id,
          OR: [{ fromUserId: callerId }, { toUserId: callerId }] }, select: { id: true } });
        if (!owned) throw targetNotFound();
      } else if (!await this.visible(tx, caller, sourceProfile!.id, targetId, sourceProfile!.gameId, now)) throw targetNotFound();
      const recent = await tx.report.findMany({ where: { reporterUserId: callerId, createdAt: { gt: new Date(now.getTime() - DAY_MS) } },
        select: { createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: this.config.REPORTS_PER_DAY });
      if (recent.length >= this.config.REPORTS_PER_DAY) throw new DailyReportLimitError(new Date(recent.at(-1)!.createdAt.getTime() + DAY_MS).toISOString());
      const report = await tx.report.create({ data: { reporterUserId: callerId, reportedUserId: targetId,
        gameId: sourceRequest?.gameId ?? sourceProfile!.gameId, requestId: sourceRequest?.id ?? null,
        reason: input.reason, details: input.details || null, createdAt: now }, select: { id: true, status: true, createdAt: true } });
      const qualifying = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT count(DISTINCT r.reporter_user_id) AS count FROM reports r
        JOIN users reporter ON reporter.id = r.reporter_user_id
        JOIN steam_accounts steam ON steam.user_id = reporter.id
        WHERE r.reported_user_id = ${targetId}::uuid AND r.created_at >= ${new Date(now.getTime() - REPORT_AUTO_HIDE_WINDOW_MS)}
          AND r.status <> 'DISMISSED' AND reporter.is_banned = false
          AND reporter.created_at < ${new Date(now.getTime() - REPORTER_MINIMUM_AGE_MS)}`);
      if (Number(qualifying[0]?.count ?? 0) >= this.config.REPORTS_AUTO_HIDE_THRESHOLD) {
        await tx.$executeRaw(Prisma.sql`UPDATE player_profiles
          SET moderation_was_published = moderation_was_published OR is_published,
            is_published = false, moderation_hidden = true, updated_at = ${now}
          WHERE user_id = ${targetId}::uuid`);
        await tx.user.update({ where: { id: targetId }, data: { moderationFlaggedAt: now } });
      }
      const admins = [...new Set(this.config.ADMIN_TELEGRAM_IDS)];
      if (admins.length) await tx.moderationNotification.createMany({ data: admins.map((id) => ({
        kind: 'ADMIN_REPORT' as const, reportId: report.id, recipientTelegramId: BigInt(id), createdAt: now,
      })) });
      return reportResponseSchema.parse({ report: { ...report, createdAt: report.createdAt.toISOString() }, duplicate: false });
    }, { maxWait: 10_000, timeout: 10_000 });
    if (!response.duplicate) { try { void this.dispatch().catch(() => undefined); } catch { /* Durable outbox retries later. */ } }
    return response;
  }
  async listBlocks(callerId: string, query: { limit: number; cursor?: string }): Promise<BlockListResponse> {
    this.actor(await this.prisma.user.findUnique({ where: { id: callerId }, select: actorSelect }));
    const scope = { callerId, gameSlug: 'blocks:cs2', filters: {} };
    const position = query.cursor ? this.cursors.decode(query.cursor, scope) : null;
    const rows = await this.prisma.block.findMany({ where: { blockerUserId: callerId,
      blockedUser: { playerProfiles: { some: { game: { slug: 'cs2' } } } },
      ...(position ? { OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { lt: position.id } }] } : {}),
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
    select: { id: true, createdAt: true, blockedUser: { select: {
      steamAccount: true, faceitAccount: true, privacySettings: { select: { shareSteamActivity: true } },
      playerProfiles: { where: { game: { slug: 'cs2' } } },
      userGames: { where: { steamAppId: 730 }, select: { playtimeTotal: true, playtime2weeks: true } },
    } } } });
    const page = rows.slice(0, query.limit); const last = page.at(-1);
    return { items: page.map((row) => {
      const source = row.blockedUser; const profile = source.playerProfiles[0]!;
      let player = null;
      try { player = serializePublicPlayerCard({ profile, steam: source.steamAccount, faceit: source.faceitAccount,
        shareSteamActivity: source.privacySettings?.shareSteamActivity ?? false, cs2Game: source.userGames[0] ?? null }); } catch { /* Keep unblock available for unsafe legacy profiles. */ }
      return { profileId: profile.id, player, createdAt: row.createdAt.toISOString() };
    }), nextCursor: rows.length > query.limit && last ? this.cursors.encode({ id: last.id, createdAt: last.createdAt }, scope) : null };
  }
}
