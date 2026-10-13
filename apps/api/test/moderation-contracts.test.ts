import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blockListQuerySchema, blockListResponseSchema, moderationNotificationJobId, moderationNotificationJobSchema,
  moderationSettingsSchema, privateModerationTextSchema, reportInputSchema, reportResponseSchema } from '@squad/shared';

describe('M7 closed moderation transport contracts', () => {
  it.each(['SPAM', 'HARASSMENT', 'CHEATING', 'FAKE_PROFILE', 'CONTACT_SPAM', 'UNDERAGE', 'OTHER'])('accepts reason %s', (reason) => {
    expect(reportInputSchema.parse({ profileId: randomUUID(), reason }).reason).toBe(reason);
  });
  it.each([
    {}, { reason: 'SPAM' }, { profileId: randomUUID(), requestId: randomUUID(), reason: 'SPAM' },
    { profileId: 'invalid', reason: 'SPAM' }, { requestId: 'invalid', reason: 'SPAM' },
    { profileId: randomUUID(), reason: 'spam' }, { profileId: randomUUID(), reason: 'SPAM', reporterUserId: randomUUID() },
    { profileId: randomUUID(), reason: 'SPAM', details: null }, { profileId: randomUUID(), reason: 'SPAM', details: 42 },
    { profileId: randomUUID(), reason: 'SPAM', details: 'a'.repeat(501) },
  ])('rejects invalid or excessive report input %j', (input) => {
    expect(reportInputSchema.safeParse(input).success).toBe(false);
  });
  it('uses the same normalized Unicode 500-character boundary for private details', () => {
    expect(privateModerationTextSchema.parse('  Ли\u200bния\n  текста\t ')).toBe('Линия текста');
    expect(privateModerationTextSchema.parse('😀'.repeat(500))).toBe('😀'.repeat(500));
    expect(privateModerationTextSchema.safeParse('😀'.repeat(501)).success).toBe(false);
    expect(privateModerationTextSchema.parse('e\u0301')).toBe('é');
  });
  it('permits evidence in private details without publishing it in the response', () => {
    const input = reportInputSchema.parse({ requestId: randomUUID(), reason: 'CONTACT_SPAM', details: '@private_evidence https://example.test' });
    expect(input.details).toContain('@private_evidence');
    const response = { report: { id: randomUUID(), status: 'OPEN', createdAt: new Date().toISOString() }, duplicate: false };
    expect(reportResponseSchema.parse(response)).toEqual(response);
    for (const field of ['details', 'reporterUserId', 'reportedUserId', 'autoHidden']) {
      expect(reportResponseSchema.safeParse({ ...response, [field]: true }).success).toBe(false);
      expect(reportResponseSchema.safeParse({ ...response, report: { ...response.report, [field]: true } }).success).toBe(false);
    }
  });
  it('supports only bounded keyset block paging and a closed public projection', () => {
    expect(blockListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(blockListQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    for (const query of [{ limit: 51 }, { offset: 20 }, { limit: '01' }, { cursor: '' }]) {
      expect(blockListQuerySchema.safeParse(query).success).toBe(false);
    }
    const response = { items: [{ profileId: randomUUID(), player: null, createdAt: new Date().toISOString() }], nextCursor: null };
    expect(blockListResponseSchema.parse(response)).toEqual(response);
    for (const field of ['username', 'userId', 'telegramId']) expect(blockListResponseSchema.safeParse({ ...response,
      items: [{ ...response.items[0], [field]: 'private' }] }).success).toBe(false);
  });
  it('validates safe defaults and bounded moderation settings', () => {
    expect(moderationSettingsSchema.parse({})).toEqual({ REPORTS_PER_DAY: 10, REPORTS_AUTO_HIDE_THRESHOLD: 3,
      REPORTS_RATE_LIMIT_PER_MINUTE: 10, REPORT_RETENTION_DAYS: 180 });
    for (const key of ['REPORTS_PER_DAY', 'REPORTS_AUTO_HIDE_THRESHOLD', 'REPORTS_RATE_LIMIT_PER_MINUTE', 'REPORT_RETENTION_DAYS']) {
      for (const value of ['0', '-1', '1.5', 'wrong', '999999']) expect(moderationSettingsSchema.safeParse({ [key]: value }).success).toBe(false);
    }
  });
  it('sends only opaque IDs through a stable BullMQ-compatible job identity', () => {
    const id = randomUUID();
    expect(moderationNotificationJobSchema.parse({ eventId: id })).toEqual({ eventId: id });
    expect(moderationNotificationJobSchema.safeParse({ eventId: id, username: 'private' }).success).toBe(false);
    expect(moderationNotificationJobId(id)).toBe(`moderation-${id}`);
    expect(() => moderationNotificationJobId('invalid')).toThrow();
  });
});
