import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { TelegramContactError } from '@squad/shared';
import { loadConfig } from '../src/config.js';
import { ModerationNotificationProcessor } from '../src/moderation-notifications.js';
import { dispatchModerationNotifications } from '../src/worker.js';

const admin = '123456789'; const now = new Date('2026-10-14T12:00:00.000Z');
const id = '00000000-0000-4000-8000-000000000001'; const reportId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const config = loadConfig({ BOT_TOKEN: '123456:TEST_TOKEN_NEVER_A_REAL_BOT_12345', MINIAPP_URL: 'https://example.test',
  DATABASE_URL: 'postgresql://test@127.0.0.1/squad_bot_test', REDIS_URL: 'redis://127.0.0.1:6379', ADMIN_TELEGRAM_IDS: admin,
  NOTIFICATION_MAX_ATTEMPTS: '3', SUPPORT_CONTACT: '@public_support' });
function harness(kind: 'ADMIN_REPORT' | 'BAN_NOTICE' = 'ADMIN_REPORT') {
  let exists = true;
  const event = { id, kind, recipientTelegramId: kind === 'ADMIN_REPORT' ? BigInt(admin) : null, recipientUserId: kind === 'BAN_NOTICE' ? userId : null,
    reportId: kind === 'ADMIN_REPORT' ? reportId : null, deliveredAt: null as Date | null, claimToken: null as string | null, claimedUntil: null as Date | null,
    report: kind === 'ADMIN_REPORT' ? { id: reportId, reporterUserId: userId, reportedUserId: id as string | null, reason: 'SPAM', details: '@private_evidence' } : null,
    recipient: kind === 'BAN_NOTICE' ? { id: userId, isBanned: true, botBlocked: false, telegramId: 987654321n, language: 'ru' } : null };
  const fake = {
    moderationNotification: { updateMany: vi.fn(async ({ where, data }: any) => {
      if (!exists || event.deliveredAt || where.claimToken && where.claimToken !== event.claimToken || where.OR && event.claimedUntil && event.claimedUntil > now) return { count: 0 };
      Object.assign(event, data); return { count: 1 };
    }), findUnique: vi.fn(async () => exists ? event : null) },
    user: { updateMany: vi.fn(async ({ data }: any) => { if (event.recipient) Object.assign(event.recipient, data); return { count: 1 }; }) },
    $queryRaw: vi.fn(async () => []), $transaction: vi.fn(async (fn: any) => fn(fake)),
  };
  const telegram = { sendMessage: vi.fn(async () => undefined), getUsername: vi.fn(async () => 'Never_read') };
  const processor = new ModerationNotificationProcessor(fake as unknown as PrismaClient, config, telegram, () => now);
  const job = { name: 'moderation-notification', data: { eventId: id }, attemptsMade: 0 };
  return { processor, fake, event, job, telegram, remove: () => { exists = false; } };
}
describe('durable moderation notifications', () => {
  it('notifies a configured admin once with only reason and internal ids, without evidence/contacts', async () => {
    const h = harness(); await h.processor.process(h.job); await h.processor.process(h.job);
    expect(h.telegram.sendMessage).toHaveBeenCalledTimes(1); const [recipient, message] = h.telegram.sendMessage.mock.calls[0]!;
    expect(recipient).toBe(admin); expect(message.text).toContain(reportId); expect(message.text).toContain('SPAM');
    expect(message.text).not.toMatch(/@|private_evidence|123456789/); expect(h.telegram.getUsername).not.toHaveBeenCalled(); expect(h.event.deliveredAt).toEqual(now);
  });
  it('delivers a neutral ban notice without report or ban reason text', async () => {
    const h = harness('BAN_NOTICE'); await h.processor.process(h.job);
    expect(h.telegram.sendMessage).toHaveBeenCalledWith('987654321', expect.objectContaining({ text: 'Доступ ограничен. Если это ошибка, напишите: @public_support' }));
    expect(h.telegram.getUsername).not.toHaveBeenCalled();
  });
  it('supports English ban notice and neutral fallback when support is unset', async () => {
    const h = harness('BAN_NOTICE'); h.event.recipient!.language = 'en';
    const processor = new ModerationNotificationProcessor(h.fake as unknown as PrismaClient, { ...config, SUPPORT_CONTACT: '' }, h.telegram, () => now);
    await processor.process(h.job); expect(h.telegram.sendMessage.mock.calls[0]![1].text).toContain('community administrator'); expect(h.telegram.sendMessage.mock.calls[0]![1].text).not.toContain('@');
  });
  it('concurrent duplicate jobs share the database claim and send once', async () => {
    const h = harness(); const results = await Promise.allSettled([h.processor.process(h.job), h.processor.process(h.job)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1); expect(h.telegram.sendMessage).toHaveBeenCalledTimes(1);
    await h.processor.process({ ...h.job, attemptsMade: 1 }); expect(h.telegram.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('retries an active claim rather than completing a stalled duplicate', async () => {
    const h = harness(); h.event.claimedUntil = new Date(now.getTime() + 15_000); h.event.claimToken = 'other';
    await expect(h.processor.process(h.job)).rejects.toMatchObject({ retryAfterMs: 15_000 }); expect(h.event.deliveredAt).toBeNull(); expect(h.telegram.sendMessage).not.toHaveBeenCalled();
  });
  it.each(['removed_admin', 'deleted_report', 'deleted_event', 'wrong_recipient'] as const)('settles/skips %s without contacting Telegram', async (condition) => {
    const h = harness();
    if (condition === 'removed_admin') h.event.recipientTelegramId = 222222222n;
    if (condition === 'deleted_report') h.event.report = null;
    if (condition === 'deleted_event') h.remove();
    if (condition === 'wrong_recipient') h.event.recipientTelegramId = null;
    await h.processor.process(h.job); expect(h.telegram.sendMessage).not.toHaveBeenCalled();
  });
  it.each(['unbanned', 'botBlocked', 'deleted_user'] as const)('suppresses a ban notice after %s', async (condition) => {
    const h = harness('BAN_NOTICE');
    if (condition === 'unbanned') h.event.recipient!.isBanned = false;
    if (condition === 'botBlocked') h.event.recipient!.botBlocked = true;
    if (condition === 'deleted_user') h.event.recipient = null;
    await h.processor.process(h.job); expect(h.telegram.sendMessage).not.toHaveBeenCalled(); expect(h.event.deliveredAt).toEqual(now);
  });
  it.each(['ADMIN_REPORT', 'BAN_NOTICE'] as const)('403 for %s is terminal; registered ban recipients get botBlocked=true', async (kind) => {
    const h = harness(kind); h.telegram.sendMessage.mockRejectedValueOnce(new TelegramContactError(true, 0, false));
    await h.processor.process(h.job); expect(h.event.deliveredAt).toEqual(now);
    if (kind === 'BAN_NOTICE') expect(h.event.recipient!.botBlocked).toBe(true); else expect(h.fake.user.updateMany).not.toHaveBeenCalled();
  });
  it('429 releases the claim, consumes retry budget and exposes a bounded safe delay', async () => {
    const h = harness(); h.telegram.sendMessage.mockRejectedValueOnce(new TelegramContactError(false, 9_000, true));
    await expect(h.processor.process(h.job)).rejects.toMatchObject({ message: 'NOTIFICATION_DELIVERY_FAILED', retryAfterMs: 9_000, rateLimited: true });
    expect(h.event.deliveredAt).toBeNull(); expect(h.event.claimToken).toBeNull(); await h.processor.process({ ...h.job, attemptsMade: 1 }); expect(h.event.deliveredAt).toEqual(now);
  });
  it('permanent transport errors settle without retries', async () => {
    const h = harness(); h.telegram.sendMessage.mockRejectedValueOnce(new TelegramContactError(false, 0, false)); await h.processor.process(h.job); expect(h.event.deliveredAt).toEqual(now);
  });
  it('exhaustion settles; arbitrary private errors never enter persisted BullMQ failures', async () => {
    const h = harness(); h.telegram.sendMessage.mockRejectedValueOnce(new Error('https://api.telegram.org/botSECRET @private'));
    try { await h.processor.process({ ...h.job, attemptsMade: 2 }); expect.unreachable(); }
    catch (error) { expect(String(error)).toBe('NotificationRetryError: NOTIFICATION_DELIVERY_FAILED'); expect(JSON.stringify(error)).not.toMatch(/SECRET|private|https/); }
    expect(h.event.deliveredAt).toEqual(now); await h.processor.process(h.job); expect(h.telegram.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each([{ name: 'wrong', data: { eventId: id } }, { name: 'moderation-notification', data: { eventId: 'bad' } },
    { name: 'moderation-notification', data: { eventId: id, username: 'private' } }])('ignores malformed jobs', async (job) => {
    const h = harness(); await h.processor.process({ ...job, attemptsMade: 0 }); expect(h.fake.moderationNotification.updateMany).not.toHaveBeenCalled(); expect(h.telegram.sendMessage).not.toHaveBeenCalled();
  });
});
describe('moderation immediate outbox dispatch', () => {
  function harnessQueue() {
    const events = [{ id }, { id: reportId }];
    const fake = { moderationNotification: { findMany: vi.fn(async () => events), updateMany: vi.fn(async () => ({ count: 1 })) } };
    const queue = { getJob: vi.fn(async () => null as any), add: vi.fn(async () => ({}) as any) };
    return { fake, queue };
  }
  it('uses stable event job ids and strict opaque payloads in the shared queue', async () => {
    const h = harnessQueue(); expect(await dispatchModerationNotifications(h.fake as unknown as PrismaClient, h.queue, now)).toBe(2);
    expect(h.queue.add).toHaveBeenCalledWith('moderation-notification', { eventId: id }, { jobId: `moderation-${id}` });
    expect(h.fake.moderationNotification.findMany.mock.calls[0]![0]).toMatchObject({ take: 100 });
  });
  it('isolates a queue failure and still dispatches the next event', async () => {
    const h = harnessQueue(); h.queue.add.mockRejectedValueOnce(new Error('SECRET')); expect(await dispatchModerationNotifications(h.fake as unknown as PrismaClient, h.queue, now)).toBe(1);
    expect(h.queue.add).toHaveBeenCalledTimes(2);
  });
  it.each(['failed', 'completed'])('settles a retained %s job without resetting its retry budget', async (status) => {
    const h = harnessQueue(); h.queue.getJob.mockResolvedValueOnce({ getState: async () => status }); await dispatchModerationNotifications(h.fake as unknown as PrismaClient, h.queue, now);
    expect(h.queue.add).toHaveBeenCalledTimes(1); expect(h.fake.moderationNotification.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { deliveredAt: now, claimToken: null, claimedUntil: null } }));
  });
});
