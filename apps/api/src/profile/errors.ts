import type { PublishRequirement } from '@squad/shared';
import { AppError } from '../errors.js';

export class PublishGateError extends AppError {
  constructor(public readonly requirements: PublishRequirement[]) {
    super(requirements.some((item) => item.code === 'USER_BANNED') ? 403 : 409,
      'PUBLISH_REQUIREMENTS_MISSING', 'Complete the profile publication requirements');
  }
}
