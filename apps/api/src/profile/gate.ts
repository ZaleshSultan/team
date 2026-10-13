import type { PlayerProfile } from '@prisma/client';
import type { ProfileField, PublishRequirement } from '@squad/shared';
import type { Config } from '../config.js';
import type { GameProvider } from '../games/provider.js';

interface PublishUser {
  username: string | null; ageConfirmedAt: Date | null; ageMinimumConfirmed: number | null;
  rulesAcceptedAt: Date | null; rulesVersion: string | null; isBanned: boolean;
  steamAccount: { steamId64: bigint } | null;
}

export function profileInput(profile: Pick<PlayerProfile, 'nickname' | 'roles' | 'lookingFor' | 'playTimes' | 'languages' | 'region' | 'hasMic' | 'bio'>) {
  return { nickname: profile.nickname, roles: profile.roles, lookingFor: profile.lookingFor,
    playTimes: profile.playTimes, languages: profile.languages, region: profile.region,
    hasMic: profile.hasMic, bio: profile.bio };
}

export function publishRequirements(user: PublishUser, profile: PlayerProfile | null,
  provider: GameProvider, config: Pick<Config, 'AGE_MINIMUM' | 'RULES_VERSION'>): PublishRequirement[] {
  const missing: PublishRequirement[] = [];
  if (!user.username || !user.ageConfirmedAt || user.ageMinimumConfirmed !== config.AGE_MINIMUM
    || !user.rulesAcceptedAt || user.rulesVersion !== config.RULES_VERSION) missing.push({ code: 'ONBOARDING_INCOMPLETE' });
  if (!user.steamAccount) missing.push({ code: 'STEAM_REQUIRED' });
  if (!profile) missing.push({ code: 'PROFILE_INCOMPLETE' });
  else {
    if (profile.moderationHidden) missing.push({ code: 'MODERATION_HIDDEN' });
    const fields: ProfileField[] = (['roles', 'lookingFor', 'playTimes', 'languages'] as const).filter((field) => !profile[field].length);
    if (!profile.region.trim()) fields.push('region');
    if (fields.length) missing.push({ code: 'PROFILE_INCOMPLETE', fields });
    try { provider.validateProfile({ ...profileInput(profile), gameSlug: provider.slug }); }
    catch { missing.push({ code: 'PROFILE_INVALID' }); }
  }
  if (user.isBanned) missing.push({ code: 'USER_BANNED' });
  return missing;
}
