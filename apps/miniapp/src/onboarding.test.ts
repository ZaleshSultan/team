import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@squad/shared';
import { createOnboardingSubmission } from './onboarding.js';

const user: AuthUser = {
  id: 'b3a0b6dd-662e-44a5-9581-c2a3cf075e58',
  telegramId: '123456789',
  username: 'test_player',
  language: 'ru',
  onboarding: { required: true, ageConfirmed: false, rulesAccepted: false, minimumAge: 18, rulesVersion: '2026-10-07', usernameRequired: true },
  steam: null,
  privacy: { shareSteamActivity: false },
};
const acceptedChoices = { minimumAgeConfirmed: 18, rulesVersionAccepted: '2026-10-07', shareSteamActivity: false };

describe('onboarding consent submission', () => {
  it.each([
    { minimumAge: 21, rulesVersion: '2026-10-07' },
    { minimumAge: 18, rulesVersion: '2026-11-01' },
  ])('requires fresh confirmation when the server policy changes to %o', (updatedPolicy) => {
    const updatedUser = { ...user, onboarding: { ...user.onboarding, ...updatedPolicy } };
    expect(createOnboardingSubmission(updatedUser, acceptedChoices, 'ru')).toBeNull();
    expect(createOnboardingSubmission(updatedUser, {
      minimumAgeConfirmed: updatedPolicy.minimumAge,
      rulesVersionAccepted: updatedPolicy.rulesVersion,
      shareSteamActivity: false,
    }, 'ru')).toMatchObject(updatedPolicy);
  });

  it('preserves current consent choices across a username refresh', () => {
    expect(createOnboardingSubmission({ ...user, username: 'updated_player' }, acceptedChoices, 'en')).toEqual({
      ageConfirmed: true,
      minimumAge: 18,
      rulesAccepted: true,
      rulesVersion: '2026-10-07',
      language: 'en',
      shareSteamActivity: false,
    });
  });

  it('does not produce a submission without username or both explicit confirmations', () => {
    expect(createOnboardingSubmission({ ...user, username: null }, acceptedChoices, 'ru')).toBeNull();
    expect(createOnboardingSubmission(user, { ...acceptedChoices, minimumAgeConfirmed: null }, 'ru')).toBeNull();
    expect(createOnboardingSubmission(user, { ...acceptedChoices, rulesVersionAccepted: null }, 'ru')).toBeNull();
  });

  it('keeps optional activity sharing independent from required age and rules consent', () => {
    expect(createOnboardingSubmission(user, acceptedChoices, 'ru')?.shareSteamActivity).toBe(false);
    expect(createOnboardingSubmission(user, { ...acceptedChoices, shareSteamActivity: true }, 'ru')?.shareSteamActivity).toBe(true);
  });
});
