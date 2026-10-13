import type { PrismaClient } from '@prisma/client';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { adminCallbackSchema, adminCommandSchema } from '@squad/shared';
import type { BotConfig } from './config.js';
import { AdminError, AdminRateLimiter, type AdminReply, type AdminService } from './admin.js';
import ru from './locales/ru.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };

export const botMessages = (language?: string) => language?.startsWith('en') ? en : ru;
export function legalText(command: 'rules' | 'privacy' | 'help', config: BotConfig, language?: string) {
  const m = botMessages(language);
  return m[command].replace('{age}', String(config.AGE_MINIMUM)).replace('{retention}', String(config.REPORT_RETENTION_DAYS))
    .replace('{support}', config.SUPPORT_CONTACT || m.supportFallback);
}
export const authorizedAdmin = (context: Pick<Context, 'chat' | 'from'>, config: BotConfig) => context.chat?.type === 'private'
  && context.from !== undefined && context.chat.id === context.from.id && config.ADMIN_TELEGRAM_IDS.includes(String(context.from.id));

function reply(context: Context, value: AdminReply) {
  return context.reply(value.text, { ...(value.buttons ? { reply_markup: { inline_keyboard: value.buttons } } : {}), link_preview_options: { is_disabled: true } });
}
export function registerBotHandlers(bot: Bot, config: BotConfig, prisma: PrismaClient, admin: AdminService) {
  const limiter = new AdminRateLimiter();
  bot.command('start', async (context) => {
    if (context.chat.type !== 'private') return;
    const m = botMessages(context.from?.language_code);
    // Fixed public payloads never reveal admin commands or accept arbitrary text.
    const payload = String(context.match).trim();
    if (payload === 'rules' || payload === 'privacy' || payload === 'help') {
      await context.reply(legalText(payload, config, context.from?.language_code), { link_preview_options: { is_disabled: true } }); return;
    }
    await prisma.user.updateMany({ where: { telegramId: BigInt(context.chat.id) }, data: { botBlocked: false } });
    await context.api.setChatMenuButton({ chat_id: context.chat.id, menu_button: { type: 'web_app', text: m.open, web_app: { url: config.MINIAPP_URL } } });
    await context.reply(m.start, { reply_markup: new InlineKeyboard().webApp(m.open, config.MINIAPP_URL) });
  });
  for (const command of ['rules', 'privacy', 'help'] as const) bot.command(command, async (context) => {
    if (context.chat.type === 'private') await context.reply(legalText(command, config, context.from?.language_code), { link_preview_options: { is_disabled: true } });
  });
  for (const command of adminCommandSchema.options) bot.command(command, async (context) => {
    if (context.chat.type !== 'private') return;
    const m = botMessages(context.from?.language_code);
    if (!authorizedAdmin(context, config)) { await context.reply(m.unknownCommand); return; }
    if (!limiter.allow(String(context.from!.id))) { await admin.recordRateLimit(String(context.from!.id)).catch(() => undefined); await context.reply(m.admin.rateLimited); return; }
    try { await reply(context, await admin.execute(String(context.from!.id), command, String(context.match), context.from?.language_code)); }
    catch (error) { await context.reply(m.admin[error instanceof AdminError ? error.code : 'invalid']); }
  });
  bot.on('callback_query:data', async (context) => {
    if (context.chat?.type !== 'private') return;
    const m = botMessages(context.from.language_code);
    if (!authorizedAdmin(context, config)) { await context.answerCallbackQuery({ text: m.unknownCommand }); return; }
    if (!limiter.allow(String(context.from.id))) { await admin.recordRateLimit(String(context.from.id)).catch(() => undefined); await context.answerCallbackQuery({ text: m.admin.rateLimited }); return; }
    await context.answerCallbackQuery();
    try {
      const parsed = adminCallbackSchema.safeParse(context.callbackQuery.data);
      // Invalid callbacks are also recorded by the service's failure audit path.
      await reply(context, await admin.callback(String(context.from.id), parsed.success ? parsed.data : 'invalid', context.from.language_code));
    } catch (error) { await context.reply(m.admin[error instanceof AdminError ? error.code : 'invalid']); }
  });
  bot.on('message:text', async (context) => {
    if (context.chat.type === 'private') await context.reply(botMessages(context.from?.language_code).unknownCommand);
  });
}
