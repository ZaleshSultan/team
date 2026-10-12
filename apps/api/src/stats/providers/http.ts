export type ProviderName = 'steam' | 'faceit';
export type ProviderErrorCode = 'UNAVAILABLE' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'INVALID_RESPONSE' | 'NOT_FOUND' | 'STEAM_ID_MISMATCH';

/** Only fixed metadata is retained. Never preserve upstream errors, bodies or request URLs. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly code: ProviderErrorCode,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly statusCode?: number,
  ) {
    super(`${provider.toUpperCase()}_${code}`);
    this.name = 'ProviderError';
  }
}

export interface ProviderOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  /** Shared per-provider gate, called for every HTTP request (including retries). */
  beforeRequest?: () => Promise<void>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const ms = Number(value) * 1_000;
    return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
  }
  const until = Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, until - now) : undefined;
}

export function redactProviderSecrets(value: string): string {
  return value.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match: string, prefix: string, key: string) => {
    try { return decodeURIComponent(key).toLowerCase() === 'key' ? `${prefix}${key}=[REDACTED]` : match; }
    catch { return match; }
  })
    .replace(/(\bBearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}

export function isSteamId64(value: string | null): value is string {
  if (!value || !/^\d{17}$/.test(value)) return false;
  const id = BigInt(value);
  return id >= 76_561_197_960_265_729n && id <= 76_561_202_255_233_023n;
}

async function boundedBody(response: Response, provider: ProviderName, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError(provider, 'INVALID_RESPONSE');
  }
  if (!response.body) throw new ProviderError(provider, 'INVALID_RESPONSE');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError(provider, 'INVALID_RESPONSE');
      }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new ProviderError(provider, 'INVALID_RESPONSE'); }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export class ProviderHttp {
  #apiKey: string | undefined;
  #fetch: typeof globalThis.fetch;
  #options: Omit<ProviderOptions, 'apiKey'>;
  constructor(readonly provider: ProviderName, options: ProviderOptions) {
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const { apiKey: _apiKey, ...safeOptions } = options;
    this.#options = safeOptions;
  }

  get configured(): boolean { return Boolean(this.#apiKey); }

  async get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!this.#apiKey) throw new ProviderError(this.provider, 'UNAVAILABLE');
    try { await this.#options.beforeRequest?.(); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(this.provider, 'UNAVAILABLE', true);
    }
    const origin = this.provider === 'steam' ? 'https://api.steampowered.com' : 'https://open.faceit.com';
    const url = new URL(path, origin);
    // Paths are internal constants, but prohibit future accidental cross-origin/credential forwarding.
    if (url.origin !== origin || url.hash || url.username || url.password) throw new ProviderError(this.provider, 'INVALID_RESPONSE');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.provider === 'steam') url.searchParams.set('key', this.#apiKey);
    else headers.authorization = `Bearer ${this.#apiKey}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderError(this.provider, 'UNAVAILABLE', true));
        }, this.#options.timeoutMs ?? 10_000);
      });
      const attempt = (async () => {
        const response = await this.#fetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.#options.now?.());
          if (response.status === 429) throw new ProviderError(this.provider, 'RATE_LIMITED', true, retryAfterMs, 429);
          if (response.status === 404) throw new ProviderError(this.provider, 'NOT_FOUND', false, undefined, 404);
          if (response.status === 401 || response.status === 403) throw new ProviderError(this.provider, 'UNAVAILABLE', false, undefined, response.status);
          throw new ProviderError(this.provider, 'UPSTREAM_ERROR', response.status >= 500, retryAfterMs, response.status);
        }
        return boundedBody(response, this.provider, this.#options.maxResponseBytes ?? 4_194_304, controller.signal);
      })();
      return await Promise.race([attempt, deadline]);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(this.provider, 'UNAVAILABLE', true);
    } finally { if (timer) clearTimeout(timer); }
  }
}
