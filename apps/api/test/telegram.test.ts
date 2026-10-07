import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyTelegramInitData } from '../src/auth/telegram.js';

const BOT_TOKEN = '123456:abcdefghijklmnopqrstuvwx';
const NOW = new Date('2026-10-07T12:00:00Z');
const AUTH_DATE = 1_791_374_400;
const OPTIONS = { now: NOW, maxAgeSeconds: 300 };

function sign(fields: Record<string, string>, botToken = BOT_TOKEN): URLSearchParams {
  const check = Object.entries(fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') });
}

function fixture(changes: Record<string, string> = {}): URLSearchParams {
  return sign({ auth_date: String(AUTH_DATE), user: JSON.stringify({ id: 123456789, username: 'player_name', language_code: 'ru' }), ...changes });
}

function verify(params: URLSearchParams) {
  return verifyTelegramInitData(params.toString(), BOT_TOKEN, OPTIONS);
}

describe('Telegram initData verification', () => {
  it('verifies a fixed vector with unsorted keys, signature and encoded Unicode JSON', () => {
    const params = new URLSearchParams([
      ['user', '{"id":123456789,"first_name":"Женя / +","username":"player_name","language_code":"ru"}'],
      ['signature', 'telegram-signature'], ['query_id', 'query +/'], ['auth_date', String(AUTH_DATE)],
      ['hash', '6a6e34cf5b59794a85276cac7d566ce9bc80fe582ee4df24f72bc8631306b887'],
    ]);
    expect(verify(params)).toEqual({ id: 123456789, username: 'player_name', language_code: 'ru' });
  });

  it('preserves signed JSON whitespace and returns only supported identity fields', () => {
    expect(verify(fixture({ user: '{ "id" : 123456789, "first_name" : "A" }' }))).toEqual({ id: 123456789 });
  });

  it('accepts a short collectible username and IETF language tag', () => {
    expect(verify(fixture({ user: JSON.stringify({ id: 1, username: 'abc', language_code: 'pt-BR' }) })))
      .toEqual({ id: 1, username: 'abc', language_code: 'pt-BR' });
  });

  it.each(['user', 'signature'])('rejects a modified %s field', (field) => {
    const params = fixture({ signature: 'signed' });
    params.set(field, 'tampered');
    expect(() => verify(params)).toThrowError(expect.objectContaining({ statusCode: 401, code: 'TELEGRAM_AUTH_INVALID' }));
  });

  it('rejects another bot token', () => {
    expect(() => verifyTelegramInitData(fixture().toString(), `${BOT_TOKEN}x`, OPTIONS))
      .toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }));
  });

  it.each(['auth_date', 'user', 'hash', 'query_id'])('rejects duplicate %s parameters', (key) => {
    const params = fixture({ query_id: 'query' });
    params.append(key, params.get(key)!);
    expect(() => verify(params)).toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }));
  });

  it.each(['', 'abc', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)])('rejects malformed hash %s', (hash) => {
    const params = fixture();
    params.set('hash', hash);
    expect(() => verify(params)).toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }));
  });

  it('rejects missing hash, empty payload and oversized payload', () => {
    const params = fixture();
    params.delete('hash');
    expect(() => verify(params)).toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }));
    for (const input of ['', 'x'.repeat(16_385)]) {
      expect(() => verifyTelegramInitData(input, BOT_TOKEN, OPTIONS)).toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }));
    }
  });

  it.each(['', '-1', '0', '1.1', 'NaN', '9007199254740992'])('rejects malformed auth_date %s', (authDate) => {
    expect(() => verify(fixture({ auth_date: authDate }))).toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }));
  });

  it('rejects missing signed auth_date and user', () => {
    expect(() => verify(sign({ user: '{"id":1}' }))).toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }));
    expect(() => verify(sign({ auth_date: String(AUTH_DATE) }))).toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }));
  });

  it('allows exact freshness and skew boundaries and rejects the next second', () => {
    expect(verify(fixture({ auth_date: String(AUTH_DATE - 300) })).id).toBe(123456789);
    expect(verify(fixture({ auth_date: String(AUTH_DATE + 30) })).id).toBe(123456789);
    for (const timestamp of [AUTH_DATE - 301, AUTH_DATE + 31]) {
      expect(() => verify(fixture({ auth_date: String(timestamp) })))
        .toThrowError(expect.objectContaining({ statusCode: 401, code: 'TELEGRAM_AUTH_EXPIRED' }));
    }
    expect(() => verifyTelegramInitData(fixture({ auth_date: String(AUTH_DATE + 1) }).toString(), BOT_TOKEN, { ...OPTIONS, futureSkewSeconds: 0 }))
      .toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_EXPIRED' }));
  });

  it.each([
    'invalid JSON', 'null', '[]', '{"id":"123"}', '{"id":0}', '{"id":-1}', '{"id":1.5}',
    '{"id":9007199254740992}', '{"id":1,"username":"@name"}', '{"id":1,"username":""}',
    JSON.stringify({ id: 1, username: 'a'.repeat(33) }), '{"id":1,"username":null}',
    '{"id":1,"language_code":123}', '{"id":1,"language_code":"ru/evil"}',
  ])('rejects malformed user %s', (user) => {
    expect(() => verify(fixture({ user }))).toThrowError(expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }));
  });
});
