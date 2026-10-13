import { z } from 'zod';
import type { ProfileOptions } from './profile.js';

const adminId = z.string().regex(/^[1-9]\d{0,15}$/).refine((value) => Number.isSafeInteger(Number(value)));
export const adminSettingsSchema = z.object({
  ADMIN_TELEGRAM_IDS: z.string().default('').transform((value) => [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))])
    .pipe(z.array(adminId).max(100)),
  SUPPORT_CONTACT: z.string().trim().max(100).default('').refine((value) => value === ''
    || /^@[A-Za-z0-9_]{1,32}$/.test(value) || /^https:\/\/t\.me\/[A-Za-z0-9_]{1,32}$/.test(value)),
});

/** Shared provider allowlist used by the API and the isolated bot admin gate. */
export const CS2_PROFILE_OPTIONS: ProfileOptions = {
  roles: ['entry', 'awp', 'support', 'lurk', 'igl'],
  lookingFor: ['duo', 'five_stack', 'team'],
  playTimes: ['morning', 'day', 'evening', 'night'],
  languages: ['ru', 'kk', 'en', 'de', 'fr', 'es', 'it', 'pt', 'tr', 'uk', 'pl', 'uz', 'ky', 'tg', 'az', 'hy', 'ka', 'be', 'zh', 'ko', 'ja', 'ar'],
  regions: ['KZ', 'RU', 'CIS', 'EU', 'OTHER'],
};

export const adminCommandSchema = z.enum(['admin', 'reports', 'report', 'user', 'ban', 'unban', 'hide', 'unhide', 'dismiss', 'action', 'stats']);
export type AdminCommand = z.infer<typeof adminCommandSchema>;
export const adminIdInputSchema = z.object({ id: z.string().uuid() }).strict();
export const adminNoteInputSchema = adminIdInputSchema.extend({ note: z.string().max(2_000).optional() }).strict();
export const adminConfirmationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const adminCallbackSchema = z.string().max(64).regex(/^(?:ma:[A-Za-z0-9_-]{32}|mc:[a-f\d-]{36}|mr:[a-z\d]+:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{11})$/);
