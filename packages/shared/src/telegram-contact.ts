import { z } from 'zod';

const telegramIdSchema = z.string().regex(/^[1-9]\d{0,15}$/).refine((value) => Number.isSafeInteger(Number(value)));
// Restrict contacts to a Telegram username, never an arbitrary URL or markup.
// Older and collectible usernames can be shorter than a basic username. Match
// the existing authenticated Telegram identity boundary, while forbidding links.
export const telegramUsernameSchema = z.string().regex(/^[A-Za-z0-9_]{1,32}$/);
const envelopeSchema = z.object({ ok: z.boolean(), result: z.unknown().optional(), error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.number().int().positive().optional() }).passthrough().optional(),
}).passthrough();
const privateChatSchema = z.object({ id: z.number().int().safe(), type: z.literal('private'),
  username: telegramUsernameSchema.optional(), active_usernames: z.array(telegramUsernameSchema).max(100).optional() }).passthrough();
const sentMessageSchema = z.object({ message_id: z.number().int().positive(),
  chat: z.object({ id: z.number().int().safe(), type: z.literal('private') }).passthrough() }).passthrough();
const MAX_TELEGRAM_RESPONSE_BYTES = 65_536;

async function boundedResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_TELEGRAM_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TELEGRAM_RESPONSE_BYTES) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { return null; }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export class TelegramContactError extends Error {
  readonly code: 'CONTACT_UNAVAILABLE' | 'CONTACT_RATE_LIMITED';
  constructor(readonly blocked = false, readonly retryAfterMs = 0, readonly retryable = true) {
    super(retryAfterMs > 0 ? 'CONTACT_RATE_LIMITED' : 'CONTACT_UNAVAILABLE');
    this.name = 'TelegramContactError';
    this.code = retryAfterMs > 0 ? 'CONTACT_RATE_LIMITED' : 'CONTACT_UNAVAILABLE';
  }
}

export interface TelegramMessage {
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> };
  link_preview_options?: { is_disabled: boolean };
}

export interface TelegramNotificationClient {
  getUsername(telegramId: string): Promise<string>;
  sendMessage(telegramId: string, message: TelegramMessage): Promise<void>;
}

/** No raw response, SDK error, request URL, token or username escapes on failure. */
export class TelegramContacts implements TelegramNotificationClient {
  private readonly request: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  constructor(private readonly botToken: string, options: { timeoutMs?: number; fetch?: typeof globalThis.fetch } = {}) {
    this.request = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async getUsername(telegramId: string): Promise<string> {
    if (!telegramIdSchema.safeParse(telegramId).success) throw new TelegramContactError(false, 0, false);
    const result = privateChatSchema.safeParse(await this.call('getChat', { chat_id: telegramId }));
    if (!result.success || String(result.data.id) !== telegramId) throw new TelegramContactError(false, 0, false);
    const username = result.data.username ?? result.data.active_usernames?.[0];
    if (!username) throw new TelegramContactError(false, 0, false);
    return username;
  }

  async sendMessage(telegramId: string, message: TelegramMessage): Promise<void> {
    if (!telegramIdSchema.safeParse(telegramId).success) throw new TelegramContactError(false, 0, false);
    const result = sentMessageSchema.safeParse(await this.call('sendMessage', { chat_id: telegramId, ...message }));
    if (!result.success || String(result.data.chat.id) !== telegramId) throw new TelegramContactError(false, 0, false);
  }

  private async call(method: 'getChat' | 'sendMessage', body: object): Promise<unknown> {
    const controller = new AbortController();
    let failTimeout: (error: TelegramContactError) => void;
    const timeout = new Promise<never>((_resolve, reject) => { failTimeout = reject; });
    const timer = setTimeout(() => { controller.abort(); failTimeout(new TelegramContactError()); }, this.timeoutMs);
    timer.unref?.();
    try {
      const response = await Promise.race([this.request(`https://api.telegram.org/bot${this.botToken}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      }), timeout]);
      const envelope = envelopeSchema.safeParse(await Promise.race([boundedResponse(response, controller.signal), timeout]));
      if (!envelope.success) throw new TelegramContactError(response.status === 403, response.status === 429 ? 1_000 : 0,
        response.status === 429 || response.status >= 500);
      if (!response.ok || !envelope.data.ok) {
        const status = envelope.data.error_code ?? response.status;
        throw new TelegramContactError(status === 403, status === 429
          ? Math.min(envelope.data.parameters?.retry_after ?? 1, 3_600) * 1_000 : 0,
        status === 429 || status >= 500);
      }
      return envelope.data.result;
    } catch (error) {
      if (error instanceof TelegramContactError) throw error;
      throw new TelegramContactError();
    } finally { clearTimeout(timer); }
  }
}
