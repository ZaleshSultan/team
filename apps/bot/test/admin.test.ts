import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AdminError, AdminRateLimiter, AdminService } from '../src/admin.js';
import { loadConfig } from '../src/config.js';

const admin = '123456789'; const otherAdmin = '987654321';
const id = '00000000-0000-4000-8000-000000000001'; const adminId = '00000000-0000-4000-8000-000000000002';
const reportId = '00000000-0000-4000-8000-000000000003';
const now = new Date('2026-10-14T12:00:00.000Z');
const config = loadConfig({ BOT_TOKEN: '123456:TEST_TOKEN_NEVER_A_REAL_BOT_12345', MINIAPP_URL: 'https://example.test',
  DATABASE_URL: 'postgresql://test@127.0.0.1/squad_bot_test', REDIS_URL: 'redis://127.0.0.1:6379', ADMIN_TELEGRAM_IDS: `${admin},${otherAdmin}` });
function harness() {
  let userExists = true; let reportExists = true; let registeredAdmin = true;
  const profile = { id, userId: id, nickname: 'Player', roles: ['awp'], lookingFor: ['duo'], playTimes: ['evening'], languages: ['ru'], region: 'KZ', hasMic: true, bio: 'Team player',
    game: { slug: 'cs2' }, isPublished: true, moderationHidden: false, moderationWasPublished: false };
  const user = { id, telegramId: 111111111n, username: 'Not_in_admin_messages', isBanned: false, botBlocked: false, createdAt: now, moderationFlaggedAt: null as Date | null,
    ageConfirmedAt: now, ageMinimumConfirmed: config.AGE_MINIMUM, rulesAcceptedAt: now, rulesVersion: config.RULES_VERSION,
    playerProfiles: [profile], steamAccount: { steamId64: 76_561_198_000_000_001n, personaName: 'Steam player' },
    _count: { reportsReceived: 4, outgoingRequests: 5, incomingRequests: 6, blocksMade: 7, blocksReceived: 8 } };
  const report = { id: reportId, reporterUserId: adminId, reportedUserId: id as string | null, reportedUser: user as typeof user | null,
    reason: 'SPAM', details: 'Unwanted invitations' as string | null, status: 'OPEN', createdAt: now, resolvedBy: null as string | null, resolutionNote: null as string | null };
  const confirmations: any[] = []; const audit: any[] = []; const events: any[] = [];
  const fake = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async ({ where }: any) => where.telegramId ? registeredAdmin ? { id: adminId } : null : userExists ? user : null),
      update: vi.fn(async ({ data }: any) => { Object.assign(user, data); return user; }), count: vi.fn(async () => 20) },
    playerProfile: { updateMany: vi.fn(async ({ where, data }: any) => { if (!where.isPublished || profile.isPublished) Object.assign(profile, data); return { count: 1 }; }),
      update: vi.fn(async ({ data }: any) => { Object.assign(profile, data); return profile; }), count: vi.fn(async () => 10) },
    teammateRequest: { updateMany: vi.fn(async () => ({ count: 2 })), count: vi.fn(async () => 15) },
    session: { deleteMany: vi.fn(async () => ({ count: 3 })) },
    report: { findUnique: vi.fn(async () => reportExists ? report : null), findMany: vi.fn(async () => reportExists ? [report] : []),
      count: vi.fn(async () => 5), update: vi.fn(async ({ data }: any) => { Object.assign(report, data); return report; }) },
    adminActionConfirmation: { create: vi.fn(async ({ data }: any) => { const item = { ...data, id: reportId, consumedAt: null }; confirmations.push(item); return item; }),
      findUnique: vi.fn(async ({ where }: any) => confirmations.find((item) => where.id ? item.id === where.id : item.tokenHash === where.tokenHash) ?? null),
      update: vi.fn(async ({ where, data }: any) => { const item = confirmations.find((c) => c.id === where.id); Object.assign(item, data); return item; }) },
    adminAuditLog: { create: vi.fn(async ({ data }: any) => { audit.push(data); return data; }) },
    moderationNotification: { create: vi.fn(async ({ data }: any) => { events.push(data); return data; }) },
    $transaction: vi.fn(async (fn: any) => fn(fake)),
  };
  const contacts = { getUsername: vi.fn(async () => 'Fresh_contact') }; const dispatch = vi.fn(async () => undefined);
  const service = new AdminService(fake as unknown as PrismaClient, config, contacts, dispatch, () => now);
  return { service, fake, profile, user, report, confirmations, audit, events, contacts, dispatch,
    removeUser: () => { userExists = false; }, removeReport: () => { reportExists = false; }, removeAdminUser: () => { registeredAdmin = false; } };
}
describe('admin service commands', () => {
  it.each(['admin', 'reports', 'stats'] as const)('%s reads safely and records an append-only audit entry', async (command) => {
    const h = harness(); const result = await h.service.execute(admin, command, '');
    expect(result.text).toBeTruthy(); expect(h.audit).toHaveLength(1);
    expect(JSON.stringify(h.audit, (_, value) => typeof value === 'bigint' ? value.toString() : value)).not.toMatch(/Not_in_admin_messages|Unwanted invitations|Fresh_contact/);
    expect(h.contacts.getUsername).not.toHaveBeenCalled();
  });
  it.each(['report', 'user'] as const)('%s shows internal status/public summary and an explicit contact button', async (command) => {
    const h = harness(); const result = await h.service.execute(admin, command, command === 'report' ? reportId : id);
    expect(result.text).toContain(command === 'report' ? reportId : id); expect(result.text).not.toContain('@');
    expect(result.buttons?.[0]?.[0]?.callback_data).toBe(`mc:${id}`); expect(h.contacts.getUsername).not.toHaveBeenCalled();
    expect(h.audit).toHaveLength(1);
  });
  it('redacts contact-containing evidence and unsafe profile names even for the admin', async () => {
    const h = harness(); h.report.details = 'Here is @reporter_private and https://private.test'; h.profile.nickname = '@target_private'; h.user.steamAccount.personaName = 'private.example.com';
    const detail = await h.service.execute(admin, 'report', reportId); const list = await h.service.execute(admin, 'reports', '');
    expect(`${detail.text}\n${list.text}`).not.toMatch(/@|private\.test|private\.example|target_private|reporter_private/);
    expect(detail.text).toContain('скрыты');
  });
  it('reveals ONLY a current validated target contact after explicit Show contact', async () => {
    const h = harness(); const result = await h.service.callback(admin, `mc:${id}`);
    expect(result.text).toContain('@Fresh_contact'); expect(h.contacts.getUsername).toHaveBeenCalledWith('111111111');
    expect(h.audit[0]).toMatchObject({ action: 'SHOW_CONTACT', targetUserId: id, reason: 'EXPLICIT_ADMIN_REQUEST' });
    expect(h.audit[0]).not.toHaveProperty('username');
  });
  it('contact failures and invalid injected contacts produce fixed errors', async () => {
    const h = harness(); h.contacts.getUsername.mockRejectedValueOnce(new Error('https://SECRET @contact'));
    await expect(h.service.callback(admin, `mc:${id}`)).rejects.toMatchObject({ code: 'contactUnavailable', message: 'ADMIN_OPERATION_FAILED' });
    h.contacts.getUsername.mockResolvedValueOnce('https://private.test');
    await expect(h.service.callback(admin, `mc:${id}`)).rejects.toMatchObject({ code: 'contactUnavailable' });
    expect(JSON.stringify(h.audit, (_, value) => typeof value === 'bigint' ? value.toString() : value)).not.toMatch(/SECRET|private\.test/);
    expect(h.audit.at(-1)).toMatchObject({ action: 'SHOW_CONTACT_FAILED', reason: 'CONTACTUNAVAILABLE' });
  });
  it.each(['ban', 'unban'] as const)('%s only prepares a hashed, admin-bound, expiring confirmation', async (command) => {
    const h = harness(); const result = await h.service.execute(admin, command, `${id}${command === 'ban' ? ' spam' : ''}`);
    const callback = result.buttons![0]![0]!.callback_data; const token = callback.slice(3);
    expect(Buffer.byteLength(callback)).toBeLessThanOrEqual(64); expect(h.confirmations[0].tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(h.confirmations[0]).toMatchObject({ adminTelegramId: BigInt(admin), targetUserId: id, action: command.toUpperCase(), expiresAt: new Date(now.getTime() + 300_000) });
    expect(JSON.stringify(h.confirmations, (_, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain(token);
    expect(h.fake.user.update).not.toHaveBeenCalled(); expect(h.events).toHaveLength(0);
  });
  it('ban confirms once, locks users before confirmation, cancels all games and revokes every session', async () => {
    const h = harness(); const prepared = await h.service.execute(admin, 'ban', `${id} spam`); const callback = prepared.buttons![0]![0]!.callback_data;
    await h.service.callback(admin, callback);
    expect(h.user.isBanned).toBe(true); expect(h.profile).toMatchObject({ isPublished: false, moderationHidden: true, moderationWasPublished: true });
    expect(h.fake.teammateRequest.updateMany).toHaveBeenCalledWith({ where: { status: 'PENDING', OR: [{ fromUserId: id }, { toUserId: id }] }, data: { status: 'CANCELED', resolvedAt: now } });
    expect(h.fake.session.deleteMany).toHaveBeenCalledWith({ where: { userId: id } }); expect(h.events).toEqual([{ kind: 'BAN_NOTICE', recipientUserId: id, confirmationId: reportId }]);
    const queries = h.fake.$queryRaw.mock.calls.map(([sql]: any) => ({ sql: sql.sql, values: sql.values }));
    const confirmationLock = queries.findIndex((query) => query.sql.includes('admin_action_confirmations'));
    expect(queries[confirmationLock - 1]?.sql).toContain('ORDER BY id FOR UPDATE');
    expect(queries[confirmationLock - 1]?.values).toEqual([id, adminId]);
    await expect(h.service.callback(admin, callback)).rejects.toMatchObject({ code: 'confirmationExpired' }); expect(h.events).toHaveLength(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1); expect(h.audit.some((entry) => entry.action === 'BAN')).toBe(true);
  });
  it('a second ban confirmation does not enqueue a duplicate ban notice for an already banned user', async () => {
    const h = harness(); h.user.isBanned = true;
    const reply = await h.service.execute(admin, 'ban', `${id} spam`); await h.service.callback(admin, reply.buttons![0]![0]!.callback_data);
    expect(h.events).toHaveLength(0);
  });
  it('unban restores access but leaves profile publication and moderation flags unchanged', async () => {
    const h = harness(); h.user.isBanned = true; h.profile.isPublished = false; h.profile.moderationHidden = true;
    const reply = await h.service.execute(admin, 'unban', id); await h.service.callback(admin, reply.buttons![0]![0]!.callback_data);
    expect(h.user.isBanned).toBe(false); expect(h.profile.isPublished).toBe(false); expect(h.profile.moderationHidden).toBe(true);
    expect(h.fake.session.deleteMany).not.toHaveBeenCalled(); expect(h.events).toHaveLength(0);
  });
  it('unban hides legacy/manual banned profiles that were still marked published', async () => {
    const h = harness(); h.user.isBanned = true; h.profile.isPublished = true;
    const reply = await h.service.execute(admin, 'unban', id); await h.service.callback(admin, reply.buttons![0]![0]!.callback_data);
    expect(h.profile).toMatchObject({ isPublished: false, moderationHidden: true, moderationWasPublished: true });
  });
  it('rejects expired and other-admin confirmation tokens without changing access', async () => {
    const h = harness(); const reply = await h.service.execute(admin, 'ban', `${id} spam`); const callback = reply.buttons![0]![0]!.callback_data;
    await expect(h.service.callback(otherAdmin, callback)).rejects.toMatchObject({ code: 'confirmationExpired' });
    h.confirmations[0].expiresAt = now; await expect(h.service.callback(admin, callback)).rejects.toMatchObject({ code: 'confirmationExpired' });
    expect(h.fake.user.update).not.toHaveBeenCalled();
  });
  it('hides and explicitly restores only previously published profiles after validation', async () => {
    const h = harness(); await h.service.execute(admin, 'hide', id); expect(h.profile.isPublished).toBe(false); expect(h.profile.moderationWasPublished).toBe(true);
    await h.service.execute(admin, 'unhide', id); expect(h.profile.isPublished).toBe(true); expect(h.profile.moderationHidden).toBe(false); expect(h.user.moderationFlaggedAt).toBeNull();
    expect(h.audit.map((row) => row.action)).toEqual(['HIDE', 'UNHIDE']);
  });
  it('unhide does not publish a profile that was a draft before hiding', async () => {
    const h = harness(); h.profile.isPublished = false; await h.service.execute(admin, 'hide', id); await h.service.execute(admin, 'unhide', id);
    expect(h.profile.isPublished).toBe(false); expect(h.profile.moderationHidden).toBe(false);
  });
  it.each(['ban', 'steam', 'consent', 'profile', 'contact', 'game'] as const)('unhide refuses invalid current %s state', async (condition) => {
    const h = harness(); h.profile.moderationHidden = true;
    if (condition === 'ban') h.user.isBanned = true;
    if (condition === 'steam') h.user.steamAccount.steamId64 = 1n;
    if (condition === 'consent') h.user.rulesVersion = 'outdated';
    if (condition === 'profile') h.profile.roles = ['unknown'];
    if (condition === 'contact') h.profile.bio = '@private';
    if (condition === 'game') h.profile.game.slug = 'unknown';
    await expect(h.service.execute(admin, 'unhide', id)).rejects.toMatchObject({ code: 'cannotRestore' });
    expect(h.fake.playerProfile.update).not.toHaveBeenCalled(); expect(h.audit.at(-1)).toMatchObject({ action: 'UNHIDE_FAILED' });
  });
  it.each(['dismiss', 'action'] as const)('%s resolves with private note, ordered users and report locks, fixed audit reason', async (command) => {
    const h = harness(); await h.service.execute(admin, command, `${reportId} evidence @private`);
    expect(h.report.status).toBe(command === 'dismiss' ? 'DISMISSED' : 'ACTIONED'); expect(h.report.resolvedBy).toBe(adminId); expect(h.report.resolutionNote).toBe('evidence @private');
    expect(h.audit.at(-1)).toMatchObject({ reason: 'REPORT_RESOLVED' }); expect(h.audit.at(-1).reason).not.toContain('@');
    expect(h.fake.$queryRaw.mock.calls[0]![0].sql).toContain('ORDER BY id FOR UPDATE'); expect(h.fake.$queryRaw.mock.calls[1]![0].sql).toContain('FROM reports');
  });
  it('an admin without a Squad account resolves reports with resolvedBy null', async () => {
    const h = harness(); h.removeAdminUser(); await h.service.execute(admin, 'dismiss', reportId); expect(h.report.resolvedBy).toBeNull();
  });
  it('deleted reported accounts are readable and cannot expose a contact', async () => {
    const h = harness(); h.report.reportedUserId = null; h.report.reportedUser = null;
    const reply = await h.service.execute(admin, 'report', reportId); expect(reply.text).toContain('аккаунт удалён'); expect(reply.buttons).toBeUndefined();
  });
  it.each(['user', 'hide', 'unhide', 'ban', 'unban'] as const)('%s missing user is fixed and audited', async (command) => {
    const h = harness(); h.removeUser(); await expect(h.service.execute(admin, command, `${id}${command === 'ban' ? ' spam' : ''}`)).rejects.toMatchObject({ code: 'missing' });
    expect(h.audit.at(-1).action).toBe(`${command.toUpperCase()}_FAILED`);
  });
  it.each(['report', 'dismiss', 'action'] as const)('%s missing report is fixed and audited', async (command) => {
    const h = harness(); h.removeReport(); await expect(h.service.execute(admin, command, reportId)).rejects.toMatchObject({ code: 'missing' });
    expect(h.audit.at(-1).action).toBe(`${command.toUpperCase()}_FAILED`);
  });
  it.each(['admin', 'reports', 'report', 'user', 'ban', 'unban', 'hide', 'unhide', 'dismiss', 'action', 'stats'] as const)('%s malformed arguments fail safely with an audit entry', async (command) => {
    const h = harness(); await expect(h.service.execute(admin, command, 'bad-id @contact https://secret.test')).rejects.toBeInstanceOf(AdminError);
    expect(h.audit).toHaveLength(1); expect(h.audit[0]).toMatchObject({ action: `${command.toUpperCase()}_FAILED`, reason: 'INVALID' });
  });
  it('unconfigured admin cannot call the service directly', async () => {
    const h = harness(); await expect(h.service.execute('222222222', 'stats', '')).rejects.toBeInstanceOf(AdminError);
    await expect(h.service.callback('222222222', `mc:${id}`)).rejects.toBeInstanceOf(AdminError); expect(h.audit).toHaveLength(0);
  });
  it('rate-limit decisions are audited without untrusted arguments or target identifiers', async () => {
    const h = harness(); await h.service.recordRateLimit(admin); await h.service.recordRateLimit('222222222');
    expect(h.audit).toEqual([{ adminTelegramId: BigInt(admin), action: 'ADMIN_RATE_LIMITED', targetUserId: null, reportId: null, reason: 'RATE_LIMITED' }]);
  });
  it('paginated open reports use signed admin-bound inline cursors within 64 bytes', async () => {
    const h = harness(); h.fake.report.findMany.mockResolvedValueOnce([h.report, h.report, h.report, h.report]);
    const first = await h.service.execute(admin, 'reports', ''); const cursor = first.buttons![0]![0]!.callback_data;
    expect(Buffer.byteLength(cursor)).toBeLessThanOrEqual(64); await h.service.callback(admin, cursor);
    expect(h.fake.report.findMany.mock.calls[1]![0]).toMatchObject({ where: { status: 'OPEN', OR: [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: reportId } }] } });
    await expect(h.service.callback(otherAdmin, cursor)).rejects.toBeInstanceOf(AdminError);
    await expect(h.service.callback(admin, `${cursor.slice(0, -1)}x`)).rejects.toBeInstanceOf(AdminError);
  });
  it('raw database errors never enter bot errors or audit reasons', async () => {
    const h = harness(); h.fake.user.count.mockRejectedValueOnce(new Error('postgresql://SECRET @username'));
    await expect(h.service.execute(admin, 'stats', '')).rejects.toMatchObject({ message: 'ADMIN_OPERATION_FAILED' }); expect(h.audit.at(-1).reason).toBe('OPERATION_FAILED');
  });
});
describe('admin rate limiter', () => {
  it('limits each admin to30 commands/minute and resets independently', () => {
    const limiter = new AdminRateLimiter(); for (let i = 0; i < 30; i++) expect(limiter.allow(admin, 0)).toBe(true);
    expect(limiter.allow(admin, 59_999)).toBe(false); expect(limiter.allow(otherAdmin, 59_999)).toBe(true); expect(limiter.allow(admin, 60_000)).toBe(true);
  });
});
