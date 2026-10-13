import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { adminConfirmationTokenSchema, adminIdInputSchema, adminNoteInputSchema, CS2_PROFILE_OPTIONS,
  normalizeProfileText, playerProfileInputSchema, profileTextError, telegramUsernameSchema, type AdminCommand } from '@squad/shared';
import type { BotConfig } from './config.js';
import ru from './locales/ru.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };

type Tx = Prisma.TransactionClient;
type Position = { id: string; createdAt: Date };
export interface AdminReply { text: string; buttons?: Array<Array<{ text: string; callback_data: string }>> }
export class AdminError extends Error {
  constructor(readonly code: 'invalid' | 'missing' | 'confirmationExpired' | 'cannotRestore' | 'contactUnavailable' = 'invalid') { super('ADMIN_OPERATION_FAILED'); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const options = { maxWait: 10_000, timeout: 15_000 };
const messages = (language: string) => language.startsWith('en') ? en : ru;
const safeText = (text: string | null) => text && profileTextError('bio', text) !== 'CONTACTS_NOT_ALLOWED' ? normalizeProfileText(text) : null;

/** Reasons and evidence never enter the audit log. It stores fixed action/result
 * codes only, while private resolution notes remain on the report itself. */
export class AdminService {
  constructor(private readonly prisma: PrismaClient, private readonly config: BotConfig,
    private readonly contacts: { getUsername(id: string): Promise<string> },
    private readonly dispatch: () => Promise<unknown> = async () => undefined,
    private readonly now: () => Date = () => new Date()) {}

  private audit(tx: Tx | PrismaClient, admin: string, action: string, targetUserId: string | null = null, reportId: string | null = null, reason: string | null = null) {
    return tx.adminAuditLog.create({ data: { adminTelegramId: BigInt(admin), action, targetUserId, reportId, reason } });
  }
  private async locked(tx: Tx, ids: Array<string | null>) {
    const users = [...new Set(ids.filter((id): id is string => id !== null))].sort();
    if (users.length) await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id IN (${Prisma.join(users.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`);
  }
  private adminUser(tx: Tx | PrismaClient, admin: string) { return tx.user.findUnique({ where: { telegramId: BigInt(admin) }, select: { id: true } }); }
  private async failed(admin: string, action: string, operation: () => Promise<AdminReply>): Promise<AdminReply> {
    try { return await operation(); }
    catch (error) {
      // An audit outage fails closed. Errors contain fixed codes, never DB details.
      try { await this.audit(this.prisma, admin, `${action}_FAILED`, null, null, error instanceof AdminError ? error.code.toUpperCase() : 'OPERATION_FAILED'); }
      catch { throw new AdminError(); }
      throw error instanceof AdminError ? error : new AdminError();
    }
  }
  async recordRateLimit(admin: string) {
    if (!this.config.ADMIN_TELEGRAM_IDS.includes(admin)) return;
    try { await this.audit(this.prisma, admin, 'ADMIN_RATE_LIMITED', null, null, 'RATE_LIMITED'); }
    catch { throw new AdminError(); }
  }
  async execute(admin: string, command: AdminCommand, argument: string, language = 'ru'): Promise<AdminReply> {
    // Defense in depth: the service itself cannot be called for an unconfigured ID.
    if (!this.config.ADMIN_TELEGRAM_IDS.includes(admin)) throw new AdminError();
    return this.failed(admin, command.toUpperCase(), async () => {
      const text = argument.trim(); const m = messages(language).admin;
      if (command === 'admin') { if (text) throw new AdminError(); await this.audit(this.prisma, admin, 'HELP'); return { text: m.help }; }
      if (command === 'reports') { if (text) throw new AdminError(); return this.reports(admin, null, language); }
      if (command === 'stats') { if (text) throw new AdminError(); return this.stats(admin, language); }
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      const parsed = adminNoteInputSchema.safeParse({ id: match?.[1], ...(match?.[2] ? { note: match[2] } : {}) });
      if (!parsed.success) throw new AdminError();
      const { id } = parsed.data; const note = parsed.data.note ? normalizeProfileText(parsed.data.note) : null;
      if (note && Array.from(note).length > 500) throw new AdminError();
      if (!['ban', 'dismiss', 'action'].includes(command) && note) throw new AdminError();
      if (command === 'report') return this.report(admin, id, language);
      if (command === 'user') return this.user(admin, id, language);
      if (command === 'ban' || command === 'unban') {
        if (command === 'ban' && !note) throw new AdminError();
        return this.prepare(admin, id, command === 'ban' ? 'BAN' : 'UNBAN', note, language);
      }
      if (command === 'hide' || command === 'unhide') return this.visibility(admin, id, command === 'unhide', language);
      return this.resolve(admin, id, command === 'dismiss' ? 'DISMISSED' : 'ACTIONED', note, language);
    });
  }
  private cursor(admin: string, position: Position) {
    const value = `${position.createdAt.getTime().toString(36)}:${Buffer.from(position.id.replaceAll('-', ''), 'hex').toString('base64url')}`;
    const signature = createHmac('sha256', this.config.BOT_TOKEN).update(`squad:admin:reports:${admin}:${value}`).digest().subarray(0, 8).toString('base64url');
    return `mr:${value}:${signature}`;
  }
  private decode(admin: string, value: string): Position {
    const match = /^mr:([a-z\d]+):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{11})$/.exec(value);
    if (!match) throw new AdminError();
    const timestamp = Number.parseInt(match[1]!, 36); const bytes = Buffer.from(match[2]!, 'base64url');
    if (bytes.length !== 16 || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp.toString(36) !== match[1]) throw new AdminError();
    const hex = bytes.toString('hex'); const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (!adminIdInputSchema.safeParse({ id }).success) throw new AdminError();
    const position = { id, createdAt: new Date(timestamp) };
    if (!Number.isFinite(position.createdAt.getTime())) throw new AdminError();
    const expected = Buffer.from(this.cursor(admin, position)); const actual = Buffer.from(value);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new AdminError();
    return position;
  }
  async callback(admin: string, value: string, language = 'ru'): Promise<AdminReply> {
    if (!this.config.ADMIN_TELEGRAM_IDS.includes(admin)) throw new AdminError();
    const action = value.startsWith('ma:') ? 'CONFIRMATION' : value.startsWith('mc:') ? 'SHOW_CONTACT' : value.startsWith('mr:') ? 'REPORTS_LIST' : 'CALLBACK';
    return this.failed(admin, action, async () => {
      if (value.startsWith('ma:')) return this.confirm(admin, adminConfirmationTokenSchema.parse(value.slice(3)), language);
      if (value.startsWith('mc:')) return this.contact(admin, adminIdInputSchema.parse({ id: value.slice(3) }).id, language);
      return this.reports(admin, this.decode(admin, value), language);
    });
  }
  private summary(user: { playerProfiles: Array<{ nickname: string | null; roles: string[]; region: string }>; steamAccount: { personaName: string | null } | null } | null, language: string) {
    const m = messages(language); const profile = user?.playerProfiles[0];
    const name = [profile?.nickname, user?.steamAccount?.personaName].find((value) => value && profileTextError('nickname', value) === null);
    const roles = (profile?.roles ?? []).filter((role) => CS2_PROFILE_OPTIONS.roles.includes(role));
    return [name ?? m.teammate, roles.join(', '), profile && CS2_PROFILE_OPTIONS.regions.includes(profile.region) ? profile.region : ''].filter(Boolean).join(' · ');
  }
  private readonly reportInclude = { reportedUser: { select: { playerProfiles: { where: { game: { slug: 'cs2' } }, select: { nickname: true, roles: true, region: true }, take: 1 }, steamAccount: { select: { personaName: true } } } } } as const;
  private async reports(admin: string, position: Position | null, language: string): Promise<AdminReply> {
    const m = messages(language).admin;
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.report.findMany({ where: { status: 'OPEN', ...(position ? { OR: [
        { createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { lt: position.id } },
      ] } : {}) }, include: this.reportInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 4 });
      const page = rows.slice(0, 3);
      await this.audit(tx, admin, 'REPORTS_LIST');
      const text = page.map((row) => `${row.id}\n${m.target}: ${row.reportedUserId ?? m.deleted}\n${this.summary(row.reportedUser, language)}\n${row.reason}\n${safeText(row.details) ?? (row.details ? m.evidenceHidden : m.noDetails)}`).join('\n\n');
      const last = page.at(-1);
      return { text: text || m.noReports, ...(rows.length > 3 && last ? { buttons: [[{ text: m.next, callback_data: this.cursor(admin, last) }]] } : {}) };
    }, options);
  }
  private async report(admin: string, id: string, language: string): Promise<AdminReply> {
    const m = messages(language).admin;
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.report.findUnique({ where: { id }, include: this.reportInclude });
      if (!report) throw new AdminError('missing');
      await this.locked(tx, [report.reportedUserId]);
      const target = report.reportedUserId && await tx.user.findUnique({ where: { id: report.reportedUserId }, select: { id: true } });
      await this.audit(tx, admin, 'REPORT_READ', target ? target.id : null, report.id);
      return { text: `${report.id}\n${m.reporter}: ${report.reporterUserId}\n${m.target}: ${report.reportedUserId ?? m.deleted}\n${this.summary(report.reportedUser, language)}\n${report.reason} · ${report.status}\n${safeText(report.details) ?? (report.details ? m.evidenceHidden : m.noDetails)}`,
        ...(target ? { buttons: [[{ text: m.showContact, callback_data: `mc:${target.id}` }]] } : {}) };
    }, options);
  }
  private async user(admin: string, id: string, language: string): Promise<AdminReply> {
    const m = messages(language).admin;
    return this.prisma.$transaction(async (tx) => {
      await this.locked(tx, [id]);
      const user = await tx.user.findUnique({ where: { id }, select: { id: true, isBanned: true, createdAt: true, moderationFlaggedAt: true,
        playerProfiles: { select: { isPublished: true, moderationHidden: true } }, _count: { select: { reportsReceived: true, outgoingRequests: true, incomingRequests: true, blocksMade: true, blocksReceived: true } } } });
      if (!user) throw new AdminError('missing');
      await this.audit(tx, admin, 'USER_READ', id);
      return { text: `${id}\n${m.banned}: ${user.isBanned}\n${m.created}: ${user.createdAt.toISOString()}\n${m.published}: ${user.playerProfiles.filter((profile) => profile.isPublished).length}\n${m.hidden}: ${user.playerProfiles.filter((profile) => profile.moderationHidden).length}\n${m.flagged}: ${Boolean(user.moderationFlaggedAt)}\n${m.reportCount}: ${user._count.reportsReceived}\n${m.requests}: ${user._count.incomingRequests} / ${user._count.outgoingRequests}\n${m.blocks}: ${user._count.blocksMade} / ${user._count.blocksReceived}`,
        buttons: [[{ text: m.showContact, callback_data: `mc:${id}` }]] };
    }, options);
  }
  private async stats(admin: string, language: string): Promise<AdminReply> {
    return this.prisma.$transaction(async (tx) => {
      const [users, profiles, requests, reports] = await Promise.all([tx.user.count(), tx.playerProfile.count({ where: { isPublished: true } }),
        tx.teammateRequest.count({ where: { createdAt: { gte: new Date(this.now().toISOString().slice(0, 10)) } } }), tx.report.count({ where: { status: 'OPEN' } })]);
      await this.audit(tx, admin, 'STATS_READ'); const m = messages(language).admin;
      return { text: `${m.users}: ${users}\n${m.published}: ${profiles}\n${m.requestsToday}: ${requests}\n${m.openReports}: ${reports}` };
    }, options);
  }
  private async prepare(admin: string, id: string, action: 'BAN' | 'UNBAN', reason: string | null, language: string): Promise<AdminReply> {
    return this.prisma.$transaction(async (tx) => {
      await this.locked(tx, [id]);
      if (!await tx.user.findUnique({ where: { id }, select: { id: true } })) throw new AdminError('missing');
      const token = randomBytes(24).toString('base64url');
      await tx.adminActionConfirmation.create({ data: { tokenHash: hash(token), adminTelegramId: BigInt(admin), targetUserId: id, action,
        reason: reason ? safeText(reason) ?? 'ADMIN_REASON_REDACTED' : null, expiresAt: new Date(this.now().getTime() + 5 * 60_000) } });
      await this.audit(tx, admin, `${action}_PREPARE`, id, null, 'CONFIRMATION_REQUIRED');
      const m = messages(language).admin;
      return { text: `${action === 'BAN' ? m.confirmBan : m.confirmUnban}\n${id}`, buttons: [[{ text: m.confirm, callback_data: `ma:${token}` }]] };
    }, options);
  }
  private async confirm(admin: string, token: string, language: string): Promise<AdminReply> {
    const reply = await this.prisma.$transaction(async (tx) => {
      const before = await tx.adminActionConfirmation.findUnique({ where: { tokenHash: hash(token) } });
      if (!before || before.adminTelegramId.toString() !== admin) throw new AdminError('confirmationExpired');
      const adminUser = await this.adminUser(tx, admin);
      await this.locked(tx, [before.targetUserId, adminUser?.id ?? null]);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM admin_action_confirmations WHERE id = ${before.id}::uuid FOR UPDATE`);
      const confirmation = await tx.adminActionConfirmation.findUnique({ where: { id: before.id } });
      if (!confirmation || confirmation.consumedAt || confirmation.expiresAt <= this.now() || confirmation.adminTelegramId.toString() !== admin) throw new AdminError('confirmationExpired');
      const user = await tx.user.findUnique({ where: { id: confirmation.targetUserId } });
      if (!user) throw new AdminError('missing');
      const now = this.now(); const banned = confirmation.action === 'BAN'; const wasBanned = user.isBanned;
      await tx.adminActionConfirmation.update({ where: { id: confirmation.id }, data: { consumedAt: now } });
      await tx.user.update({ where: { id: user.id }, data: { isBanned: banned, ...(banned ? { moderationFlaggedAt: now } : {}) } });
      // Legacy/manual bans may predate the atomic hide side effect. Restoring
      // access must never make such an old published row visible by accident.
      if (!banned && wasBanned) await this.hideProfiles(tx, user.id);
      if (banned) {
        await this.hideProfiles(tx, user.id);
        await tx.teammateRequest.updateMany({ where: { status: 'PENDING', OR: [{ fromUserId: user.id }, { toUserId: user.id }] }, data: { status: 'CANCELED', resolvedAt: now } });
        await tx.session.deleteMany({ where: { userId: user.id } });
        if (!wasBanned) await tx.moderationNotification.create({ data: { kind: 'BAN_NOTICE', recipientUserId: user.id, confirmationId: confirmation.id } });
      }
      await this.audit(tx, admin, banned ? 'BAN' : 'UNBAN', user.id, null, banned ? 'ACCESS_RESTRICTED' : 'ACCESS_RESTORED_PROFILES_HIDDEN');
      return { text: banned ? messages(language).admin.banDone : messages(language).admin.unbanDone };
    }, options);
    try { void this.dispatch().catch(() => undefined); } catch { /* API maintenance recovers the committed outbox. */ }
    return reply;
  }
  private async hideProfiles(tx: Tx, id: string) {
    await tx.playerProfile.updateMany({ where: { userId: id, isPublished: true }, data: { moderationWasPublished: true } });
    await tx.playerProfile.updateMany({ where: { userId: id }, data: { isPublished: false, moderationHidden: true } });
  }
  private validProfile(profile: unknown): boolean {
    const parsed = playerProfileInputSchema.safeParse(profile); if (!parsed.success) return false;
    const p = parsed.data;
    return p.gameSlug === 'cs2' && profileTextError('nickname', p.nickname) === null && profileTextError('bio', p.bio) === null
      && CS2_PROFILE_OPTIONS.regions.includes(p.region) && [['roles', 3], ['lookingFor', 3], ['playTimes', 4], ['languages', 4]].every(([key, max]) => {
        const field = key as 'roles' | 'lookingFor' | 'playTimes' | 'languages'; const values = p[field];
        return values.length > 0 && values.length <= Number(max) && values.every((value) => CS2_PROFILE_OPTIONS[field].includes(value));
      });
  }
  private async visibility(admin: string, id: string, restore: boolean, language: string): Promise<AdminReply> {
    return this.prisma.$transaction(async (tx) => {
      await this.locked(tx, [id]);
      const user = await tx.user.findUnique({ where: { id }, include: { steamAccount: true, playerProfiles: { include: { game: true } } } });
      if (!user) throw new AdminError('missing');
      if (!restore) {
        await this.hideProfiles(tx, id); await tx.user.update({ where: { id }, data: { moderationFlaggedAt: this.now() } });
      } else {
        if (user.isBanned || user.botBlocked || !user.username || !user.ageConfirmedAt || user.ageMinimumConfirmed !== this.config.AGE_MINIMUM
          || !user.rulesAcceptedAt || user.rulesVersion !== this.config.RULES_VERSION || !user.steamAccount
          || user.steamAccount.steamId64 < 76_561_197_960_265_729n || user.steamAccount.steamId64 > 76_561_202_255_233_023n) throw new AdminError('cannotRestore');
        for (const p of user.playerProfiles.filter((profile) => profile.moderationHidden)) {
          if (!this.validProfile({ gameSlug: p.game.slug, nickname: p.nickname, roles: p.roles, lookingFor: p.lookingFor, playTimes: p.playTimes,
            languages: p.languages, region: p.region, hasMic: p.hasMic, bio: p.bio })) throw new AdminError('cannotRestore');
          await tx.playerProfile.update({ where: { id: p.id }, data: { moderationHidden: false, isPublished: p.moderationWasPublished, moderationWasPublished: false } });
        }
        await tx.user.update({ where: { id }, data: { moderationFlaggedAt: null } });
      }
      await this.audit(tx, admin, restore ? 'UNHIDE' : 'HIDE', id, null, restore ? 'PROFILE_REVIEWED' : 'PROFILE_HIDDEN');
      return { text: restore ? messages(language).admin.unhideDone : messages(language).admin.hideDone };
    }, options);
  }
  private async resolve(admin: string, id: string, status: 'DISMISSED' | 'ACTIONED', note: string | null, language: string): Promise<AdminReply> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.report.findUnique({ where: { id } }); if (!before) throw new AdminError('missing');
      const initialAdmin = await this.adminUser(tx, admin);
      await this.locked(tx, [before.reporterUserId, before.reportedUserId, initialAdmin?.id ?? null]);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM reports WHERE id = ${id}::uuid FOR UPDATE`);
      const report = await tx.report.findUnique({ where: { id } }); if (!report) throw new AdminError('missing');
      const currentAdmin = await this.adminUser(tx, admin);
      await tx.report.update({ where: { id }, data: { status, resolvedAt: this.now(), resolvedBy: currentAdmin?.id ?? null, resolutionNote: note } });
      await this.audit(tx, admin, status === 'DISMISSED' ? 'DISMISS' : 'ACTION', report.reportedUserId, id, 'REPORT_RESOLVED');
      return { text: messages(language).admin.resolveDone };
    }, options);
  }
  private async contact(admin: string, id: string, language: string): Promise<AdminReply> {
    return this.prisma.$transaction(async (tx) => {
      await this.locked(tx, [id]); const user = await tx.user.findUnique({ where: { id }, select: { id: true, telegramId: true } });
      if (!user) throw new AdminError('missing');
      await this.audit(tx, admin, 'SHOW_CONTACT', id, null, 'EXPLICIT_ADMIN_REQUEST');
      let username: string;
      try { username = await this.contacts.getUsername(user.telegramId.toString()); }
      catch { throw new AdminError('contactUnavailable'); }
      if (!telegramUsernameSchema.safeParse(username).success) throw new AdminError('contactUnavailable');
      return { text: `${messages(language).admin.contact}: @${username}` };
    }, options);
  }
}

/** In-process quota is adequate for the single polling bot. Map size is bounded
 * by configured admins; neither updates from strangers nor callbacks grow it. */
export class AdminRateLimiter {
  private windows = new Map<string, { startsAt: number; count: number }>();
  allow(id: string, now = Date.now()): boolean {
    let window = this.windows.get(id);
    if (!window || now - window.startsAt >= 60_000) { window = { startsAt: now, count: 0 }; this.windows.set(id, window); }
    window.count += 1; return window.count <= 30;
  }
}
