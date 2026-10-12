import {
  apiErrorSchema,
  authResponseSchema,
  meResponseSchema,
  steamLinkResponseSchema,
  steamLinkStatusResponseSchema,
  statsResponseSchema,
  manualSyncResponseSchema,
  faceitLinkInputSchema,
  type AuthResponse,
} from '@squad/shared';

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

export class ApiError extends Error {
  constructor(public readonly code: string) {
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

  private async request<T>(path: string, schema: ResponseSchema<T>, body?: unknown, authenticated = true, signal?: AbortSignal): Promise<T> {
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
        method: body === undefined ? 'GET' : 'POST',
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
        let code = response.status === 401 ? 'SESSION_EXPIRED' : 'REQUEST_FAILED';
        try {
          const parsed = apiErrorSchema.safeParse(await response.json());
          if (parsed.success) code = parsed.data.error.code;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // A proxy may return an HTML error page.
        }
        if (code === 'USER_BANNED' && authenticated) forgetRejectedSession();
        throw new ApiError(code);
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
