import type { StatsResponse, StatsSync } from '@squad/shared';
import { ApiError } from './api.js';

export function statsPending(sync: StatsSync): boolean {
  return sync.status === 'QUEUED' || sync.status === 'RUNNING';
}

export function cooldownSeconds(availableAt: string | null, now = Date.now()): number {
  return availableAt ? Math.max(0, Math.ceil((Date.parse(availableAt) - now) / 1000)) : 0;
}

export function formatPlaytime(minutes: number | null | undefined, language: string): string | null {
  if (minutes == null) return null;
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(minutes / 60);
}

export function providerUnavailable(stats: StatsResponse, provider: 'steam' | 'faceit'): boolean {
  return !stats.availability[provider] || Boolean(stats.sync.lastErrorCode?.startsWith(`${provider.toUpperCase()}_`));
}

/** Only reads cached status; it never asks the server to refresh provider data. */
export async function pollCachedStats(options: {
  signal: AbortSignal;
  read(signal: AbortSignal): Promise<StatsResponse>;
  onStats(stats: StatsResponse): void;
  onError(error: unknown): void;
  intervalMs?: number;
  maxDurationMs?: number;
  now?: () => number;
}): Promise<void> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  while (!options.signal.aborted) {
    let stats: StatsResponse;
    try {
      stats = await options.read(options.signal);
    } catch (error) {
      if (!options.signal.aborted) options.onError(error);
      return;
    }
    if (options.signal.aborted) return;
    options.onStats(stats);
    if (!statsPending(stats.sync)) return;
    if (now() - startedAt >= (options.maxDurationMs ?? 300_000)) {
      options.onError(new ApiError('STATS_STATUS_TIMEOUT'));
      return;
    }
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) { resolve(); return; }
      const finish = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, options.intervalMs ?? 3000);
      options.signal.addEventListener('abort', finish, { once: true });
    });
  }
}
