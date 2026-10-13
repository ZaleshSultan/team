import { z } from 'zod';

/** Values offered by a game provider; the provider owns their allow-lists. */
export const profileOptionsSchema = z.object({
  roles: z.array(z.string()), lookingFor: z.array(z.string()), playTimes: z.array(z.string()),
  languages: z.array(z.string()), regions: z.array(z.string()),
}).strict();
export type ProfileOptions = z.infer<typeof profileOptionsSchema>;

export const profileFieldSchema = z.enum(['profile', 'gameSlug', 'nickname', 'roles', 'lookingFor', 'playTimes', 'languages', 'region', 'hasMic', 'bio']);
export type ProfileField = z.infer<typeof profileFieldSchema>;
export const profileValidationCodeSchema = z.enum(['REQUIRED', 'INVALID_TYPE', 'INVALID_OPTION', 'TOO_MANY', 'TOO_SHORT', 'TOO_LONG', 'INVALID_FORMAT', 'CONTACTS_NOT_ALLOWED', 'UNKNOWN_FIELD']);
export type ProfileValidationCode = z.infer<typeof profileValidationCodeSchema>;
export const profileValidationIssueSchema = z.object({ field: profileFieldSchema, code: profileValidationCodeSchema }).strict();
export type ProfileValidationIssue = z.infer<typeof profileValidationIssueSchema>;

/** Structural transport contract only. A provider validates all game-specific rules. */
export const profileUpdateInputSchema = z.object({
  nickname: z.string().nullable(), roles: z.array(z.string()), lookingFor: z.array(z.string()),
  playTimes: z.array(z.string()), languages: z.array(z.string()), region: z.string(),
  hasMic: z.boolean(), bio: z.string(),
}).strict();
export type ProfileUpdateInput = z.infer<typeof profileUpdateInputSchema>;
export const playerProfileInputSchema = profileUpdateInputSchema.extend({ gameSlug: z.string() }).strict();
export type PlayerProfileInput = z.infer<typeof playerProfileInputSchema>;
/** Compatibility name retained for existing callers. */
export const cs2ProfileSchema = playerProfileInputSchema;
export type Cs2ProfileInput = PlayerProfileInput;

export const verificationBadgesSchema = z.object({ steamVerified: z.boolean(), faceitVerified: z.boolean() }).strict();
export type VerificationBadges = z.infer<typeof verificationBadgesSchema>;
export const publishRequirementSchema = z.object({
  code: z.enum(['ONBOARDING_INCOMPLETE', 'STEAM_REQUIRED', 'PROFILE_INCOMPLETE', 'PROFILE_INVALID', 'USER_BANNED']),
  fields: z.array(profileFieldSchema).optional(),
}).strict();
export type PublishRequirement = z.infer<typeof publishRequirementSchema>;
export const publishInputSchema = z.object({ published: z.boolean() }).strict();
export const publishResponseSchema = z.object({ published: z.boolean(), requirements: z.array(publishRequirementSchema) }).strict();
export type PublishResponse = z.infer<typeof publishResponseSchema>;
export const privacyInputSchema = z.object({ shareSteamActivity: z.boolean() }).strict();
export const profileRecordSchema = playerProfileInputSchema.extend({ id: z.string().uuid(), updatedAt: z.string().datetime() }).strict();
export type ProfileRecord = z.infer<typeof profileRecordSchema>;
export const profileResponseSchema = z.object({
  profile: profileRecordSchema.nullable(), published: z.boolean(), requirements: z.array(publishRequirementSchema),
  privacy: privacyInputSchema, badges: verificationBadgesSchema, options: profileOptionsSchema,
}).strict();
export type ProfileResponse = z.infer<typeof profileResponseSchema>;

/** Closed public projection: adding a private field must fail rather than leak it. */
export const publicPlayerCardSchema = profileUpdateInputSchema.extend({
  id: z.string().uuid(), nickname: z.string().nullable(), badges: verificationBadgesSchema,
  faceit: z.object({ level: z.number().int().min(1).max(10).nullable(), elo: z.number().int().nonnegative().nullable() }).strict().nullable(),
  hasBans: z.boolean().nullable(),
  activity: z.object({ cs2Hours: z.number().nonnegative().nullable(), cs2Hours2weeks: z.number().nonnegative().nullable() }).strict().optional(),
}).strict();
export type PublicPlayerCard = z.infer<typeof publicPlayerCardSchema>;

/** NFC and one-line whitespace; strip invisible controls before contact checks. */
export function normalizeProfileText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}\u034f\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, '').replace(/\s+/gu, ' ').trim().normalize('NFC');
}

const linkOrHandle = /@|(?:[a-z][a-z\d+.-]*:\/\/)|\b(?:https?:|www\s*\.)|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}(?=$|[^\p{L}\p{N}])/iu;
// Four complete 0–255 octets only; neither short dotted numbers nor A.B are IPs.
const ipv4Link = /(?:^|[^\p{L}\p{N}.])(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3}(?=$|[^\p{L}\p{N}.])/u;
// Seven or more digits with ordinary phone separators, including a leading +.
const phoneLike = /(?:\+?\p{Nd}[\s()._-]*){7,}/u;
function containsIpv6(text: string): boolean {
  // Validate address candidates rather than treating ordinary scores/times as
  // contacts. Compressed, full and IPv4-mapped forms are supported in browsers.
  const candidates = [...text.matchAll(/(?:^|[^\p{L}\p{N}:])((?:[a-f\d]{0,4}:){2,}[a-f\d:.]*)(?=$|[^\p{L}\p{N}:])/giu)];
  return candidates.some((match) => {
    const candidate = match[1]!;
    let address = candidate.replace(/\.+$/, '');
    if (address.includes('.')) {
      const colon = address.lastIndexOf(':'); const tail = address.slice(colon + 1).split('.');
      if (tail.length !== 4 || tail.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
      address = `${address.slice(0, colon + 1)}ffff:ffff`;
    }
    const halves = address.split('::');
    if (halves.length > 2) return false;
    const groups = halves.flatMap((half) => half ? half.split(':') : []);
    if (groups.some((group) => !/^[a-f\d]{1,4}$/iu.test(group))) return false;
    return halves.length === 2 ? groups.length < 8 : groups.length === 8;
  });
}
export function profileTextError(field: 'nickname' | 'bio', value: string | null): ProfileValidationCode | null {
  if (value === null) return field === 'nickname' ? null : 'INVALID_TYPE';
  const text = normalizeProfileText(value);
  // Check compatibility forms without changing the player's stored display text.
  // Browsers treat ideographic/fullwidth dots as ordinary hostname separators.
  const contactText = text.normalize('NFKC').replace(/[\u3002\uFF0E\uFF61]/gu, '.');
  if (linkOrHandle.test(contactText) || ipv4Link.test(contactText) || containsIpv6(contactText) || phoneLike.test(contactText)) return 'CONTACTS_NOT_ALLOWED';
  const length = Array.from(text).length;
  if (field === 'bio') return length > 500 ? 'TOO_LONG' : null;
  if (length === 0) return null;
  if (length < 2) return 'TOO_SHORT';
  if (length > 32) return 'TOO_LONG';
  return /^[\p{L}\p{Nd} _.-]+$/u.test(text) ? null : 'INVALID_FORMAT';
}
