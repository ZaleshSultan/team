import { z } from 'zod';
import { notificationSettingsSchema } from '@squad/shared';

const configSchema = z.object({
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'must be a valid Telegram bot token'),
  MINIAPP_URL: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'must use HTTPS'),
  DATABASE_URL: z.string().url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  REDIS_URL: z.string().url().refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol)),
  AGE_MINIMUM: z.coerce.number().int().min(13).max(99).default(18),
  RULES_VERSION: z.string().min(1).max(40).default('2026-10-07'),
  ...notificationSettingsSchema.shape,
});

export function loadConfig(environment: NodeJS.ProcessEnv) {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid bot configuration: ${fields}. Check the environment file.`);
  }
  return parsed.data;
}

export type BotConfig = ReturnType<typeof loadConfig>;
