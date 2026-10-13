/** No environment file is loaded by these tools. Every failure is a fixed code. */
export class SyntheticGuardError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SyntheticGuardError'; }
}

export type SyntheticEnvironment = Record<string, string | undefined>;
export interface SyntheticTarget { databaseUrl: string; databaseName: string }

/** A second safety boundary beyond NODE_ENV: local, explicitly named disposable DBs only. */
export function requireSyntheticTarget(env: SyntheticEnvironment): SyntheticTarget {
  if (env.ALLOW_SYNTHETIC_SEED !== '1') throw new SyntheticGuardError('SYNTHETIC_OPT_IN_REQUIRED');
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') throw new SyntheticGuardError('SYNTHETIC_DEV_ENV_REQUIRED');
  const value = env.DATABASE_URL;
  if (!value) throw new SyntheticGuardError('SYNTHETIC_DATABASE_REQUIRED');
  let url: URL;
  try { url = new URL(value); } catch { throw new SyntheticGuardError('SYNTHETIC_DATABASE_INVALID'); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new SyntheticGuardError('SYNTHETIC_DATABASE_INVALID');
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new SyntheticGuardError('SYNTHETIC_LOCAL_DATABASE_REQUIRED');
  let databaseName: string;
  try { databaseName = decodeURIComponent(url.pathname.slice(1)); } catch { throw new SyntheticGuardError('SYNTHETIC_DATABASE_INVALID'); }
  if (!/^[A-Za-z0-9_]+_(?:dev|test)$/.test(databaseName)) throw new SyntheticGuardError('SYNTHETIC_DISPOSABLE_DATABASE_REQUIRED');
  // Connection-option overrides and additional schemas are deliberately unsupported.
  // This rules out query-string host/dbname changes and exotic driver options.
  if (url.hash || [...url.searchParams].some(([key, option]) => key !== 'schema' || option !== 'public') || url.searchParams.getAll('schema').length > 1) {
    throw new SyntheticGuardError('SYNTHETIC_DATABASE_OPTIONS_FORBIDDEN');
  }
  return { databaseUrl: value, databaseName };
}

/** Never used for real Telegram users. Cleanup is restricted to these 100,000 IDs. */
export const SYNTHETIC_TELEGRAM_MAX = -9_000_000_000_000n;
export const SYNTHETIC_TELEGRAM_MIN = -9_000_000_099_999n;
export const SYNTHETIC_DEFAULT_COUNT = 10_000;
export const SYNTHETIC_MAX_COUNT = Number(SYNTHETIC_TELEGRAM_MAX - SYNTHETIC_TELEGRAM_MIN + 1n);

export function syntheticCount(argument?: string): number {
  if (argument === undefined) return SYNTHETIC_DEFAULT_COUNT;
  if (!/^\d+$/.test(argument)) throw new SyntheticGuardError('SYNTHETIC_COUNT_INVALID');
  const count = Number(argument);
  if (!Number.isSafeInteger(count) || count < 1 || count > SYNTHETIC_MAX_COUNT) throw new SyntheticGuardError('SYNTHETIC_COUNT_INVALID');
  return count;
}

/** These two public consent settings are the only application settings seed reads. */
export function syntheticConsent(env: SyntheticEnvironment): { ageMinimum: number; rulesVersion: string } {
  const age = env.AGE_MINIMUM ?? '18';
  const rulesVersion = env.RULES_VERSION ?? '2026-10-07';
  if (!/^\d+$/.test(age) || Number(age) < 13 || Number(age) > 99 || rulesVersion.length < 1 || rulesVersion.length > 40) {
    throw new SyntheticGuardError('SYNTHETIC_CONSENT_CONFIG_INVALID');
  }
  return { ageMinimum: Number(age), rulesVersion };
}

export function syntheticTelegramId(index: number): bigint {
  if (!Number.isInteger(index) || index < 0 || index >= SYNTHETIC_MAX_COUNT) throw new SyntheticGuardError('SYNTHETIC_INDEX_INVALID');
  return SYNTHETIC_TELEGRAM_MAX - BigInt(index);
}
