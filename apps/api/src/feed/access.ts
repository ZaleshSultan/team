import type { FeedRequirement } from '@squad/shared';
import type { SessionUser } from '../auth/session.js';
import type { Config } from '../config.js';
import { toAuthUser } from '../auth/routes.js';
import { AppError } from '../errors.js';

export class FeedAccessError extends AppError {
  constructor(public readonly requirements: FeedRequirement[]) {
    super(409, 'FEED_REQUIREMENTS_MISSING', 'Complete the feed access requirements');
  }
}

export function feedRequirements(user: SessionUser, hasPublishedProfile: boolean,
  config: Config): FeedRequirement[] {
  const requirements: FeedRequirement[] = [];
  if (toAuthUser(user, config).onboarding.required) requirements.push({ code: 'ONBOARDING_INCOMPLETE' });
  if (!user.steamAccount) requirements.push({ code: 'STEAM_REQUIRED' });
  if (config.FEED_REQUIRES_PUBLISHED_PROFILE && !hasPublishedProfile) requirements.push({ code: 'PUBLISHED_PROFILE_REQUIRED' });
  return requirements;
}
