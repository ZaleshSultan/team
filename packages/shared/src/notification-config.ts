import { z } from 'zod';

export const notificationSettingsSchema = z.object({
  NOTIFICATION_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  NOTIFICATION_RATE_LIMIT_PER_SECOND: z.coerce.number().int().min(1).max(25).default(25),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  NOTIFICATION_BACKOFF_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  TELEGRAM_CONTACT_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(5_000),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const NOTIFICATION_QUEUE_NAME = 'notifications';
export const REQUEST_MAINTENANCE_QUEUE_NAME = 'squad-requests-maintenance-v1';
export const REQUEST_MAINTENANCE_INTERVAL_MS = 60_000;
export const NOTIFICATION_BATCH_SIZE = 100;
export const NOTIFICATION_CLAIM_MS = 60_000;

// BullMQ rejects ':' in custom IDs. A DB delivery marker also protects against
// duplicate jobs after automatic Redis job removal or a Redis restart.
export function notificationJobId(requestId: string, kind: 'CREATED' | 'ACCEPTED'): string {
  if (!z.string().uuid().safeParse(requestId).success) throw new Error('INVALID_NOTIFICATION_ID');
  return `request-${requestId}-${kind.toLowerCase()}`;
}

export function notificationRetryDelay(attempt: number, baseMs: number, retryAfterMs = 0): number {
  const exponential = Math.min(60_000, baseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 10));
  const retryAfter = Number.isFinite(retryAfterMs) ? Math.max(0, Math.min(retryAfterMs, 3_600_000)) : 0;
  return Math.max(exponential, retryAfter);
}
