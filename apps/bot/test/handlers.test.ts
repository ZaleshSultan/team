import type { PrismaClient } from '@prisma/client';
import { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AdminError, type AdminService } from '../src/admin.js';
import { legalText, registerBotHandlers } from '../src/handlers.js';

const adminId = 123456789;
const config = loadConfig({ BOT_TOKEN: '123456:TEST_TOKEN_NEVER_A_REAL_BOT_12345', MINIAPP_URL: 'https://example.test',
  DATABASE_URL: 'postgresql://test@127.0.0.1/squad_bot_test', REDIS_URL: 'redis://127.0.0.1:6379', ADMIN_TELEGRAM_IDS: String(adminId) });
function harness(settings = config) {
  const bot = new Bot(settings.BOT_TOKEN, { botInfo: { id: 123456, is_bot: true, first_name: 'SQUAD', username: 'squad_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } });
  const apiCalls: Array<{ method: string; payload: any }> = []; let sequence = 0;
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload }); return { ok: true, result: method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: adminId, type: 'private' }, text: 'test' } : true } as any;
  });
  const service = { execute: vi.fn(async () => ({ text: 'Admin result' })), callback: vi.fn(async () => ({ text: 'Contact result' })), recordRateLimit: vi.fn(async () => undefined) };
  const prisma = { user: { updateMany: vi.fn(async () => ({ count: 1 })) } };
  registerBotHandlers(bot, settings, prisma as unknown as PrismaClient, service as unknown as AdminService);
  function message(text: string, options: { id?: number; language?: string; group?: boolean } = {}) {
    const sender = options.id ?? adminId;
    return bot.handleUpdate({ update_id: ++sequence, message: { message_id: sequence, date: 0, from: { id: sender, is_bot: false, first_name: 'Test', language_code: options.language ?? 'ru' },
      chat: options.group ? { id: -123456, type: 'group', title: 'Group' } : { id: sender, type: 'private', first_name: 'Test' }, text,
      ...(text.startsWith('/') ? { entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] } : {}) } });
  }
  function callback(data: string, options: { id?: number; group?: boolean; inline?: boolean } = {}) {
    const sender = options.id ?? adminId;
    return bot.handleUpdate({ update_id: ++sequence, callback_query: { id: String(sequence), from: { id: sender, is_bot: false, first_name: 'Test', language_code: 'ru' }, chat_instance: 'test', data,
      ...(options.inline ? { inline_message_id: 'inline' } : { message: { message_id: 1, date: 0, chat: options.group ? { id: -123456, type: 'group' as const, title: 'Group' } : { id: sender, type: 'private' as const, first_name: 'Test' }, text: 'test' } }) } });
  }
  return { bot, service, prisma, apiCalls, message, callback, replies: () => apiCalls.filter((call) => call.method === 'sendMessage').map((call) => call.payload.text as string) };
}
describe('private admin command authorization', () => {
  it.each(['admin', 'reports', 'report', 'user', 'ban', 'unban', 'hide', 'unhide', 'dismiss', 'action', 'stats'])('/%s from a non-admin gets exactly the ordinary unknown reply', async (command) => {
    const h = harness(); await h.message(`/${command} unknown`, { id: 987654321 }); await h.message('/unrecognized', { id: 987654321 });
    expect(h.replies()).toEqual(['Неизвестная команда. Используйте /help.', 'Неизвестная команда. Используйте /help.']); expect(h.service.execute).not.toHaveBeenCalled();
  });
  it('empty admin list disables every admin capability', async () => {
    const h = harness({ ...config, ADMIN_TELEGRAM_IDS: [] }); await h.message('/stats'); await h.callback(`mc:00000000-0000-4000-8000-000000000001`);
    expect(h.service.execute).not.toHaveBeenCalled(); expect(h.service.callback).not.toHaveBeenCalled(); expect(h.apiCalls.at(-1)?.payload.text).toBe('Неизвестная команда. Используйте /help.');
  });
  it.each(['admin', 'reports', 'report', 'user', 'ban', 'unban', 'hide', 'unhide', 'dismiss', 'action', 'stats'])('/%s is completely ignored in group chats', async (command) => {
    const h = harness(); await h.message(`/${command} any`, { group: true }); expect(h.apiCalls).toHaveLength(0); expect(h.service.execute).not.toHaveBeenCalled();
  });
  it.each(['admin', 'reports', 'report', 'user', 'ban', 'unban', 'hide', 'unhide', 'dismiss', 'action', 'stats'])('/%s dispatches only for the configured private admin', async (command) => {
    const h = harness(); await h.message(`/${command} internal-argument`); expect(h.service.execute).toHaveBeenCalledWith(String(adminId), command, 'internal-argument', 'ru'); expect(h.replies()).toEqual(['Admin result']);
  });
  it('private callbacks acknowledge the spinner and route a validated opaque token', async () => {
    const h = harness(); const callback = `ma:${'a'.repeat(32)}`; await h.callback(callback);
    expect(h.apiCalls[0]?.method).toBe('answerCallbackQuery'); expect(h.service.callback).toHaveBeenCalledWith(String(adminId), callback, 'ru');
  });
  it('stranger, group and inline callbacks never reach admin methods', async () => {
    const h = harness(); await h.callback(`ma:${'a'.repeat(32)}`, { id: 987654321 }); await h.callback(`ma:${'a'.repeat(32)}`, { group: true }); await h.callback(`ma:${'a'.repeat(32)}`, { inline: true });
    expect(h.service.callback).not.toHaveBeenCalled(); expect(h.apiCalls).toHaveLength(1);
  });
  it('returns a fixed localized failure without raw exception text', async () => {
    const h = harness(); h.service.execute.mockRejectedValueOnce(new AdminError('missing')); await h.message('/user missing', { language: 'en' });
    expect(h.replies()).toEqual(['Record not found.']); h.service.callback.mockRejectedValueOnce(new Error('https://SECRET @private')); await h.callback('invalid');
    expect(h.replies().at(-1)).toBe('Не удалось выполнить команду. Проверьте формат /admin.'); expect(h.replies().join()).not.toMatch(/SECRET|@private/);
  });
  it('enforces one 30/minute admin quota across commands and callbacks', async () => {
    const h = harness(); for (let i = 0; i < 30; i++) await h.message('/stats'); await h.callback(`ma:${'a'.repeat(32)}`); await h.message('/stats');
    expect(h.service.execute).toHaveBeenCalledTimes(30); expect(h.service.callback).not.toHaveBeenCalled(); expect(h.replies().at(-1)).toContain('Подождите минуту'); expect(h.service.recordRateLimit).toHaveBeenCalledTimes(2);
  });
});
describe('rules, privacy and help', () => {
  it.each(['rules', 'privacy', 'help'] as const)('/%s and its fixed start deep-link show the same localized text privately', async (command) => {
    const h = harness(); await h.message(`/${command}`); await h.message(`/start ${command}`);
    expect(h.replies()).toEqual([legalText(command, config, 'ru'), legalText(command, config, 'ru')]); expect(h.prisma.user.updateMany).not.toHaveBeenCalled();
  });
  it('interpolates age/retention/support, includes factual mutual-consent and deletion rules, with English fallback', () => {
    expect(legalText('rules', { ...config, AGE_MINIMUM: 21 })).toContain('21');
    const privacy = legalText('privacy', { ...config, REPORT_RETENTION_DAYS: 200 }, 'en-US'); expect(privacy).toContain('200 days'); expect(privacy).toContain('sender\'s consent'); expect(privacy).toContain('anonymized');
    expect(legalText('help', config)).toContain('контакт поддержки пока не настроен'); expect(legalText('help', { ...config, SUPPORT_CONTACT: '@support' }, 'en')).toContain('@support');
  });
  it('private start clears known bot blocking and installs the current Mini App URL', async () => {
    const h = harness(); await h.message('/start'); expect(h.prisma.user.updateMany).toHaveBeenCalledWith({ where: { telegramId: BigInt(adminId) }, data: { botBlocked: false } });
    expect(h.apiCalls.find((call) => call.method === 'setChatMenuButton')?.payload.menu_button.web_app.url).toBe(config.MINIAPP_URL);
  });
  it('legal and start commands are ignored in groups', async () => {
    const h = harness(); for (const command of ['start', 'rules', 'privacy', 'help']) await h.message(`/${command}`, { group: true }); expect(h.apiCalls).toHaveLength(0);
  });
});
