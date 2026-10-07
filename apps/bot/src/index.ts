import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { loadConfig } from './config.js';
import ru from './locales/ru.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };

loadDotEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const config = loadConfig(process.env);
const bot = new Bot(config.BOT_TOKEN);

bot.command('start', async (context) => {
  const messages = context.from?.language_code?.startsWith('en') ? en : ru;
  if (context.chat.type !== 'private') return;
  await context.api.setChatMenuButton({
    chat_id: context.chat.id,
    menu_button: { type: 'web_app', text: messages.open, web_app: { url: config.MINIAPP_URL } },
  });
  await context.reply(messages.start, {
    reply_markup: new InlineKeyboard().webApp(messages.open, config.MINIAPP_URL),
  });
});

bot.catch((error) => {
  const cause = error.error;
  // Full SDK errors can include the token-bearing request URL.
  if (cause instanceof GrammyError) {
    console.error('Telegram API operation failed', { code: cause.error_code });
  } else if (cause instanceof HttpError) {
    console.error('Telegram network operation failed');
  } else {
    console.error('Bot update processing failed');
  }
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void bot.stop();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await bot.start({ onStart: () => console.info('SQUAD bot started') });
} catch {
  console.error('Bot startup failed. Check token and network connectivity.');
  process.exitCode = 1;
}
