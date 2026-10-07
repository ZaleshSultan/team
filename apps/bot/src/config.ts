import { z } from 'zod';

const configSchema = z.object({
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'must be a valid Telegram bot token'),
  MINIAPP_URL: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'must use HTTPS'),
});

export function loadConfig(environment: NodeJS.ProcessEnv) {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid bot configuration: ${fields}. Check the environment file.`);
  }
  return parsed.data;
}
