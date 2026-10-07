import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

export interface TelegramAuthOptions {
  now: Date;
  maxAgeSeconds: number;
  futureSkewSeconds?: number;
}

export interface TelegramUser {
  id: number;
  username?: string;
  language_code?: string;
}

function invalid(): never {
  throw new AppError(401, 'TELEGRAM_AUTH_INVALID', 'Telegram authentication could not be verified');
}

/**
 * Telegram's bot-token HMAC method, not its separate Ed25519 third-party method.
 * Include every decoded field except hash (including signature, when present).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: TelegramAuthOptions,
): TelegramUser {
  if (typeof initData !== 'string' || !initData || initData.length > 16_384 || !botToken) invalid();
  const params = new URLSearchParams(initData);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  const hash = params.get('hash');
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) invalid();
  params.delete('hash');
  params.sort();
  // Do not parse/re-serialize user JSON before building the check string.
  const checkString = [...params].map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) invalid();

  const authDateValue = params.get('auth_date');
  if (!authDateValue || !/^\d+$/.test(authDateValue)) invalid();
  const authDate = Number(authDateValue);
  const nowSeconds = Math.floor(options.now.getTime() / 1000);
  const futureSkew = options.futureSkewSeconds ?? 30;
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || !Number.isFinite(nowSeconds)
    || !Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds <= 0
    || !Number.isSafeInteger(futureSkew) || futureSkew < 0) invalid();
  if (nowSeconds - authDate > options.maxAgeSeconds || authDate - nowSeconds > futureSkew) {
    throw new AppError(401, 'TELEGRAM_AUTH_EXPIRED', 'Telegram authentication has expired; reopen the Mini App');
  }

  let value: unknown;
  try {
    value = JSON.parse(params.get('user') ?? '');
  } catch {
    invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const user = value as Record<string, unknown>;
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) invalid();
  // Older and collectible usernames can be shorter than the usual five chars.
  if (user.username !== undefined && (typeof user.username !== 'string'
    || !/^[A-Za-z0-9_]{1,32}$/.test(user.username))) invalid();
  if (user.language_code !== undefined && (typeof user.language_code !== 'string'
    || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(user.language_code)
    || user.language_code.length > 35)) invalid();
  return {
    id: user.id,
    ...(user.username !== undefined ? { username: user.username as string } : {}),
    ...(user.language_code !== undefined ? { language_code: user.language_code as string } : {}),
  };
}
