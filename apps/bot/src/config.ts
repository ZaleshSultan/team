import { z } from 'zod';
import { adminSettingsSchema, moderationSettingsSchema, notificationSettingsSchema } from '@squad/shared';

const urlProtocol = (value: string, protocols: string[]) => URL.canParse(value) && protocols.includes(new URL(value).protocol);

const configSchema = z.object({
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'must be a valid Telegram bot token'),
  MINIAPP_URL: z.string().url().refine((value) => urlProtocol(value, ['https:']), 'must use HTTPS'),
  DATABASE_URL: z.string().url().refine((value) => urlProtocol(value, ['postgres:', 'postgresql:'])),
  REDIS_URL: z.string().url().refine((value) => urlProtocol(value, ['redis:', 'rediss:'])),
  AGE_MINIMUM: z.coerce.number().int().min(13).max(99).default(18),
  RULES_VERSION: z.string().min(1).max(40).default('2026-10-07'),
  ...notificationSettingsSchema.shape,
  ...adminSettingsSchema.shape,
  REPORT_RETENTION_DAYS: moderationSettingsSchema.shape.REPORT_RETENTION_DAYS,
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
