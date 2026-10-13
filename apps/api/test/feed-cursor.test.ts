import { describe, expect, it } from 'vitest';
import { FeedCursorCodec } from '../src/feed/cursor.js';

const codec = new FeedCursorCodec('fixture-only-HMAC-key');
const position = { createdAt: new Date('2026-10-13T10:11:12.345Z'), id: '10000000-0000-4000-8000-000000000001' };
const scope = { callerId: 'private-owner-id', gameSlug: 'cs2', filters: { roles: ['entry', 'awp'], noBans: true, verifiedOnly: false } };
const invalid = { statusCode: 400, code: 'INVALID_CURSOR', message: 'The feed cursor is invalid; refresh the feed' };

describe('authenticated opaque feed cursors', () => {
  it('roundtrips both ordering keys and contains no owner identity', () => {
    const cursor = codec.encode(position, scope);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codec.decode(cursor, scope)).toEqual(position);
    const decoded = Buffer.from(cursor, 'base64url').toString();
    expect(decoded).not.toContain(scope.callerId); expect(decoded).not.toContain('fixture-only-HMAC-key');
  });
  it('canonicalizes equivalent reordered filter fields and array choices', () => {
    const equivalent = { ...scope, filters: { verifiedOnly: false, noBans: true, roles: ['awp', 'entry', 'entry'], absent: undefined } };
    expect(codec.decode(codec.encode(position, scope), equivalent)).toEqual(position);
  });
  it.each(['', '***', 'a=', 'a+b', 'a/b', 'A'.repeat(1025), Buffer.from('not-json').toString('base64url'), Buffer.from('{}').toString('base64url'), Buffer.from('null').toString('base64url')])
  ('rejects malformed input without echoing it: %s', (value) => {
    try { codec.decode(value, scope); throw new Error('Expected cursor rejection'); }
    catch (error) { expect(error).toMatchObject(invalid); expect(error).not.toHaveProperty('cause'); }
  });
  it.each(['v', 'createdAt', 'id', 'scope', 'signature', 'unknown'])('rejects a tampered %s', (field) => {
    const decoded = JSON.parse(Buffer.from(codec.encode(position, scope), 'base64url').toString());
    decoded[field] = field === 'v' ? 2 : 'tampered';
    const cursor = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    expect(() => codec.decode(cursor, scope)).toThrowError(expect.objectContaining(invalid));
  });
  it('binds the cursor to the caller, provider and filters; secret rotation invalidates it', () => {
    const cursor = codec.encode(position, scope);
    for (const other of [{ ...scope, callerId: 'other-user' }, { ...scope, gameSlug: 'other-game' },
      { ...scope, filters: { ...scope.filters, noBans: false } }]) {
      expect(() => codec.decode(cursor, other)).toThrowError(expect.objectContaining(invalid));
    }
    expect(() => new FeedCursorCodec('another-fixture-key').decode(cursor, scope)).toThrowError(expect.objectContaining(invalid));
  });
  it('rejects noncanonical base64url encodings and invalid date precision', () => {
    const cursor = codec.encode(position, scope);
    expect(() => codec.decode(`${cursor}=`, scope)).toThrowError(expect.objectContaining(invalid));
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); decoded.createdAt = '2026-10-13T10:11:12Z';
    expect(() => codec.decode(Buffer.from(JSON.stringify(decoded)).toString('base64url'), scope)).toThrowError(expect.objectContaining(invalid));
  });
});
