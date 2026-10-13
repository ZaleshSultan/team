import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { moderationNotificationJobSchema, NOTIFICATION_CLAIM_MS, TelegramContactError, type TelegramMessage, type TelegramNotificationClient } from '@squad/shared';
import type { BotConfig } from './config.js';
import { NotificationRetryError } from './notifications.js';
import { botMessages } from './handlers.js';

export class ModerationNotificationProcessor {
  constructor(private readonly prisma: PrismaClient, private readonly config: BotConfig,
    private readonly telegram: TelegramNotificationClient, private readonly now: () => Date = () => new Date()) {}
  async process(job: { name: string; data: unknown; attemptsMade: number }): Promise<void> {
    const parsed = moderationNotificationJobSchema.safeParse(job.data);
    if (job.name !== 'moderation-notification' || !parsed.success) return;
    const { eventId } = parsed.data; const now = this.now(); const claimToken = randomUUID();
    try {
      const claim = await this.prisma.moderationNotification.updateMany({ where: { id: eventId, deliveredAt: null,
        OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] }, data: { claimToken, claimedUntil: new Date(now.getTime() + NOTIFICATION_CLAIM_MS) } });
      if (!claim.count) {
        const event = await this.prisma.moderationNotification.findUnique({ where: { id: eventId }, select: { deliveredAt: true, claimedUntil: true } });
        if (!event || event.deliveredAt) return;
        throw new NotificationRetryError(Math.max(1_000, Math.min(NOTIFICATION_CLAIM_MS, (event.claimedUntil?.getTime() ?? now.getTime() + 1_000) - now.getTime())));
      }
      await this.prisma.$transaction(async (tx) => {
        const initial = await tx.moderationNotification.findUnique({ where: { id: eventId } }); if (!initial) return;
        if (initial.recipientUserId) await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${initial.recipientUserId}::uuid FOR UPDATE`);
        if (initial.reportId) await tx.$queryRaw(Prisma.sql`SELECT id FROM reports WHERE id = ${initial.reportId}::uuid FOR UPDATE`);
        const event = await tx.moderationNotification.findUnique({ where: { id: eventId }, include: { recipient: true, report: true } });
        if (!event || event.deliveredAt || event.claimToken !== claimToken) return;
        const settle = () => tx.moderationNotification.updateMany({ where: { id: eventId, claimToken, deliveredAt: null }, data: { deliveredAt: this.now(), claimToken: null, claimedUntil: null } });
        if (job.attemptsMade >= this.config.NOTIFICATION_MAX_ATTEMPTS) { await settle(); return; }
        let recipient: string; let message: TelegramMessage;
        if (event.kind === 'ADMIN_REPORT') {
          recipient = event.recipientTelegramId?.toString() ?? '';
          if (!this.config.ADMIN_TELEGRAM_IDS.includes(recipient) || !event.report) { await settle(); return; }
          const m = botMessages();
          message = { text: m.adminReportNotice.replaceAll('{reportId}', event.report.id).replace('{reason}', event.report.reason)
            .replace('{reporterId}', event.report.reporterUserId).replace('{reportedId}', event.report.reportedUserId ?? m.admin.deleted),
          reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } };
        } else {
          const user = event.recipient;
          if (!user || !user.isBanned || user.botBlocked) { await settle(); return; }
          recipient = user.telegramId.toString(); const m = botMessages(user.language);
          message = { text: this.config.SUPPORT_CONTACT ? m.banNotice.replace('{support}', this.config.SUPPORT_CONTACT) : m.banNoticeNoSupport,
            reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } };
        }
        try { await this.telegram.sendMessage(recipient, message); }
        catch (error) {
          if (error instanceof TelegramContactError && error.blocked) {
            if (event.recipientUserId) await tx.user.updateMany({ where: { id: event.recipientUserId }, data: { botBlocked: true } });
            await settle(); return;
          }
          if (error instanceof TelegramContactError && !error.retryable) { await settle(); return; }
          throw error;
        }
        await settle();
      }, { maxWait: 5_000, timeout: 20_000 });
    } catch (error) {
      await this.prisma.moderationNotification.updateMany({ where: { id: eventId, claimToken, deliveredAt: null }, data: { claimToken: null, claimedUntil: null,
        ...(job.attemptsMade + 1 >= this.config.NOTIFICATION_MAX_ATTEMPTS ? { deliveredAt: this.now() } : {}) } }).catch(() => undefined);
      throw error instanceof NotificationRetryError ? error : new NotificationRetryError(error instanceof TelegramContactError ? error.retryAfterMs : 0,
        error instanceof TelegramContactError && error.retryAfterMs > 0);
    }
  }
}
