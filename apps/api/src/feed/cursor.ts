import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';

export interface FeedCursorPosition { createdAt: Date; id: string }
interface CursorScope { callerId: string; gameSlug: string; filters: Record<string, unknown> }
const payloadSchema = z.object({
  v: z.literal(1), createdAt: z.string().datetime(), id: z.string().uuid(), scope: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function canonicalFilters(filters: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Array.isArray(value) ? [...new Set(value)].sort() : value]));
}

// Derive separate HMAC contexts from the existing secret. Neither the bot token
// nor a raw owner id is embedded in the cursor, logged or sent to the client.
export class FeedCursorCodec {
  constructor(private readonly secret: string) {}
  private mac(context: string, value: unknown): string {
    return createHmac('sha256', this.secret).update(`squad:feed:v1:${context}\0`).update(JSON.stringify(value)).digest('hex');
  }
  private scope(scope: CursorScope): string {
    return this.mac('scope', [scope.callerId, scope.gameSlug, canonicalFilters(scope.filters)]);
  }
  encode(position: FeedCursorPosition, scope: CursorScope): string {
    const payload = { v: 1 as const, createdAt: position.createdAt.toISOString(), id: position.id, scope: this.scope(scope) };
    return Buffer.from(JSON.stringify({ ...payload, signature: this.mac('position', payload) }), 'utf8').toString('base64url');
  }
  decode(cursor: string, scope: CursorScope): FeedCursorPosition {
    const invalid = () => new AppError(400, 'INVALID_CURSOR', 'The feed cursor is invalid; refresh the feed');
    try {
      if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) throw invalid();
      const parsed = payloadSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      if (!parsed.success) throw invalid();
      const { signature, ...payload } = parsed.data;
      // Enforce the canonical date precision used by PostgreSQL timestamptz(3).
      const createdAt = new Date(payload.createdAt);
      if (createdAt.toISOString() !== payload.createdAt) throw invalid();
      const expected = Buffer.from(this.mac('position', payload), 'hex');
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected) || payload.scope !== this.scope(scope)) throw invalid();
      return { createdAt, id: payload.id };
    } catch { throw invalid(); }
  }
}
