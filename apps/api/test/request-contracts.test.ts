import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema, blockProfileParamsSchema, blockResponseSchema, notificationJobSchema, requestContactSchema,
  requestItemSchema, requestListQuerySchema, requestListResponseSchema, requestMessageSchema,
  requestIdParamsSchema, requestResponseSchema, requestStatusSchema, requestSummaryResponseSchema, sendRequestInputSchema,
} from '@squad/shared';

const id = '10000000-0000-4000-8000-000000000001';
const now = '2026-10-14T10:00:00.000Z';
const item = { id, status: 'PENDING' as const, message: null, createdAt: now,
  resolvedAt: null, expiresAt: '2026-10-21T10:00:00.000Z', player: null };
const card = { id, nickname: 'Игрок', roles: ['entry'], lookingFor: ['duo'],
  playTimes: ['evening'], languages: ['ru'], region: 'KZ', hasMic: true, bio: '',
  badges: { steamVerified: true, faceitVerified: false }, faceit: null, hasBans: false };

describe('request input contracts', () => {
  it('normalizes a short message while allowing the message to be absent', () => {
    expect(sendRequestInputSchema.parse({ toProfileId: id })).toEqual({ toProfileId: id });
    expect(sendRequestInputSchema.parse({ toProfileId: id, message: '  Привет!\n Сыграем?  ' }))
      .toEqual({ toProfileId: id, message: 'Привет! Сыграем?' });
  });
  it('counts Unicode characters after NFC normalization', () => {
    expect(requestMessageSchema.parse('😀'.repeat(200))).toBe('😀'.repeat(200));
    expect(requestMessageSchema.safeParse('😀'.repeat(201)).success).toBe(false);
    expect(requestMessageSchema.parse('e\u0301'.repeat(200))).toBe('é'.repeat(200));
    expect(requestMessageSchema.safeParse('а'.repeat(201)).success).toBe(false);
  });
  it.each(['@player', 't.me/player', 'https://example.com', 'example.com',
    '192.168.0.1', '+7 (777) 123-45-67', '＠player', 'example。com', '@\u200bplayer'])
  ('rejects contact text: %s', (message) => {
    const result = requestMessageSchema.safeParse(message);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toContain('CONTACTS_NOT_ALLOWED');
  });
  it.each([
    { toProfileId: id, username: 'hidden_contact' }, { toProfileId: id, telegramId: '123' },
    { toProfileId: 'missing' }, { toProfileId: id, message: null },
  ])('rejects unknown input fields and invalid input types', (input) => {
    expect(sendRequestInputSchema.safeParse(input).success).toBe(false);
  });
  it('accepts only the canonical status spelling', () => {
    for (const status of ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELED', 'EXPIRED']) {
      expect(requestStatusSchema.parse(status)).toBe(status);
    }
    expect(requestStatusSchema.safeParse('CANCELLED').success).toBe(false);
  });
  it('keeps request and block path parameters strict UUID objects', () => {
    expect(requestIdParamsSchema.parse({ id })).toEqual({ id });
    expect(blockProfileParamsSchema.parse({ profileId: id })).toEqual({ profileId: id });
    expect(requestIdParamsSchema.safeParse({ id, userId: id }).success).toBe(false);
    expect(blockProfileParamsSchema.safeParse({ profileId: id, blockedUserId: id }).success).toBe(false);
    expect(requestIdParamsSchema.safeParse({ id: 'invalid' }).success).toBe(false);
    expect(blockProfileParamsSchema.safeParse({ profileId: 'invalid' }).success).toBe(false);
  });
  it('defaults the page size and accepts canonical query integers', () => {
    expect(requestListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(requestListQuerySchema.parse({ limit: '50', cursor: 'opaque' })).toEqual({ limit: 50, cursor: 'opaque' });
    expect(requestListQuerySchema.parse({ limit: 1 })).toEqual({ limit: 1 });
  });
  it.each(['0', '51', '1.5', '-1', '01', '0x10', 'true', '', ['10'], true])
  ('rejects invalid page limits: %s', (limit) => {
    expect(requestListQuerySchema.safeParse({ limit }).success).toBe(false);
  });
  it('rejects offset pagination and oversized/empty cursors', () => {
    expect(requestListQuerySchema.safeParse({ offset: 1 }).success).toBe(false);
    expect(requestListQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(requestListQuerySchema.safeParse({ cursor: 'A'.repeat(1025) }).success).toBe(false);
  });
});

describe('privacy-closed request response contracts', () => {
  it('allows a missing public card for a removed or unavailable profile', () => {
    expect(requestItemSchema.parse(item)).toEqual(item);
    expect(requestListResponseSchema.parse({ items: [item], nextCursor: null })).toEqual({ items: [item], nextCursor: null });
  });
  it.each(['telegramId', 'username', 'fromUserId', 'toUserId', 'contact'])
  ('rejects private request field %s', (field) => {
    expect(requestItemSchema.safeParse({ ...item, [field]: 'private' }).success).toBe(false);
    expect(requestListResponseSchema.safeParse({ items: [item], nextCursor: null, [field]: 'private' }).success).toBe(false);
  });
  it('validates the public player projection and refuses contacts in legacy messages', () => {
    expect(requestItemSchema.parse({ ...item, player: card }).player).toEqual(card);
    expect(requestItemSchema.safeParse({ ...item, player: { ...card, username: 'private' } }).success).toBe(false);
    expect(requestItemSchema.safeParse({ ...item, message: '@legacy_contact' }).success).toBe(false);
  });
  it.each(['PENDING', 'DECLINED', 'CANCELED', 'EXPIRED'])
  ('refuses a contact before acceptance: %s', (status) => {
    expect(requestResponseSchema.safeParse({ request: { ...item, status }, contact: { username: 'squad_player' } }).success).toBe(false);
  });
  it('returns a current contact only in an accepted request detail', () => {
    const response = { request: { ...item, status: 'ACCEPTED', resolvedAt: now }, contact: { username: 'squad_player' } };
    expect(requestResponseSchema.parse(response)).toEqual(response);
    expect(requestResponseSchema.safeParse({ ...response, telegramId: '123' }).success).toBe(false);
    expect(requestContactSchema.safeParse({ username: 'squad_player', telegramId: '123' }).success).toBe(false);
  });
  it.each(['@player', 'https://t.me/player', '', 'has-dash', 'space name', 'x'.repeat(33)])
  ('rejects unsafe or invalid Telegram username %s', (username) => {
    expect(requestContactSchema.safeParse({ username }).success).toBe(false);
  });
  it.each(['a', '3name', '_name', 'squad_player'])('supports safe short or collectible Telegram usernames: %s', (username) => {
    expect(requestContactSchema.parse({ username })).toEqual({ username });
  });
  it('enforces the list size and closed count/block response shapes', () => {
    expect(requestListResponseSchema.safeParse({ items: Array.from({ length: 51 }, () => item), nextCursor: null }).success).toBe(false);
    expect(requestSummaryResponseSchema.parse({ pendingIncoming: 0 })).toEqual({ pendingIncoming: 0 });
    expect(requestSummaryResponseSchema.safeParse({ pendingIncoming: -1 }).success).toBe(false);
    expect(requestSummaryResponseSchema.safeParse({ pendingIncoming: 1, username: 'private' }).success).toBe(false);
    expect(blockResponseSchema.parse({ blocked: true })).toEqual({ blocked: true });
    expect(blockResponseSchema.safeParse({ blocked: true, userId: id }).success).toBe(false);
  });
  it('carries the daily quota reset as a valid timestamp only', () => {
    expect(apiErrorSchema.parse({ error: { code: 'DAILY_LIMIT_REACHED', resetAt: now } }).error.resetAt).toBe(now);
    expect(apiErrorSchema.safeParse({ error: { code: 'DAILY_LIMIT_REACHED', resetAt: 'tomorrow' } }).success).toBe(false);
  });
  it('queues only an event id and rejects contacts or recipients in Redis payloads', () => {
    expect(notificationJobSchema.parse({ eventId: id })).toEqual({ eventId: id });
    for (const field of ['telegramId', 'username', 'recipientUserId', 'message']) {
      expect(notificationJobSchema.safeParse({ eventId: id, [field]: 'private' }).success).toBe(false);
    }
    expect(notificationJobSchema.safeParse({ eventId: 'invalid' }).success).toBe(false);
  });
});
