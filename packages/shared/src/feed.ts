import { z } from 'zod';
import { publicPlayerCardSchema } from './profile.js';

// Transport shape only. The selected GameProvider owns allowed option values.
const filterValues = z.array(z.string().min(1).max(50)).max(50).default([]);
export const feedFiltersSchema = z.object({
  faceitLevelMin: z.number().int().min(1).max(10).optional(),
  faceitLevelMax: z.number().int().min(1).max(10).optional(),
  roles: filterValues, languages: filterValues, regions: filterValues,
  lookingFor: filterValues, playTimes: filterValues,
  hasMic: z.boolean().optional(), verifiedOnly: z.boolean().default(false),
  noBans: z.boolean().default(true),
}).strict().superRefine((filters, ctx) => {
  if (filters.faceitLevelMin !== undefined && filters.faceitLevelMax !== undefined
    && filters.faceitLevelMin > filters.faceitLevelMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['faceitLevelMax'], message: 'Invalid FACEIT level range' });
  }
});
export type FeedFilters = z.infer<typeof feedFiltersSchema>;

export const feedQuerySchema = z.object({
  filters: feedFiltersSchema,
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(4096).optional(),
}).strict();
export type FeedQuery = z.infer<typeof feedQuerySchema>;

export const feedRequirementSchema = z.object({
  code: z.enum(['ONBOARDING_INCOMPLETE', 'STEAM_REQUIRED', 'PUBLISHED_PROFILE_REQUIRED']),
}).strict();
export type FeedRequirement = z.infer<typeof feedRequirementSchema>;

export const feedResponseSchema = z.object({
  items: z.array(publicPlayerCardSchema).max(50), nextCursor: z.string().nullable(),
}).strict();
export type FeedResponse = z.infer<typeof feedResponseSchema>;
