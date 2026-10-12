import type { Prisma } from '@prisma/client';

export const STATS_LEASE_MS = 180_000;
export const STATS_SCAN_MS = 60_000;
export const STATS_BATCH_SIZE = 100;

// No future timestamps or live leases are eligible. The same predicate is used
// by the scanner and tested independently without a database.
export function staleAccountsWhere(now: Date): Prisma.SteamAccountWhereInput {
  return { user: { isBanned: false, OR: [
    { statsSync: { is: null } },
    { statsSync: { is: { nextRefreshAt: { lte: now }, OR: [
      { lockedUntil: null }, { lockedUntil: { lte: now } },
    ] } } },
  ] } };
}

export function isStale(state: { nextRefreshAt: Date; lockedUntil: Date | null } | null, now: Date) {
  return !state || (state.nextRefreshAt <= now && (!state.lockedUntil || state.lockedUntil <= now));
}

export function nextRefreshAt(now: Date, hours: number, random = Math.random): Date {
  // Positive jitter avoids refreshing earlier than the configured cache age.
  return new Date(now.getTime() + hours * 3_600_000 + Math.floor(random() * 5 * 60_000));
}

export function retryDelay(attempt: number, retryAfterMs = 0, random = Math.random): number {
  const exponential = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(retryAfterMs, Math.round(exponential * (1 + random() * 0.25)));
}

export class SyncRetryError extends Error {
  constructor(readonly retryAfterMs = 0, readonly retryable = true) {
    super('STATS_SYNC_FAILED');
    this.name = 'SyncRetryError';
  }
}
