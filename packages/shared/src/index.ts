import { z } from 'zod';
export * from './auth.js';
export * from './providers.js';
export * from './stats.js';

export const languageSchema = z.enum(['ru', 'en']);
export type Language = z.infer<typeof languageSchema>;
export const roleSchema = z.enum(['entry', 'awp', 'support', 'lurk', 'igl']);
export const lookingForSchema = z.enum(['duo', 'five_stack', 'team']);
export const playTimeSchema = z.enum(['morning', 'afternoon', 'evening', 'night', 'flexible']);
export const cs2ProfileSchema = z.object({
  gameSlug: z.string().min(1).max(40),
  roles: z.array(roleSchema).min(1).max(5),
  hasMic: z.boolean(),
  languages: z.array(z.string().regex(/^[a-z]{2}$/)).min(1).max(8),
  region: z.string().min(2).max(40),
  playTimes: z.array(playTimeSchema).min(1).max(5),
  lookingFor: z.array(lookingForSchema).min(1).max(3),
  bio: z.string().max(500),
}).strict();
export type Cs2ProfileInput = z.infer<typeof cs2ProfileSchema>;
export interface PlayerProfileInput {
  gameSlug: string;
  roles: string[];
  hasMic: boolean;
  languages: string[];
  region: string;
  playTimes: string[];
  lookingFor: string[];
  bio: string;
}
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }),
});
export const healthResponseSchema = z.object({ status: z.literal('ok') });
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
