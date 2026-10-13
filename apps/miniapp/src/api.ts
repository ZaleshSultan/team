import {
  apiErrorSchema,
  authResponseSchema,
  meResponseSchema,
  steamLinkResponseSchema,
  steamLinkStatusResponseSchema,
  statsResponseSchema,
  manualSyncResponseSchema,
  faceitLinkInputSchema,
  profileResponseSchema,
  publishResponseSchema,
  publicPlayerCardSchema,
  privacyInputSchema,
  deleteAccountInputSchema,
  feedResponseSchema,
  sendRequestInputSchema,
  requestListResponseSchema,
  requestResponseSchema,
  requestSummaryResponseSchema,
  blockResponseSchema,
  reportInputSchema,
  reportResponseSchema,
  blockListResponseSchema,
  communityInfoSchema,
  type ReportInput,
  type SendRequestInput,
  type FeedFilters,
  type FeedRequirement,
  type ProfileUpdateInput,
  type PublishRequirement,
  type AuthResponse,
} from '@squad/shared';
import { feedSearchParams } from './feed.js';

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly field?: string, public readonly requirements?: (PublishRequirement | FeedRequirement)[], public readonly issues?: { code: string; field: string }[], public readonly resetAt?: string) {
    super(code);
    this.name = 'ApiError';
  }
}

/** Tokens are intentionally scoped to this WebView's memory. */
export class SquadApi {
  private session: AuthResponse | undefined;
  private authenticating: Promise<AuthResponse> | undefined;

  constructor(
    private readonly baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    // Keep native Window.fetch bound: calling it as a class method can fail in WebViews.
    private readonly send: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
  ) {}

  authenticate(initData: string): Promise<AuthResponse> {
    if (!initData) return Promise.reject(new ApiError('TELEGRAM_REQUIRED'));
    if (this.session && Date.parse(this.session.expiresAt) > this.now()) {
      return Promise.resolve(this.session);
    }
    if (this.authenticating) return this.authenticating;
    this.authenticating = this.request('/api/auth/telegram', authResponseSchema, { initData }, false)
      .then((result) => {
        this.session = result;
        return result;
      })
      .finally(() => { this.authenticating = undefined; });
    return this.authenticating;
  }

  me(signal?: AbortSignal) {
    return this.request('/api/me', meResponseSchema, undefined, true, signal);
  }

  onboarding(input: {
    ageConfirmed: true;
    minimumAge: number;
    rulesAccepted: true;
    rulesVersion: string;
    language: 'ru' | 'en';
    shareSteamActivity: boolean;
  }) {
    return this.request('/api/onboarding', meResponseSchema, input);
  }

  refreshTelegram() {
    return this.request('/api/me/telegram/refresh', meResponseSchema, {});
  }

  async createSteamLink() {
    const result = await this.request('/api/auth/steam/link', steamLinkResponseSchema, {});
    if (new URL(result.url).protocol !== 'https:') throw new ApiError('INVALID_RESPONSE');
    return result;
  }

  steamLinkStatus(id: string, signal?: AbortSignal) {
    return this.request(`/api/auth/steam/links/${encodeURIComponent(id)}`, steamLinkStatusResponseSchema, undefined, true, signal);
  }

  stats(signal?: AbortSignal) {
    return this.request('/api/me/stats', statsResponseSchema, undefined, true, signal);
  }

  refreshStats(signal?: AbortSignal) {
    return this.request('/api/me/sync', manualSyncResponseSchema, {}, true, signal);
  }

  linkFaceit(nickname: string, signal?: AbortSignal) {
    return this.request('/api/me/faceit/link', statsResponseSchema, faceitLinkInputSchema.parse({ nickname }), true, signal);
  }

  profile(signal?: AbortSignal) {
    return this.request('/api/me/profile/cs2', profileResponseSchema, undefined, true, signal);
  }

  saveProfile(input: ProfileUpdateInput, signal?: AbortSignal) {
    return this.request('/api/me/profile/cs2', profileResponseSchema, input, true, signal, 'PUT');
  }

  publishProfile(published: boolean, signal?: AbortSignal) {
    return this.request('/api/me/profile/cs2/publish', publishResponseSchema, { published }, true, signal, 'PUT');
  }

  previewProfile(signal?: AbortSignal) {
    return this.request('/api/me/profile/cs2/preview', publicPlayerCardSchema, undefined, true, signal);
  }

  feed(filters: FeedFilters, cursor?: string | null, signal?: AbortSignal) {
    return this.request(`/api/feed/cs2?${feedSearchParams(filters, cursor)}`, feedResponseSchema, undefined, true, signal);
  }

  sendRequest(input: SendRequestInput, signal?: AbortSignal) {
    return this.request('/api/requests', requestResponseSchema, sendRequestInputSchema.parse(input), true, signal);
  }

  requests(direction: 'incoming' | 'outgoing', cursor?: string | null, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/api/requests/${direction}?${query}`, requestListResponseSchema, undefined, true, signal);
  }

  requestSummary(signal?: AbortSignal) {
    return this.request('/api/requests/summary', requestSummaryResponseSchema, undefined, true, signal);
  }

  requestContact(id: string, signal?: AbortSignal) {
    return this.request(`/api/requests/${encodeURIComponent(id)}`, requestResponseSchema, undefined, true, signal);
  }

  resolveRequest(id: string, action: 'accept' | 'decline' | 'cancel', signal?: AbortSignal) {
    return this.request(`/api/requests/${encodeURIComponent(id)}/${action}`, requestResponseSchema, {}, true, signal);
  }

  blockProfile(profileId: string, signal?: AbortSignal) {
    return this.request(`/api/blocks/${encodeURIComponent(profileId)}`, blockResponseSchema, {}, true, signal);
  }

  unblockProfile(profileId: string, signal?: AbortSignal) {
    return this.request(`/api/blocks/${encodeURIComponent(profileId)}`, blockResponseSchema, undefined, true, signal, 'DELETE');
  }

  report(input: ReportInput, signal?: AbortSignal) {
    return this.request('/api/reports', reportResponseSchema, reportInputSchema.parse(input), true, signal);
  }

  blocks(cursor?: string | null, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/api/blocks?${query}`, blockListResponseSchema, undefined, true, signal);
  }

  community(signal?: AbortSignal) {
    return this.request('/api/community', communityInfoSchema, undefined, false, signal);
  }

  changePrivacy(shareSteamActivity: boolean, signal?: AbortSignal) {
    return this.request('/api/me/privacy', meResponseSchema, privacyInputSchema.parse({ shareSteamActivity }), true, signal, 'PATCH');
  }

  async deleteAccount(signal?: AbortSignal) {
    await this.request('/api/me', { parse: () => undefined }, deleteAccountInputSchema.parse({ confirmation: 'DELETE' }), true, signal, 'DELETE');
    this.forgetSession();
  }

  async logout() {
    try {
      await this.request('/api/auth/logout', { parse: () => undefined }, {});
    } finally {
      this.forgetSession();
    }
  }

  forgetSession() {
    this.session = undefined;
  }

  private async request<T>(path: string, schema: ResponseSchema<T>, body?: unknown, authenticated = true, signal?: AbortSignal, method?: 'PUT' | 'PATCH' | 'DELETE'): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const sessionToken = this.session?.token;
    const forgetRejectedSession = () => {
      if (this.session?.token === sessionToken) this.forgetSession();
    };
    if (authenticated) {
      if (!this.session || Date.parse(this.session.expiresAt) <= this.now()) {
        this.forgetSession();
        throw new ApiError('SESSION_EXPIRED');
      }
      headers.Authorization = `Bearer ${this.session.token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 15_000);
    try {
      const response = await this.send(`${this.baseUrl}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!response.ok) {
        if (response.status === 401 && authenticated) forgetRejectedSession();
        let code = response.status === 401 ? 'SESSION_EXPIRED'
          : [502, 503, 504].includes(response.status) ? 'DEPENDENCIES_UNAVAILABLE' : 'REQUEST_FAILED';
        let field: string | undefined;
        let requirements: (PublishRequirement | FeedRequirement)[] | undefined;
        let issues: { code: string; field: string }[] | undefined;
        let resetAt: string | undefined;
        try {
          const parsed = apiErrorSchema.safeParse(await response.json());
          if (parsed.success) {
            code = parsed.data.error.code;
            field = parsed.data.error.field;
            requirements = parsed.data.error.requirements;
            issues = parsed.data.error.issues;
            resetAt = parsed.data.error.resetAt;
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // A proxy may return an HTML error page.
        }
        if (code === 'USER_BANNED' && authenticated) forgetRejectedSession();
        throw new ApiError(code, field, requirements, issues, resetAt);
      }
      try {
        return schema.parse(response.status === 204 ? undefined : await response.json());
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new ApiError('INVALID_RESPONSE');
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ApiError) throw error;
      throw new ApiError('NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }
}

export const api = new SquadApi();

export function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'REQUEST_FAILED';
}
