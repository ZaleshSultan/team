import type { PlayerProfileInput, ProfileOptions, VerificationBadges } from '@squad/shared';

/** Game-specific verification, stats mapping and filters belong to implementations in M3+. */
export interface GameProvider {
  readonly slug: string;
  readonly steamAppId: number | null;
  readonly profileOptions: ProfileOptions;
  validateProfile(input: unknown): PlayerProfileInput;
  isVerified(accounts: { steamId64: string | null; faceitSteamId64: string | null }): VerificationBadges;
}
