import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { TelegramContactError } from '@squad/shared';
import { loadConfig } from '../src/config.js';
import { buildNotificationMessage, NotificationRetryError, RequestNotificationProcessor } from '../src/notifications.js';

const config = loadConfig({ BOT_TOKEN: '123456:TEST_TOKEN_NEVER_A_REAL_BOT_12345', MINIAPP_URL: 'https://example.test',
  DATABASE_URL: 'postgresql://test@127.0.0.1/squad_bot_test', REDIS_URL: 'redis://127.0.0.1:6379', NOTIFICATION_MAX_ATTEMPTS: '3' });
const now = new Date('2026-10-13T10:00:00.000Z');
const eventId = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const senderId = '00000000-0000-4000-8000-000000000003';
const recipientId = '00000000-0000-4000-8000-000000000004';
const steamId = 76_561_198_000_000_001n;
const user = (id: string, telegramId: bigint, nickname: string) => ({ id, telegramId, language: 'ru', isBanned: false, botBlocked: false,
  ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM, rulesAcceptedAt: now, rulesVersion: config.RULES_VERSION,
  steamAccount: { steamId64: steamId, personaName: nickname }, faceitAccount: { steamId64: steamId, level: 7 },
  playerProfiles: [{ nickname, roles: ['awp'], isPublished: true }] });

function harness(kind: 'CREATED' | 'ACCEPTED' = 'CREATED') {
  const event = { id: eventId, requestId, recipientUserId: kind === 'CREATED' ? recipientId : senderId, kind,
    deliveredAt: null as Date | null, claimToken: null as string | null, claimedUntil: null as Date | null,
    request: { id: requestId, fromUserId: senderId, toUserId: recipientId, game: { slug: 'cs2' },
      fromUser: user(senderId, 123456789n, 'Sender'), toUser: user(recipientId, 987654321n, 'Recipient'),
      status: kind === 'CREATED' ? 'PENDING' : 'ACCEPTED', expiresAt: new Date(now.getTime() + 86_400_000) },
  };
  let exists = true;
  let blocked = false;
  const requestNotification = {
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!exists || event.deliveredAt || (where.claimToken && where.claimToken !== event.claimToken)) return { count: 0 };
      if (where.OR && event.claimedUntil && event.claimedUntil > now) return { count: 0 };
      Object.assign(event, data); return { count: 1 };
    }),
    findUnique: vi.fn(async () => exists ? event : null),
  };
  const fake = { requestNotification,
    $queryRaw: vi.fn(async () => []),
    teammateRequest: { findUnique: vi.fn(async () => exists ? event.request : null) },
    block: { findFirst: vi.fn(async () => blocked ? { id: 'blocked' } : null) },
    user: { updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: { botBlocked: boolean } }) => {
      const target = where.id === senderId ? event.request.fromUser : event.request.toUser;
      target.botBlocked = data.botBlocked; return { count: 1 };
    }) },
    $transaction: vi.fn(async (operation: (transaction: unknown) => Promise<void>) => operation(fake)),
  };
  const telegram = { getUsername: vi.fn(async () => 'Current_recipient'), sendMessage: vi.fn(async () => undefined) };
  const processor = new RequestNotificationProcessor(fake as unknown as PrismaClient, config, telegram, () => now);
  const job = { name: 'request-notification', data: { eventId }, attemptsMade: 0 };
  return { event, telegram, processor, job, fake, setExists: (value: boolean) => { exists = value; }, setBlocked: () => { blocked = true; } };
}

describe('request notification worker', () => {
  it('delivers a new request once, without a contact or Telegram identity in text', async () => {
    const { processor, telegram, event, job } = harness();
    await processor.process(job); await processor.process(job);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.getUsername).not.toHaveBeenCalled();
    const [id, message] = telegram.sendMessage.mock.calls[0]!;
    expect(id).toBe('987654321');
    expect(message.text).toContain('Sender');
    expect(message.text).toContain('уровень 7');
    expect(message.text).not.toMatch(/@|123456789|987654321/);
    expect(message.reply_markup.inline_keyboard[0][0].web_app.url).toBe(config.MINIAPP_URL);
    expect(event.deliveredAt).toEqual(now);
  });
  it('acceptance rechecks the accepted user current username immediately before sending', async () => {
    const { processor, telegram, job } = harness('ACCEPTED');
    await processor.process(job);
    expect(telegram.getUsername).toHaveBeenCalledWith('987654321');
    expect(telegram.sendMessage).toHaveBeenCalledWith('123456789', expect.objectContaining({ text: expect.stringContaining('@Current_recipient') }));
    expect(telegram.getUsername.mock.invocationCallOrder[0]).toBeLessThan(telegram.sendMessage.mock.invocationCallOrder[0]!);
  });
  it('concurrent duplicate attempts send once through the database claim', async () => {
    const { processor, telegram, job } = harness();
    const results = await Promise.allSettled([processor.process(job), processor.process(job)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const retry = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(retry.reason).toMatchObject({ message: 'NOTIFICATION_DELIVERY_FAILED', retryAfterMs: 60_000 });
    await processor.process({ ...job, attemptsMade: 1 });
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('retries a still-active lease instead of completing and losing a stalled job', async () => {
    const { processor, telegram, event, job } = harness();
    event.claimToken = 'another-worker'; event.claimedUntil = new Date(now.getTime() + 30_000);
    await expect(processor.process(job)).rejects.toMatchObject({ retryAfterMs: 30_000, rateLimited: false });
    expect(event.deliveredAt).toBeNull(); expect(event.claimToken).toBe('another-worker');
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    event.claimedUntil = new Date(now.getTime() - 1);
    await processor.process({ ...job, attemptsMade: 1 });
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1); expect(event.deliveredAt).toEqual(now);
  });
  it.each(['DECLINED', 'CANCELED', 'EXPIRED', 'ACCEPTED'])('skips a stale CREATED event after %s', async (status) => {
    const { processor, telegram, event, job } = harness(); event.request.status = status;
    await processor.process(job); expect(telegram.sendMessage).not.toHaveBeenCalled(); expect(event.deliveredAt).toEqual(now);
  });
  it.each(['PENDING', 'DECLINED', 'CANCELED', 'EXPIRED'])('skips a stale ACCEPTED event with %s', async (status) => {
    const { processor, telegram, event, job } = harness('ACCEPTED'); event.request.status = status;
    await processor.process(job); expect(telegram.sendMessage).not.toHaveBeenCalled(); expect(telegram.getUsername).not.toHaveBeenCalled();
  });
  it.each(['CREATED', 'ACCEPTED'] as const)('skips a blocked relationship for %s', async (kind) => {
    const { processor, telegram, job, setBlocked } = harness(kind); setBlocked();
    await processor.process(job); expect(telegram.sendMessage).not.toHaveBeenCalled(); expect(telegram.getUsername).not.toHaveBeenCalled();
  });
  it.each(['sender', 'recipient'] as const)('skips banned/blocked %s', async (side) => {
    const { processor, telegram, event, job } = harness('ACCEPTED');
    (side === 'sender' ? event.request.fromUser : event.request.toUser).botBlocked = true;
    await processor.process(job); expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
  it('skips removed and expired requests', async () => {
    const removed = harness(); removed.setExists(false); await removed.processor.process(removed.job);
    const expired = harness(); expired.event.request.expiresAt = now; await expired.processor.process(expired.job);
    expect(removed.telegram.sendMessage).not.toHaveBeenCalled(); expect(expired.telegram.sendMessage).not.toHaveBeenCalled();
  });
  it('skips unpublished participants for a new request', async () => {
    const { processor, telegram, event, job } = harness(); event.request.fromUser.playerProfiles[0]!.isPublished = false;
    await processor.process(job); expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
  it('skips outdated consent and a recipient mismatch', async () => {
    const consent = harness(); consent.event.request.fromUser.rulesVersion = 'old'; await consent.processor.process(consent.job);
    const mismatched = harness(); mismatched.event.recipientUserId = senderId; await mismatched.processor.process(mismatched.job);
    expect(consent.telegram.sendMessage).not.toHaveBeenCalled(); expect(mismatched.telegram.sendMessage).not.toHaveBeenCalled();
  });
  it('marks the notification recipient blocked after sendMessage403 and settles the event', async () => {
    const { processor, telegram, event, job, fake } = harness();
    telegram.sendMessage.mockRejectedValueOnce(new TelegramContactError(true, 0, false));
    await processor.process(job);
    expect(event.request.toUser.botBlocked).toBe(true);
    expect(fake.user.updateMany).toHaveBeenCalledWith({ where: { id: recipientId }, data: { botBlocked: true } });
    expect(event.deliveredAt).toEqual(now);
  });
  it('marks the accepted participant blocked on getChat403 without disclosing their contact', async () => {
    const { processor, telegram, event, job } = harness('ACCEPTED');
    telegram.getUsername.mockRejectedValueOnce(new TelegramContactError(true, 0, false));
    await processor.process(job);
    expect(event.request.toUser.botBlocked).toBe(true); expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
  it('skips an accepted contact that disappeared', async () => {
    const { processor, telegram, event, job } = harness('ACCEPTED');
    telegram.getUsername.mockRejectedValueOnce(new TelegramContactError(false, 0, false));
    await processor.process(job); expect(telegram.sendMessage).not.toHaveBeenCalled(); expect(event.deliveredAt).toEqual(now);
  });
  it('uses retry_after on429, releases the claim, and succeeds on the retry', async () => {
    const { processor, telegram, event, job } = harness();
    telegram.sendMessage.mockRejectedValueOnce(new TelegramContactError(false, 7_000, true));
    await expect(processor.process(job)).rejects.toMatchObject({ message: 'NOTIFICATION_DELIVERY_FAILED', retryAfterMs: 7_000, rateLimited: true });
    expect(event.deliveredAt).toBeNull(); expect(event.claimToken).toBeNull(); expect(event.claimedUntil).toBeNull();
    await processor.process({ ...job, attemptsMade: 1 });
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2); expect(event.deliveredAt).toEqual(now);
  });
  it('bounds retries and settles after the final failed attempt', async () => {
    const { processor, telegram, event, job } = harness();
    telegram.sendMessage.mockRejectedValue(new Error('https://secret.test @private_contact'));
    await expect(processor.process({ ...job, attemptsMade: 2 })).rejects.toBeInstanceOf(NotificationRetryError);
    expect(event.deliveredAt).toEqual(now);
    await processor.process({ ...job, attemptsMade: 3 });
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each([
    { name: 'wrong-job', data: { eventId } }, { name: 'request-notification', data: {} },
    { name: 'request-notification', data: { eventId: 'bad' } },
    { name: 'request-notification', data: { eventId, username: 'private_name' } },
  ])('ignores a bad job without DB or Telegram calls', async (job) => {
    const { processor, telegram, fake } = harness();
    await processor.process({ ...job, attemptsMade: 0 });
    expect(fake.requestNotification.updateMany).not.toHaveBeenCalled(); expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
  it('replaces arbitrary database and SDK errors before they reach BullMQ', async () => {
    const { processor, job, fake } = harness();
    fake.$queryRaw.mockRejectedValueOnce(new Error('postgresql://user:SECRET@db/private @username'));
    try { await processor.process(job); expect.unreachable(); }
    catch (error) { expect(String(error)).toBe('NotificationRetryError: NOTIFICATION_DELIVERY_FAILED'); expect(JSON.stringify(error)).not.toMatch(/SECRET|username|postgresql/); }
  });
});

describe('public notification summary', () => {
  const summary = { nickname: 'Sniper', personaName: 'Steam persona', roles: ['awp'], steamId64: steamId, faceitSteamId64: steamId, faceitLevel: 10 };
  it('uses English as secondary language and plain text without parse_mode', () => {
    const message = buildNotificationMessage('CREATED', summary, 'en-US', config.MINIAPP_URL);
    expect(message.text).toContain('wants to play'); expect(message.text).toContain('AWPer'); expect(message.text).toContain('level 10');
    expect(message).not.toHaveProperty('parse_mode');
  });
  it('omits mismatching FACEIT and untrusted role values', () => {
    const message = buildNotificationMessage('CREATED', { ...summary, faceitSteamId64: steamId + 1n, roles: ['awp', '@bad_handle'] }, 'ru', config.MINIAPP_URL);
    expect(message.text).not.toContain('FACEIT'); expect(message.text).not.toContain('@');
  });
  it('does not reveal contact-like persona or nickname values', () => {
    const message = buildNotificationMessage('CREATED', { ...summary, nickname: '@private_name', personaName: 'secret.example.com' }, 'ru', config.MINIAPP_URL);
    expect(message.text).toContain('Игрок'); expect(message.text).not.toMatch(/private_name|secret\.example/);
  });
  it('rejects a contact URL or markup passed by a faulty injected adapter', () => {
    expect(() => buildNotificationMessage('ACCEPTED', summary, 'en', config.MINIAPP_URL, 'https://secret.test')).toThrow('CONTACT_UNAVAILABLE');
  });
});
