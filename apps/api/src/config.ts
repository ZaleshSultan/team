import { z } from 'zod';
import { isIP } from 'node:net';

const trustedProxyEnv = z.string().default('false').transform((value, ctx): false | string[] => {
  if (value === 'false') return false;
  const addresses = value.split(',').map((item) => item.trim());
  const invalid = addresses.some((item) => {
    const [ip = '', prefix, extra] = item.split('/');
    const family = isIP(ip);
    return !family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)));
  });
  if (invalid || addresses.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use false or a comma-separated list of trusted proxy IPs/CIDRs' });
    return z.NEVER;
  }
  return addresses;
});
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), 'Must be a PostgreSQL URL'),
  REDIS_URL: z.string().url().refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol), 'Must be a Redis URL'),
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/),
  BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
  MINIAPP_URL: z.string().url(),
  PUBLIC_API_URL: z.string().url(),
  MINIAPP_ORIGIN: z.string().url(),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  TELEGRAM_AUTH_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(600).default(300),
  STEAM_LINK_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  AGE_MINIMUM: z.coerce.number().int().min(13).max(99).default(18),
  RULES_VERSION: z.string().min(1).max(40).default('2026-10-07'),
  TRUST_PROXY: trustedProxyEnv,
  REQUESTS_PER_DAY: z.coerce.number().int().min(1).max(100).default(10),
  STATS_REFRESH_HOURS: z.coerce.number().int().min(1).max(24).default(6),
  STATS_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  STATS_MANUAL_COOLDOWN_SECONDS: z.coerce.number().int().min(120).max(3600).default(300),
  STATS_STEAM_INTERVAL_MS: z.coerce.number().int().min(250).max(10_000).default(1000),
  STATS_FACEIT_INTERVAL_MS: z.coerce.number().int().min(250).max(10_000).default(1000),
  STEAM_WEB_API_KEY: z.string().optional(),
  FACEIT_API_KEY: z.string().optional(),
  ADMIN_TELEGRAM_IDS: z.string().default(''),
}).superRefine((env, ctx) => {
  for (const key of ['MINIAPP_URL', 'PUBLIC_API_URL', 'MINIAPP_ORIGIN'] as const) {
    const url = new URL(env[key]);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Must use HTTPS (localhost allowed for development)' });
    }
    if (url.username || url.password || url.search || url.hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Credentials, query and fragments are not allowed' });
    }
    if ((key === 'MINIAPP_ORIGIN' || key === 'PUBLIC_API_URL') && url.pathname !== '/') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Must be an origin without path' });
    }
  }
});

export type Config = z.infer<typeof envSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Do not print the raw environment or secrets in validation failures.
    throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return parsed.data;
}
