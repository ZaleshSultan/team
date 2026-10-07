import { ApiError } from './api.js';

export type SteamLinkStatus = 'PENDING' | 'STARTED' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
export interface SteamLinkSnapshot {
  id: string;
  status: SteamLinkStatus;
  expiresAt: string;
  failureCode: string | null;
}

export function isPendingSteamLink(status: SteamLinkStatus): boolean {
  return status === 'PENDING' || status === 'STARTED' || status === 'VERIFYING';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function pollSteamLink(
  attempt: { id: string; expiresAt: string },
  options: {
    signal: AbortSignal;
    getStatus(id: string, signal: AbortSignal): Promise<SteamLinkSnapshot>;
    onStatus(status: SteamLinkSnapshot): void;
    onError(error: unknown): void;
    now?: () => number;
  },
): Promise<void> {
  const now = options.now ?? Date.now;
  const expiresAt = Date.parse(attempt.expiresAt);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal.aborted) controller.abort();
  else options.signal.addEventListener('abort', cancel, { once: true });
  const expiryTimer = setTimeout(cancel, Math.max(0, expiresAt - now()));
  const expired = () => options.onStatus({ ...attempt, status: 'EXPIRED', failureCode: null });
  try {
    while (!options.signal.aborted) {
      if (expiresAt <= now()) { expired(); return; }
      try {
        const status = await options.getStatus(attempt.id, controller.signal);
        if (options.signal.aborted) return;
        if (expiresAt <= now()) { expired(); return; }
        options.onStatus(status);
        if (!isPendingSteamLink(status.status)) return;
      } catch (error) {
        if (options.signal.aborted) return;
        if (expiresAt <= now()) { expired(); return; }
        options.onError(error);
        if (error instanceof ApiError && ['SESSION_EXPIRED', 'SESSION_INVALID', 'UNAUTHORIZED', 'USER_BANNED', 'FORBIDDEN'].includes(error.code)) return;
        if (error instanceof ApiError && ['NOT_FOUND', 'STEAM_LINK_NOT_FOUND'].includes(error.code)) {
          options.onStatus({ ...attempt, status: 'FAILED', failureCode: error.code });
          return;
        }
      }
      await delay(Math.min(2000, Math.max(0, expiresAt - now())), controller.signal);
    }
  } finally {
    clearTimeout(expiryTimer);
    options.signal.removeEventListener('abort', cancel);
  }
}
