import { normalizeProfileText, profileTextError, sendRequestInputSchema, telegramUsernameSchema, type RequestItem, type RequestListResponse, type RequestSummaryResponse, type SendRequestInput } from '@squad/shared';
import { errorCode } from './api.js';

export type RequestDirection = 'incoming' | 'outgoing';
export const REQUEST_MESSAGE_MAX_LENGTH = 200;
export const REQUEST_SUMMARY_INTERVAL_MS = 30_000;
export const requestAuthErrors = ['SESSION_EXPIRED', 'SESSION_INVALID', 'UNAUTHORIZED', 'USER_BANNED'];
export const requestEligibilityErrors = ['ONBOARDING_INCOMPLETE', 'STEAM_REQUIRED', 'PUBLISHED_PROFILE_REQUIRED'];

export function requestMessageLength(value: string): number {
  return Array.from(value).length;
}

export function validateRequestMessage(value: string): 'CONTACTS_NOT_ALLOWED' | 'TOO_LONG' | null {
  const normalized = normalizeProfileText(value);
  if (profileTextError('bio', normalized) === 'CONTACTS_NOT_ALLOWED') return 'CONTACTS_NOT_ALLOWED';
  return requestMessageLength(normalized) > REQUEST_MESSAGE_MAX_LENGTH ? 'TOO_LONG' : null;
}

export function createRequestSubmission(toProfileId: string, value: string): SendRequestInput | null {
  if (validateRequestMessage(value)) return null;
  const message = normalizeProfileText(value);
  const result = sendRequestInputSchema.safeParse({ toProfileId, ...(message ? { message } : {}) });
  return result.success ? result.data : null;
}

export function applyRequestPage(current: RequestListResponse, next: RequestListResponse, append: boolean): RequestListResponse {
  const items = new Map((append ? current.items : []).map((item) => [item.id, item]));
  for (const item of next.items) items.set(item.id, item);
  return { items: [...items.values()], nextCursor: next.nextCursor };
}

export function replaceRequestItem(page: RequestListResponse, item: RequestItem): RequestListResponse {
  return { ...page, items: page.items.map((current) => current.id === item.id ? item : current) };
}

/** A contact is never accepted from a list item, URL, storage, or unchecked input. */
export function telegramContactUrl(username: string): string | null {
  return telegramUsernameSchema.safeParse(username).success ? `https://t.me/${username}` : null;
}

export function formatRequestDate(value: string, language: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(language === 'en' ? 'en' : 'ru', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

type VisibilityTarget = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/** One in-flight summary read; pause polling while Telegram is in the background. */
export function startPendingRequestPolling({ getSummary, onCount, onAuthError, target, intervalMs = REQUEST_SUMMARY_INTERVAL_MS }: {
  getSummary(signal: AbortSignal): Promise<RequestSummaryResponse>;
  onCount(count: number): void;
  onAuthError(error: unknown): void;
  target: VisibilityTarget;
  intervalMs?: number;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | null = null;
  async function refresh() {
    clearTimeout(timer);
    active?.abort(); active = null;
    if (stopped || target.visibilityState !== 'visible') return;
    const controller = new AbortController(); active = controller;
    try {
      const summary = await getSummary(controller.signal);
      if (!stopped && !controller.signal.aborted) onCount(summary.pendingIncoming);
    } catch (error) {
      if (!stopped && !controller.signal.aborted && requestAuthErrors.includes(errorCode(error))) onAuthError(error);
      // A badge read never replaces the active screen with an unrelated network error.
    } finally {
      if (active === controller) {
        active = null;
        if (!stopped && !controller.signal.aborted && target.visibilityState === 'visible') timer = setTimeout(() => { void refresh(); }, intervalMs);
      }
    }
  }
  const visibility = () => { void refresh(); };
  target.addEventListener('visibilitychange', visibility);
  void refresh();
  return {
    refresh: () => { void refresh(); },
    stop: () => { stopped = true; clearTimeout(timer); active?.abort(); active = null; target.removeEventListener('visibilitychange', visibility); },
  };
}
