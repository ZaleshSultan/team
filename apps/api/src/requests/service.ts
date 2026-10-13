import { Prisma, type PrismaClient, type TeammateRequest } from '@prisma/client';
import { requestMessageSchema, requestItemSchema, requestResponseSchema, sendRequestInputSchema,
  TelegramContactError, type RequestItem, type RequestResponse, type RequestListResponse } from '@squad/shared';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { DECLINED_REQUEST_COOLDOWN_DAYS } from '../feed/query.js';
import { FeedCursorCodec } from '../feed/cursor.js';
import { serializePublicPlayerCard } from '../profile/serializer.js';
import { DailyRequestLimitError, contactUnavailable, requestNotFound, targetUnavailable } from './errors.js';

const participantIncludes = { steamAccount: true, faceitAccount: true, privacySettings: true,
  playerProfiles: { where: { game: { slug: 'cs2' } } }, userGames: { where: { steamAppId: 730 } } } as const;
type Participant = Prisma.UserGetPayload<{ include: typeof participantIncludes }>;
type RequestWithUsers = Prisma.TeammateRequestGetPayload<{ include: { fromUser: { include: typeof participantIncludes }; toUser: { include: typeof participantIncludes } } }>;
type Tx = Prisma.TransactionClient;
type Direction = 'incoming' | 'outgoing';
const transactionOptions = { maxWait: 10_000, timeout: 10_000 };
const pairWhere = (first: string, second: string) => ({ OR: [
  { fromUserId: first, toUserId: second }, { fromUserId: second, toUserId: first },
] });
const blockedWhere = (first: string, second: string) => ({ OR: [
  { blockerUserId: first, blockedUserId: second }, { blockerUserId: second, blockedUserId: first },
] });

/** Every pair mutation locks users in UUID order before taking any request lock. */
async function lockUsers(tx: Tx, first: string, second: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id IN (${first}::uuid, ${second}::uuid) ORDER BY id FOR UPDATE`);
}

export interface RequestContacts { getUsername(telegramId: string): Promise<string> }
export class RequestService {
  private readonly cursors: FeedCursorCodec;
  constructor(private readonly prisma: PrismaClient, private readonly config: Config,
    private readonly contacts: RequestContacts, private readonly dispatch: () => Promise<unknown> = async () => undefined,
    private readonly now: () => Date = () => new Date()) { this.cursors = new FeedCursorCodec(config.BOT_TOKEN); }

  private consent(user: Participant) {
    return Boolean(user.username?.trim()) && user.ageConfirmedAt !== null && user.ageMinimumConfirmed === this.config.AGE_MINIMUM
      && user.rulesAcceptedAt !== null && user.rulesVersion === this.config.RULES_VERSION;
  }
  private actor(user: Participant | null) {
    if (!user) throw new AppError(401, 'SESSION_EXPIRED', 'The session has expired');
    if (user.isBanned) throw new AppError(403, 'USER_BANNED', 'This account is banned');
    if (!this.consent(user)) throw new AppError(403, 'ONBOARDING_INCOMPLETE', 'Complete onboarding before using requests');
    return user;
  }
  private sender(user: Participant | null) {
    const current = this.actor(user);
    if (!current.steamAccount) throw new AppError(409, 'STEAM_REQUIRED', 'Link Steam before sending requests');
    if (!current.playerProfiles[0]?.isPublished || !this.card(current)) throw new AppError(409, 'PUBLISHED_PROFILE_REQUIRED', 'Publish a valid profile first');
    if (current.botBlocked) throw contactUnavailable();
    return current;
  }
  private eligible(user: Participant | null) {
    return Boolean(user && !user.isBanned && !user.botBlocked && this.consent(user)
      && user.steamAccount && user.playerProfiles[0]?.isPublished && this.card(user));
  }
  private card(user: Participant) {
    const profile = user.playerProfiles[0];
    if (!profile || user.isBanned) return null;
    try { return serializePublicPlayerCard({ profile, steam: user.steamAccount, faceit: user.faceitAccount,
      shareSteamActivity: user.privacySettings?.shareSteamActivity ?? false, cs2Game: user.userGames[0] ?? null }); }
    catch { return null; }
  }
  private item(request: TeammateRequest, other: Participant): RequestItem {
    const message = requestMessageSchema.safeParse(request.message);
    return requestItemSchema.parse({ id: request.id,
      status: request.status === 'PENDING' && request.expiresAt <= this.now() ? 'EXPIRED' : request.status,
      message: message.success ? message.data : null, createdAt: request.createdAt.toISOString(),
      resolvedAt: request.resolvedAt?.toISOString() ?? null, expiresAt: request.expiresAt.toISOString(), player: this.card(other) });
  }
  private notify() {
    // Redis downtime must not delay an already committed request response.
    try { void this.dispatch().catch(() => undefined); } catch { /* Maintenance retries the durable outbox. */ }
  }
  private async participant(tx: Tx | PrismaClient, id: string) {
    return tx.user.findUnique({ where: { id }, include: participantIncludes });
  }
  private async expirePair(tx: Tx, first: string, second: string, now: Date) {
    await tx.teammateRequest.updateMany({ where: { ...pairWhere(first, second), status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED', resolvedAt: now } });
  }

  async send(callerId: string, raw: unknown): Promise<RequestResponse> {
    const input = sendRequestInputSchema.parse(raw);
    const value = await this.prisma.$transaction(async (tx) => {
      const targetProfile = await tx.playerProfile.findUnique({ where: { id: input.toProfileId }, select: { userId: true, gameId: true, game: { select: { slug: true } } } });
      if (!targetProfile || targetProfile.game.slug !== 'cs2') throw targetUnavailable();
      if (targetProfile.userId === callerId) throw new AppError(409, 'REQUEST_SELF', 'You cannot send a request to yourself');
      await lockUsers(tx, callerId, targetProfile.userId);
      const sender = this.sender(await this.participant(tx, callerId));
      const target = await this.participant(tx, targetProfile.userId);
      if (!this.eligible(target)) throw targetUnavailable();
      const now = this.now();
      await this.expirePair(tx, callerId, target!.id, now);
      if (await tx.block.findFirst({ where: blockedWhere(callerId, target!.id), select: { id: true } })) throw targetUnavailable();
      const active = await tx.teammateRequest.findMany({ where: { ...pairWhere(callerId, target!.id), status: { in: ['PENDING', 'ACCEPTED'] } }, select: { status: true, fromUserId: true } });
      if (active.some((request) => request.status === 'PENDING' && request.fromUserId === target!.id)) throw new AppError(409, 'REQUEST_ALREADY_RECEIVED', 'Accept the incoming request instead');
      if (active.some((request) => request.status === 'ACCEPTED')) throw new AppError(409, 'REQUEST_ALREADY_ACCEPTED', 'A request with this player is already accepted');
      if (active.length) throw new AppError(409, 'REQUEST_ALREADY_SENT', 'A request has already been sent');
      const recentDecline = await tx.teammateRequest.findFirst({ where: { fromUserId: callerId, toUserId: target!.id, status: 'DECLINED',
        resolvedAt: { gte: new Date(now.getTime() - DECLINED_REQUEST_COOLDOWN_DAYS * 86_400_000) } }, select: { id: true } });
      if (recentDecline) throw new AppError(409, 'REQUEST_DECLINED_RECENTLY', 'Please wait before inviting this player again');
      // The sender row lock serializes sends to different targets as well.
      const recent = await tx.teammateRequest.findMany({ where: { fromUserId: callerId, createdAt: { gt: new Date(now.getTime() - 86_400_000) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: this.config.REQUESTS_PER_DAY, select: { createdAt: true } });
      if (recent.length >= this.config.REQUESTS_PER_DAY) throw new DailyRequestLimitError(new Date(recent.at(-1)!.createdAt.getTime() + 86_400_000).toISOString());
      const request = await tx.teammateRequest.create({ data: { fromUserId: sender.id, toUserId: target!.id, gameId: targetProfile.gameId,
        message: input.message || null, createdAt: now, expiresAt: new Date(now.getTime() + this.config.REQUEST_TTL_DAYS * 86_400_000) } });
      await tx.requestNotification.create({ data: { requestId: request.id, recipientUserId: target!.id, kind: 'CREATED' } });
      return requestResponseSchema.parse({ request: this.item(request, target!) });
    }, transactionOptions);
    this.notify(); return value;
  }

  async list(callerId: string, direction: Direction, query: { limit: number; cursor?: string }): Promise<RequestListResponse> {
    this.actor(await this.participant(this.prisma, callerId));
    const scope = { callerId, gameSlug: `requests:${direction}`, filters: {} };
    const position = query.cursor ? this.cursors.decode(query.cursor, scope) : null;
    const rows = await this.prisma.teammateRequest.findMany({ where: {
      ...(direction === 'incoming' ? { toUserId: callerId } : { fromUserId: callerId }),
      ...(position ? { OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { lt: position.id } }] } : {}),
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
    include: { fromUser: { include: participantIncludes }, toUser: { include: participantIncludes } } });
    const page = rows.slice(0, query.limit); const last = page.at(-1);
    return { items: page.map((request) => this.item(request, direction === 'incoming' ? request.fromUser : request.toUser)),
      nextCursor: rows.length > query.limit && last ? this.cursors.encode({ id: last.id, createdAt: last.createdAt }, scope) : null };
  }

  async summary(callerId: string) {
    this.actor(await this.participant(this.prisma, callerId));
    return { pendingIncoming: await this.prisma.teammateRequest.count({ where: { toUserId: callerId, status: 'PENDING', expiresAt: { gt: this.now() } } }) };
  }
  private async owned(callerId: string, id: string): Promise<RequestWithUsers> {
    const request = await this.prisma.teammateRequest.findFirst({ where: { id, OR: [{ fromUserId: callerId }, { toUserId: callerId }] },
      include: { fromUser: { include: participantIncludes }, toUser: { include: participantIncludes } } });
    if (!request) throw requestNotFound(); return request;
  }
  private async username(user: Participant) {
    if (user.isBanned || user.botBlocked || !this.consent(user)) throw contactUnavailable();
    try { return await this.contacts.getUsername(user.telegramId.toString()); }
    catch (error) {
      if (error instanceof TelegramContactError && error.blocked) await this.prisma.user.updateMany({ where: { id: user.id }, data: { botBlocked: true } });
      throw contactUnavailable();
    }
  }
  async detail(callerId: string, id: string): Promise<RequestResponse> {
    const before = await this.owned(callerId, id);
    this.actor(before.fromUserId === callerId ? before.fromUser : before.toUser);
    const other = before.fromUserId === callerId ? before.toUser : before.fromUser;
    if (before.status !== 'ACCEPTED') return requestResponseSchema.parse({ request: this.item(before, other) });
    const username = await this.username(other);
    // Recheck ownership/blocks/flags after the external call, so a concurrent
    // block or deletion cannot reveal a contact on a previously read request.
    return this.prisma.$transaction(async (tx) => {
      await lockUsers(tx, before.fromUserId, before.toUserId);
      const current = await tx.teammateRequest.findFirst({ where: { id, status: 'ACCEPTED', OR: [{ fromUserId: callerId }, { toUserId: callerId }] } });
      if (!current) throw requestNotFound();
      this.actor(await this.participant(tx, callerId));
      const target = await this.participant(tx, other.id);
      if (!target || !this.consent(target) || target.isBanned || target.botBlocked
        || await tx.block.findFirst({ where: blockedWhere(callerId, other.id), select: { id: true } })) throw contactUnavailable();
      return requestResponseSchema.parse({ request: this.item(current, target), contact: { username } });
    }, transactionOptions);
  }

  async resolve(callerId: string, id: string, action: 'accept' | 'decline' | 'cancel'): Promise<RequestResponse> {
    const before = await this.owned(callerId, id);
    if (action === 'cancel' ? before.fromUserId !== callerId : before.toUserId !== callerId) throw requestNotFound();
    this.actor(action === 'cancel' ? before.fromUser : before.toUser);
    // Do not call Telegram for an already resolved/expired request.
    let username: string | undefined;
    if (action === 'accept' && before.status === 'PENDING' && before.expiresAt > this.now()) {
      if (await this.prisma.block.findFirst({ where: blockedWhere(before.fromUserId, before.toUserId), select: { id: true } })) throw contactUnavailable();
      [username] = await Promise.all([this.username(before.fromUser), this.username(before.toUser)]);
    }
    const result = await this.prisma.$transaction(async (tx) => {
      await lockUsers(tx, before.fromUserId, before.toUserId);
      await tx.$queryRaw`SELECT id FROM teammate_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.teammateRequest.findUnique({ where: { id } });
      if (!current || (action === 'cancel' ? current.fromUserId !== callerId : current.toUserId !== callerId)) throw requestNotFound();
      this.actor(await this.participant(tx, callerId));
      const now = this.now();
      if (current.status !== 'PENDING') throw new AppError(409, 'REQUEST_NOT_PENDING', 'This request is already resolved');
      if (current.expiresAt <= now) {
        await tx.teammateRequest.update({ where: { id }, data: { status: 'EXPIRED', resolvedAt: now } });
        return { expired: true as const };
      }
      const other = await this.participant(tx, action === 'cancel' ? current.toUserId : current.fromUserId);
      if (!other) throw requestNotFound();
      if (action === 'accept' && (!this.eligible(other) || !this.eligible(await this.participant(tx, callerId))
        || await tx.block.findFirst({ where: blockedWhere(callerId, other.id), select: { id: true } }))) throw contactUnavailable();
      const request = await tx.teammateRequest.update({ where: { id }, data: { status: action === 'accept' ? 'ACCEPTED' : action === 'decline' ? 'DECLINED' : 'CANCELED', resolvedAt: now } });
      if (action === 'accept') await tx.requestNotification.create({ data: { requestId: id, recipientUserId: current.fromUserId, kind: 'ACCEPTED' } });
      return { expired: false as const, response: requestResponseSchema.parse({ request: this.item(request, other), ...(action === 'accept' ? { contact: { username } } : {}) }) };
    }, transactionOptions);
    if (result.expired) throw new AppError(409, 'REQUEST_EXPIRED', 'This request has expired');
    if (action === 'accept') this.notify();
    return result.response;
  }

  async block(callerId: string, profileId: string, blocked: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.playerProfile.findUnique({ where: { id: profileId }, select: { userId: true, game: { select: { slug: true } } } });
      if (!profile || profile.game.slug !== 'cs2') throw targetUnavailable();
      if (profile.userId === callerId) throw new AppError(409, 'BLOCK_SELF', 'You cannot block yourself');
      await lockUsers(tx, callerId, profile.userId);
      this.sender(await this.participant(tx, callerId));
      if (blocked) {
        if (!this.eligible(await this.participant(tx, profile.userId))) throw targetUnavailable();
        await tx.block.upsert({ where: { blockerUserId_blockedUserId: { blockerUserId: callerId, blockedUserId: profile.userId } },
          create: { blockerUserId: callerId, blockedUserId: profile.userId }, update: {} });
        await tx.teammateRequest.updateMany({ where: { ...pairWhere(callerId, profile.userId), status: 'PENDING' }, data: { status: 'CANCELED', resolvedAt: this.now() } });
      } else {
        const removed = await tx.block.deleteMany({ where: { blockerUserId: callerId, blockedUserId: profile.userId } });
        if (!removed.count) throw new AppError(404, 'BLOCK_NOT_FOUND', 'The block was not found');
      }
      return { blocked };
    }, transactionOptions);
  }
}
