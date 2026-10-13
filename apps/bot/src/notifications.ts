import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeProfileText, notificationJobSchema, NOTIFICATION_CLAIM_MS, profileTextError, roleSchema,
  TelegramContactError, telegramUsernameSchema, type TelegramMessage, type TelegramNotificationClient } from '@squad/shared';
import type { BotConfig } from './config.js';
import ru from './locales/ru.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };

export class NotificationRetryError extends Error {
  constructor(readonly retryAfterMs = 0, readonly rateLimited = false) {
    super('NOTIFICATION_DELIVERY_FAILED'); this.name = 'NotificationRetryError';
  }
}

export interface NotificationSummary {
  nickname: string | null; personaName: string | null; roles: string[];
  steamId64: bigint | null; faceitSteamId64: bigint | null; faceitLevel: number | null;
}

function safeName(value: string | null): string | null {
  const text = value === null ? null : normalizeProfileText(value);
  return text && profileTextError('nickname', text) === null ? text : null;
}

/** Only the public summary is rendered. The optional accepted contact is freshly
 * re-checked by the processor and never persisted in Redis or request rows. */
export function buildNotificationMessage(kind: 'CREATED' | 'ACCEPTED', summary: NotificationSummary,
  language: string, miniappUrl: string, username?: string): TelegramMessage {
  const messages = language.startsWith('en') ? en : ru;
  const nickname = safeName(summary.nickname) ?? safeName(summary.personaName) ?? messages.teammate;
  const lines: string[] = [];
  if (kind === 'ACCEPTED') {
    if (!telegramUsernameSchema.safeParse(username).success) throw new TelegramContactError(false, 0, false);
    lines.push(messages.acceptedRequest.replace('{nickname}', nickname).replace('{username}', username!));
  } else {
    lines.push(messages.newRequest.replace('{nickname}', nickname));
    const roles = summary.roles.flatMap((role) => {
      const parsed = roleSchema.safeParse(role);
      return parsed.success ? [messages.roles[parsed.data]] : [];
    });
    if (roles.length) lines.push(messages.rolesLabel.replace('{roles}', [...new Set(roles)].join(', ')));
    if (summary.steamId64 !== null && summary.steamId64 >= 76_561_197_960_265_729n && summary.steamId64 <= 76_561_202_255_233_023n
      && summary.faceitSteamId64 === summary.steamId64
      && summary.faceitLevel !== null && Number.isInteger(summary.faceitLevel) && summary.faceitLevel >= 1 && summary.faceitLevel <= 10) {
      lines.push(messages.faceitLabel.replace('{level}', String(summary.faceitLevel)));
    }
  }
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [[{ text: messages.open, web_app: { url: miniappUrl } }]] },
    link_preview_options: { is_disabled: true } };
}

const notificationUserSelect = {
  id: true, telegramId: true, language: true, isBanned: true, botBlocked: true,
  ageConfirmedAt: true, ageMinimumConfirmed: true, rulesAcceptedAt: true, rulesVersion: true,
  steamAccount: { select: { steamId64: true, personaName: true } },
  faceitAccount: { select: { steamId64: true, level: true } },
  playerProfiles: { where: { game: { slug: 'cs2' } }, select: { nickname: true, roles: true, isPublished: true }, take: 1 },
} as const;

export class RequestNotificationProcessor {
  constructor(private readonly prisma: PrismaClient, private readonly config: BotConfig,
    private readonly telegram: TelegramNotificationClient, private readonly now: () => Date = () => new Date()) {}

  async process(job: { name: string; data: unknown; attemptsMade: number }): Promise<void> {
    const parsed = notificationJobSchema.safeParse(job.data);
    if (job.name !== 'request-notification' || !parsed.success) return;
    const { eventId } = parsed.data;
    const now = this.now();
    const claimToken = randomUUID();
    try {
      const claim = await this.prisma.requestNotification.updateMany({ where: { id: eventId, deliveredAt: null,
        OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] },
        data: { claimToken, claimedUntil: new Date(now.getTime() + NOTIFICATION_CLAIM_MS) } });
      if (!claim.count) {
        const existing = await this.prisma.requestNotification.findUnique({ where: { id: eventId },
          select: { deliveredAt: true, claimedUntil: true } });
        if (!existing || existing.deliveredAt) return;
        // A stalled BullMQ job may be retried before this DB lease expires.
        // Completing that retry here could permanently lose an undelivered event.
        throw new NotificationRetryError(Math.max(1_000, Math.min(NOTIFICATION_CLAIM_MS,
          (existing.claimedUntil?.getTime() ?? now.getTime() + 1_000) - now.getTime())));
      }
      // All state-changing request/block operations lock these same users before
      // the request. Holding them through Telegram delivery prevents a committed
      // block from being followed by disclosure of an accepted contact.
      await this.prisma.$transaction(async (transaction) => {
        const initial = await transaction.requestNotification.findUnique({ where: { id: eventId },
          select: { request: { select: { fromUserId: true, toUserId: true } } } });
        if (!initial) return;
        const ids = [initial.request.fromUserId, initial.request.toUserId].sort();
        await transaction.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`);
        const event = await transaction.requestNotification.findUnique({ where: { id: eventId }, include: { request: {
          include: { fromUser: { select: notificationUserSelect }, toUser: { select: notificationUserSelect }, game: { select: { slug: true } } },
        } } });
        if (!event || event.deliveredAt || event.claimToken !== claimToken) return;
        await transaction.$queryRaw(Prisma.sql`SELECT id FROM teammate_requests WHERE id = ${event.requestId}::uuid FOR UPDATE`);
        // Re-read status after the request row lock: expiry has no user locks.
        const current = await transaction.teammateRequest.findUnique({ where: { id: event.requestId }, select: { status: true, expiresAt: true } });
        const settle = () => transaction.requestNotification.updateMany({ where: { id: eventId, claimToken, deliveredAt: null },
          data: { deliveredAt: this.now(), claimToken: null, claimedUntil: null } });
        const request = event.request;
        const recipient = event.kind === 'CREATED' ? request.toUser : request.fromUser;
        const other = event.kind === 'CREATED' ? request.fromUser : request.toUser;
        const expectedStatus = event.kind === 'CREATED' ? 'PENDING' : 'ACCEPTED';
        if (!current || current.status !== expectedStatus || request.game.slug !== 'cs2'
          || event.recipientUserId !== recipient.id || recipient.isBanned || recipient.botBlocked || other.isBanned || other.botBlocked
          || (event.kind === 'CREATED' && current.expiresAt <= this.now())
          || !recipient.ageConfirmedAt || recipient.ageMinimumConfirmed !== this.config.AGE_MINIMUM
          || !other.ageConfirmedAt || other.ageMinimumConfirmed !== this.config.AGE_MINIMUM
          || !recipient.rulesAcceptedAt || recipient.rulesVersion !== this.config.RULES_VERSION
          || !other.rulesAcceptedAt || other.rulesVersion !== this.config.RULES_VERSION
          || job.attemptsMade >= this.config.NOTIFICATION_MAX_ATTEMPTS) { await settle(); return; }
        const blocked = await transaction.block.findFirst({ where: { OR: [
          { blockerUserId: recipient.id, blockedUserId: other.id }, { blockerUserId: other.id, blockedUserId: recipient.id },
        ] }, select: { id: true } });
        if (blocked || (event.kind === 'CREATED' && (!recipient.steamAccount || !other.steamAccount
          || !recipient.playerProfiles[0]?.isPublished || !other.playerProfiles[0]?.isPublished))) { await settle(); return; }
        let username: string | undefined;
        if (event.kind === 'ACCEPTED') {
          try { username = await this.telegram.getUsername(other.telegramId.toString()); }
          catch (error) {
            if (error instanceof TelegramContactError && error.blocked) {
              await transaction.user.updateMany({ where: { id: other.id }, data: { botBlocked: true } });
              await settle(); return;
            }
            if (error instanceof TelegramContactError && !error.retryable) { await settle(); return; }
            throw error;
          }
        }
        const summary: NotificationSummary = { nickname: other.playerProfiles[0]?.nickname ?? null,
          personaName: other.steamAccount?.personaName ?? null, roles: other.playerProfiles[0]?.roles ?? [],
          steamId64: other.steamAccount?.steamId64 ?? null, faceitSteamId64: other.faceitAccount?.steamId64 ?? null,
          faceitLevel: other.faceitAccount?.level ?? null };
        try { await this.telegram.sendMessage(recipient.telegramId.toString(),
          buildNotificationMessage(event.kind, summary, recipient.language, this.config.MINIAPP_URL, username)); }
        catch (error) {
          if (error instanceof TelegramContactError && error.blocked) {
            await transaction.user.updateMany({ where: { id: recipient.id }, data: { botBlocked: true } });
            await settle(); return;
          }
          if (error instanceof TelegramContactError && !error.retryable) { await settle(); return; }
          throw error;
        }
        await settle();
      }, { maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      const lastAttempt = job.attemptsMade + 1 >= this.config.NOTIFICATION_MAX_ATTEMPTS;
      await this.prisma.requestNotification.updateMany({ where: { id: eventId, claimToken, deliveredAt: null },
        data: { claimToken: null, claimedUntil: null, ...(lastAttempt ? { deliveredAt: this.now() } : {}) } }).catch(() => undefined);
      // BullMQ persists failedReason/stacktrace; only a fixed exception reaches it.
      throw error instanceof NotificationRetryError ? error
        : new NotificationRetryError(error instanceof TelegramContactError ? error.retryAfterMs : 0,
          error instanceof TelegramContactError && error.retryAfterMs > 0);
    }
  }
}
