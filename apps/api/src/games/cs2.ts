import { playerProfileInputSchema, normalizeProfileText, profileTextError, profileFieldSchema,
  CS2_PROFILE_OPTIONS, type PlayerProfileInput, type ProfileValidationIssue,
  type VerificationBadges } from '@squad/shared';
import { isSteamId64 } from '../stats/providers/http.js';
import type { GameProvider } from './provider.js';

export { CS2_PROFILE_OPTIONS } from '@squad/shared';

/** Contains fixed codes and known field names only; never retains untrusted input. */
export class ProfileValidationError extends Error {
  readonly code = 'PROFILE_VALIDATION_FAILED';
  constructor(readonly issues: ProfileValidationIssue[]) { super('PROFILE_VALIDATION_FAILED'); this.name = 'ProfileValidationError'; }
}

type Accounts = Parameters<GameProvider['isVerified']>[0];
export function isFaceitVerified(accounts: Accounts): boolean {
  return isSteamId64(accounts.steamId64) && accounts.faceitSteamId64 === accounts.steamId64;
}

/** Steam persona names cannot bypass public profile contact restrictions. */
export function safeDisplayNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = normalizeProfileText(value);
  return text && profileTextError('nickname', text) === null ? text : null;
}

export class Cs2GameProvider implements GameProvider {
  readonly slug = 'cs2';
  readonly steamAppId = 730;
  readonly profileOptions = CS2_PROFILE_OPTIONS;
  validateProfile(input: unknown): PlayerProfileInput {
    const parsed = playerProfileInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues: ProfileValidationIssue[] = parsed.error.issues.map((issue) => {
        const field = profileFieldSchema.safeParse(issue.path[0]);
        return { field: field.success ? field.data : 'profile', code: issue.code === 'unrecognized_keys' ? 'UNKNOWN_FIELD' : issue.code === 'invalid_type' && issue.received === 'undefined' ? 'REQUIRED' : 'INVALID_TYPE' };
      });
      throw new ProfileValidationError(issues);
    }
    const profile = parsed.data;
    const issues: ProfileValidationIssue[] = [];
    profile.gameSlug = normalizeProfileText(profile.gameSlug).toLowerCase();
    if (profile.gameSlug !== this.slug) issues.push({ field: 'gameSlug', code: 'INVALID_OPTION' });
    const lists: Array<{ field: 'roles' | 'lookingFor' | 'playTimes' | 'languages'; allowed: string[]; max: number }> = [
      { field: 'roles', allowed: this.profileOptions.roles, max: 3 },
      { field: 'lookingFor', allowed: this.profileOptions.lookingFor, max: 3 },
      { field: 'playTimes', allowed: this.profileOptions.playTimes, max: 4 },
      { field: 'languages', allowed: this.profileOptions.languages, max: 4 },
    ];
    for (const { field, allowed, max } of lists) {
      profile[field] = [...new Set(profile[field].map((value) => normalizeProfileText(value).toLowerCase()))];
      if (profile[field].length === 0) issues.push({ field, code: 'REQUIRED' });
      if (profile[field].length > max) issues.push({ field, code: 'TOO_MANY' });
      if (profile[field].some((value) => !allowed.includes(value))) issues.push({ field, code: 'INVALID_OPTION' });
    }
    profile.region = normalizeProfileText(profile.region).toUpperCase();
    if (!this.profileOptions.regions.includes(profile.region)) issues.push({ field: 'region', code: 'INVALID_OPTION' });
    profile.nickname = profile.nickname === null ? null : normalizeProfileText(profile.nickname) || null;
    profile.bio = normalizeProfileText(profile.bio);
    for (const field of ['nickname', 'bio'] as const) {
      const code = profileTextError(field, profile[field]);
      if (code) issues.push({ field, code });
    }
    if (issues.length) throw new ProfileValidationError(issues);
    return profile;
  }
  isVerified(accounts: Accounts): VerificationBadges {
    return { steamVerified: isSteamId64(accounts.steamId64), faceitVerified: isFaceitVerified(accounts) };
  }
}

export const cs2GameProvider = new Cs2GameProvider();
