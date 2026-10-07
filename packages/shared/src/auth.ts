import { z } from 'zod';

const locale = z.enum(['ru', 'en']);
export const telegramAuthInputSchema = z.object({ initData: z.string().min(1).max(16_384) }).strict();
export const authUserSchema = z.object({
  id: z.string().uuid(),
  telegramId: z.string().regex(/^\d+$/),
  username: z.string().min(1).max(32).nullable(),
  language: locale,
  onboarding: z.object({
    required: z.boolean(),
    ageConfirmed: z.boolean(),
    rulesAccepted: z.boolean(),
    minimumAge: z.number().int().min(13),
    rulesVersion: z.string(),
    usernameRequired: z.literal(true),
  }),
  steam: z.object({ steamId64: z.string().regex(/^\d{17}$/), linkedAt: z.string().datetime() }).nullable(),
  privacy: z.object({ shareSteamActivity: z.boolean() }),
});
export const authResponseSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string().datetime(), user: authUserSchema });
export const meResponseSchema = z.object({ user: authUserSchema });
export const onboardingInputSchema = z.object({
  ageConfirmed: z.literal(true),
  minimumAge: z.number().int().min(13).max(99),
  rulesAccepted: z.literal(true),
  rulesVersion: z.string().min(1).max(40),
  language: locale,
  shareSteamActivity: z.boolean(),
}).strict();
export const steamLinkResponseSchema = z.object({ id: z.string().uuid(), url: z.string().url(), expiresAt: z.string().datetime() });
export const steamLinkStatusResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['PENDING', 'STARTED', 'VERIFYING', 'COMPLETED', 'FAILED', 'EXPIRED']),
  expiresAt: z.string().datetime(),
  failureCode: z.string().nullable(),
});
export const emptyInputSchema = z.object({}).strict();
export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type SteamLinkResponse = z.infer<typeof steamLinkResponseSchema>;
export type SteamLinkStatusResponse = z.infer<typeof steamLinkStatusResponseSchema>;
export type OnboardingInput = z.infer<typeof onboardingInputSchema>;
