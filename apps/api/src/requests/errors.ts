import { AppError } from '../errors.js';

export class DailyRequestLimitError extends AppError {
  constructor(readonly resetAt: string) {
    super(429, 'DAILY_LIMIT_REACHED', 'The daily request limit has been reached');
  }
}

export const requestNotFound = () => new AppError(404, 'REQUEST_NOT_FOUND', 'The request was not found');
export const targetUnavailable = () => new AppError(409, 'REQUEST_TARGET_UNAVAILABLE', 'This player is no longer available');
export const contactUnavailable = () => new AppError(409, 'CONTACT_UNAVAILABLE', 'The contact is currently unavailable');
