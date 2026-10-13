import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { Bot, GrammyError, HttpError } from 'grammy';
import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config.js';
import { startNotificationWorker } from './worker.js';
import { registerBotHandlers } from './handlers.js';
import { AdminService } from './admin.js';
import { TelegramContacts } from '@squad/shared';
import { startBotHealth, writeBotHealth } from './health.js';

loadDotEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const config = loadConfig(process.env);
const bot = new Bot(config.BOT_TOKEN);
const prisma = new PrismaClient({ datasourceUrl: config.DATABASE_URL, log: [] });

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
let notifications: Awaited<ReturnType<typeof startNotificationWorker>> | undefined;
let health: ReturnType<typeof startBotHealth> | undefined;
registerBotHandlers(bot, config, prisma, new AdminService(prisma, config,
  new TelegramContacts(config.BOT_TOKEN, { timeoutMs: config.TELEGRAM_CONTACT_TIMEOUT_MS }),
  async () => notifications?.dispatchModeration()));
async function stop() {
  if (stopping) return;
  stopping = true;
  await health?.stop();
  await writeBotHealth(false).catch(() => undefined);
  if (bot.isRunning()) await bot.stop().catch(() => undefined);
  await notifications?.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

try {
  await prisma.$connect();
  notifications = await startNotificationWorker(config, prisma);
  health = startBotHealth(async () => {
    if (!bot.isRunning() || stopping || !notifications) return false;
    await prisma.$queryRaw`SELECT 1`;
    return notifications.isHealthy();
  });
  if (stopping) await notifications.close();
  else
  await bot.start({ onStart: () => console.info('SQUAD bot started') });
} catch {
  console.error('Bot startup failed. Check token and network connectivity.');
  process.exitCode = 1;
} finally {
  await stop();
}
