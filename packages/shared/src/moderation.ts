import { z } from 'zod';
import { normalizeProfileText, publicPlayerCardSchema } from './profile.js';
import { requestListQuerySchema } from './requests.js';
import { NOTIFICATION_QUEUE_NAME } from './notification-config.js';

export const reportReasonSchema = z.enum(['SPAM', 'HARASSMENT', 'CHEATING', 'FAKE_PROFILE', 'CONTACT_SPAM', 'UNDERAGE', 'OTHER']);
export type ReportReason = z.infer<typeof reportReasonSchema>;
export const reportStatusSchema = z.enum(['OPEN', 'REVIEWED', 'ACTIONED', 'DISMISSED']);
export const privateModerationTextSchema = z.string().max(4_000).transform(normalizeProfileText)
  .refine((value) => Array.from(value).length <= 500, 'TOO_LONG');
export const reportInputSchema = z.object({
  profileId: z.string().uuid().optional(), requestId: z.string().uuid().optional(),
  reason: reportReasonSchema, details: privateModerationTextSchema.optional(),
}).strict().refine((value) => Boolean(value.profileId) !== Boolean(value.requestId), 'REPORT_TARGET_REQUIRED');
export type ReportInput = z.infer<typeof reportInputSchema>;
export const reportResponseSchema = z.object({
  report: z.object({ id: z.string().uuid(), status: reportStatusSchema, createdAt: z.string().datetime() }).strict(),
  duplicate: z.boolean(),
}).strict();
export type ReportResponse = z.infer<typeof reportResponseSchema>;

export const blockListQuerySchema = requestListQuerySchema;
export type BlockListQuery = z.infer<typeof blockListQuerySchema>;
export const blockListResponseSchema = z.object({
  items: z.array(z.object({ profileId: z.string().uuid(), player: publicPlayerCardSchema.nullable(),
    createdAt: z.string().datetime() }).strict()).max(50), nextCursor: z.string().nullable(),
}).strict();
export type BlockListResponse = z.infer<typeof blockListResponseSchema>;

export const moderationSettingsSchema = z.object({
  REPORTS_PER_DAY: z.coerce.number().int().min(1).max(100).default(10),
  REPORTS_AUTO_HIDE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(3),
  REPORTS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(10),
  REPORT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(180),
});
export type ModerationSettings = z.infer<typeof moderationSettingsSchema>;
export const communityInfoSchema = z.object({ botUsername: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
  minimumAge: z.number().int().min(13).max(99), rulesVersion: z.string().min(1).max(40),
  supportContact: z.string() }).strict();
export type CommunityInfo = z.infer<typeof communityInfoSchema>;
export const moderationNotificationJobSchema = z.object({ eventId: z.string().uuid() }).strict();
export const MODERATION_NOTIFICATION_QUEUE_NAME = NOTIFICATION_QUEUE_NAME;
export function moderationNotificationJobId(eventId: string): string {
  return `moderation-${z.string().uuid().parse(eventId)}`;
}
