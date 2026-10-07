import type { AuthUser, OnboardingInput } from '@squad/shared';

export interface OnboardingChoices {
  minimumAgeConfirmed: number | null;
  rulesVersionAccepted: string | null;
  shareSteamActivity: boolean;
}

/** Bind each checkbox to the exact policy the player actually saw. */
export function createOnboardingSubmission(
  user: AuthUser,
  choices: OnboardingChoices,
  language: 'ru' | 'en',
): OnboardingInput | null {
  if (!user.username
    || choices.minimumAgeConfirmed !== user.onboarding.minimumAge
    || choices.rulesVersionAccepted !== user.onboarding.rulesVersion) return null;
  return {
    ageConfirmed: true,
    minimumAge: user.onboarding.minimumAge,
    rulesAccepted: true,
    rulesVersion: user.onboarding.rulesVersion,
    language,
    shareSteamActivity: choices.shareSteamActivity,
  };
}
