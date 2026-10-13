import { z } from 'zod';
import { profileFieldSchema, profileValidationIssueSchema, publishRequirementSchema } from './profile.js';
import { feedRequirementSchema } from './feed.js';
export * from './auth.js';
export * from './providers.js';
export * from './stats.js';
export * from './profile.js';
export * from './feed.js';
export * from './requests.js';
export * from './notifications.js';
export * from './telegram-contact.js';
export * from './notification-config.js';

export const languageSchema = z.enum(['ru', 'en']);
export type Language = z.infer<typeof languageSchema>;
export const roleSchema = z.enum(['entry', 'awp', 'support', 'lurk', 'igl']);
export const lookingForSchema = z.enum(['duo', 'five_stack', 'team']);
export const playTimeSchema = z.enum(['morning', 'day', 'evening', 'night']);
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional(), requestId: z.string().optional(),
    field: profileFieldSchema.optional(), issues: z.array(profileValidationIssueSchema).optional(), requirements: z.array(z.union([publishRequirementSchema, feedRequirementSchema])).optional(), resetAt: z.string().datetime().optional() }),
});
export const healthResponseSchema = z.object({ status: z.literal('ok') });
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
