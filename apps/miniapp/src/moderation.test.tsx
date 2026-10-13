import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportButton, ReportForm, ReportSuccess, ModerationError } from './ReportDialog.js';
import { BlockedResults, CommunityLinks } from './BlockedSection.js';
import { FeedRequestActions, RequestItemActions } from './RequestActions.js';
import { applyBlockPage, communityLink, createReportSubmission, reportDetailsLength, REPORT_REASONS, submitReportAndBlock } from './moderation.js';
import { ApiError } from './api.js';
import { publicProfileFixture } from './profile-fixture.js';
import { requestFixture } from './request-fixture.js';
import i18n from './i18n.js';
import ru from './locales/ru.json';
import en from './locales/en.json';

const callbacks = { onAuthError() {}, onChanged() {}, onBlocked() {}, onUpdated() {}, onProfile() {}, onRequests() {} };
const report = { report: { id: 'f9d545ce-d5b1-47d5-86c9-ec95f626c42b', status: 'OPEN' as const, createdAt: '2026-10-14T12:00:00.000Z' }, duplicate: false };
const form = { id: 'test-report', reason: '' as const, details: '', blockToo: false, canBlock: true, busy: false, error: null, valid: false,
  onReason() {}, onDetails() {}, onBlockToo() {}, onSubmit() {}, onClose() {} };
const blocked = { profileId: publicProfileFixture.id, player: publicProfileFixture, createdAt: report.report.createdAt };

beforeEach(async () => { await i18n.changeLanguage('ru'); });

describe('report input and independent optional blocking', () => {
  it.each(REPORT_REASONS)('accepts allowlisted reason %s and exactly one profile/request reference', (reason) => {
    expect(createReportSubmission({ profileId: publicProfileFixture.id }, reason, '')).toEqual({ profileId: publicProfileFixture.id, reason });
    expect(createReportSubmission({ requestId: requestFixture.id }, reason, '')).toEqual({ requestId: requestFixture.id, reason });
  });
  it('normalizes private evidence without applying the public contact filter', () => {
    expect(createReportSubmission({ profileId: publicProfileFixture.id }, 'CONTACT_SPAM', '  @sender\nhttps://example.com\u200b  '))
      .toEqual({ profileId: publicProfileFixture.id, reason: 'CONTACT_SPAM', details: '@sender https://example.com' });
    expect(createReportSubmission({ profileId: publicProfileFixture.id }, 'OTHER', ' \n ')).not.toHaveProperty('details');
  });
  it('counts Unicode after normalization and accepts the 500-character boundary', () => {
    expect(reportDetailsLength('🙂')).toBe(1); expect(reportDetailsLength('и\u0306')).toBe(1);
    expect(createReportSubmission({ requestId: requestFixture.id }, 'OTHER', '🙂'.repeat(500))?.details).toBe('🙂'.repeat(500));
    expect(createReportSubmission({ requestId: requestFixture.id }, 'OTHER', '🙂'.repeat(501))).toBeNull();
  });
  it('refuses missing reasons, malformed references and dual references', () => {
    expect(createReportSubmission({ profileId: publicProfileFixture.id }, '', '')).toBeNull();
    expect(createReportSubmission({ profileId: 'bad' }, 'OTHER', '')).toBeNull();
    expect(createReportSubmission({ profileId: publicProfileFixture.id, requestId: requestFixture.id } as never, 'OTHER', '')).toBeNull();
  });
  it('never blocks without the explicit checkbox and never stores report details', async () => {
    const storage = { setItem: vi.fn() }; vi.stubGlobal('localStorage', storage);
    const deps = { report: vi.fn().mockResolvedValue(report), block: vi.fn() };
    const input = createReportSubmission({ profileId: publicProfileFixture.id }, 'OTHER', 'private evidence')!;
    expect(await submitReportAndBlock(input, publicProfileFixture.id, false, deps)).toEqual({ response: report, blocked: false, blockError: null });
    expect(deps.report).toHaveBeenCalledWith(input); expect(deps.block).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('awaits report creation before optional blocking and retains the acknowledgment if block fails', async () => {
    const calls: string[] = [];
    const deps = { report: vi.fn(async () => { calls.push('report'); return report; }), block: vi.fn(async () => { calls.push('block'); throw new ApiError('NETWORK_ERROR'); }) };
    const result = await submitReportAndBlock({ profileId: publicProfileFixture.id, reason: 'SPAM' }, publicProfileFixture.id, true, deps);
    expect(calls).toEqual(['report', 'block']); expect(result).toEqual({ response: report, blocked: false, blockError: 'NETWORK_ERROR' });
  });
  it('does not block after a failed report and does not fabricate a missing profile reference', async () => {
    const deps = { report: vi.fn().mockRejectedValue(new ApiError('REPORT_DAILY_LIMIT_REACHED')), block: vi.fn() };
    await expect(submitReportAndBlock({ requestId: requestFixture.id, reason: 'SPAM' }, null, true, deps)).rejects.toMatchObject({ code: 'REPORT_DAILY_LIMIT_REACHED' });
    expect(deps.block).not.toHaveBeenCalled();
    deps.report.mockResolvedValue(report);
    expect(await submitReportAndBlock({ requestId: requestFixture.id, reason: 'SPAM' }, null, true, deps)).toEqual({ response: report, blocked: false, blockError: null });
  });
  it('accepts idempotent duplicate reports and acknowledges a successful block', async () => {
    const duplicate = { ...report, duplicate: true };
    const deps = { report: vi.fn().mockResolvedValue(duplicate), block: vi.fn().mockResolvedValue({ blocked: true }) };
    expect(await submitReportAndBlock({ profileId: publicProfileFixture.id, reason: 'SPAM' }, publicProfileFixture.id, true, deps))
      .toEqual({ response: duplicate, blocked: true, blockError: null });
  });
});

describe('report dialog presentation', () => {
  it('offers reports on feed and request cards, including unavailable request counterparts', () => {
    expect(renderToStaticMarkup(<FeedRequestActions player={publicProfileFixture} {...callbacks} />)).toContain(ru.moderation.report);
    expect(renderToStaticMarkup(<RequestItemActions item={{ ...requestFixture, player: null }} direction="incoming" {...callbacks} />)).toContain(ru.moderation.report);
    const button = renderToStaticMarkup(<ReportButton target={{ profileId: publicProfileFixture.id }} profileId={publicProfileFixture.id} {...callbacks} />);
    expect(button).not.toContain('<textarea'); expect(button).not.toContain('private');
  });
  it('shows all reasons, optional private details, 0/500 counter, confirmation and an unchecked block offer', () => {
    const html = renderToStaticMarkup(<ReportForm {...form} />);
    for (const reason of Object.values(ru.moderation.reasons)) expect(html).toContain(reason);
    for (const message of [ru.moderation.reportPrivacy, ru.moderation.confirmation, ru.moderation.blockToo, '0/500']) expect(html).toContain(message);
    expect(html).toContain('type="checkbox"'); expect(html).not.toContain('checked=""');
    expect(html).toContain(`disabled="">${ru.moderation.send}`);
  });
  it('disables inputs and confirmation during sending and never offers a fabricated block target', () => {
    const html = renderToStaticMarkup(<ReportForm {...form} reason="SPAM" valid busy canBlock={false} />);
    expect(html).toContain(ru.moderation.sending); expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('disabled="" required=""'); expect(html).toContain('disabled="" aria-describedby');
  });
  it('escapes evidence and uses Unicode length in the visible counter', () => {
    const html = renderToStaticMarkup(<ReportForm {...form} reason="OTHER" details={'<script>🙂</script>'} valid />);
    expect(html).toContain('&lt;script&gt;🙂&lt;/script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('18/500');
  });
  it.each(['REPORT_TARGET_NOT_FOUND', 'REPORT_SELF', 'REPORT_DAILY_LIMIT_REACHED', 'NETWORK_ERROR'] as const)('shows a safe translated %s state', (code) => {
    const html = renderToStaticMarkup(<ReportForm {...form} error={code} resetAt="2026-10-15T12:00:00.000Z" />);
    expect(html).toContain('role="alert"'); expect(html).not.toContain('moderation.errors.');
    if (code === 'REPORT_DAILY_LIMIT_REACHED') { expect(html).toContain('Следующую жалобу'); expect(html).toContain('15'); }
  });
  it('keeps success visible with a separate block retry and no resubmit or promise of punishment', () => {
    const html = renderToStaticMarkup(<ReportSuccess blocked={false} blockError="NETWORK_ERROR" busy={false} onRetryBlock={() => undefined} onClose={() => undefined} />);
    expect(html).toContain(ru.moderation.received); expect(html).toContain(ru.moderation.blockFailed); expect(html).toContain(ru.moderation.retryBlock);
    expect(html).not.toContain(ru.moderation.send); expect(html).not.toContain('<textarea');
  });
  it('shows success after independent block retry without exposing report metadata', () => {
    const html = renderToStaticMarkup(<ReportSuccess blocked blockError={null} busy={false} onRetryBlock={() => undefined} onClose={() => undefined} />);
    expect(html).toContain(ru.moderation.blocked); expect(html).not.toContain(report.report.id); expect(html).not.toContain(ru.moderation.retryBlock);
  });
});

describe('blocked list and community links', () => {
  it('paginates by public profile ids, deduplicates and replaces old pages on refresh', () => {
    const current = { items: [blocked], nextCursor: 'old' };
    const next = { items: [{ ...blocked, player: null }], nextCursor: null };
    expect(applyBlockPage(current, next, true)).toEqual(next);
    expect(applyBlockPage(current, { items: [], nextCursor: null }, false)).toEqual({ items: [], nextCursor: null });
  });
  it('shows safe public identity and an unblock control without contacts or account ids', () => {
    const html = renderToStaticMarkup(<BlockedResults page={{ items: [blocked], nextCursor: 'more' }} pending={false} error={null} unblocking={null} rowError={null} onRetry={() => undefined} onMore={() => undefined} onUnblock={() => undefined} />);
    expect(html).toContain(publicProfileFixture.nickname); expect(html).toContain(ru.moderation.unblock); expect(html).toContain(ru.feed.loadMore);
    for (const value of ['t.me/', 'username', 'telegramId', 'steamId64', publicProfileFixture.id]) expect(html).not.toContain(value);
  });
  it('still offers unblock for an unavailable or unpublished profile', () => {
    const html = renderToStaticMarkup(<BlockedResults page={{ items: [{ ...blocked, player: null }], nextCursor: null }} pending={false} error={null} unblocking={null} rowError={null} onRetry={() => undefined} onMore={() => undefined} onUnblock={() => undefined} />);
    expect(html).toContain(ru.moderation.unavailablePlayer); expect(html).toContain(ru.moderation.unavailableDescription); expect(html).toContain(ru.moderation.unblock);
  });
  it('has empty, loading, list-error retry and independent row-error states', () => {
    const props = { page: { items: [], nextCursor: null }, pending: false, error: null, unblocking: null, rowError: null, onRetry() {}, onMore() {}, onUnblock() {} };
    expect(renderToStaticMarkup(<BlockedResults {...props} />)).toContain(ru.moderation.emptyBlocks);
    expect(renderToStaticMarkup(<BlockedResults {...props} pending />)).toContain(ru.moderation.loadingBlocks);
    expect(renderToStaticMarkup(<BlockedResults {...props} error="NETWORK_ERROR" />)).toContain(ru.auth.retry);
    const row = renderToStaticMarkup(<BlockedResults {...props} page={{ items: [blocked], nextCursor: null }} unblocking={blocked.profileId} rowError={{ profileId: blocked.profileId, code: 'NETWORK_ERROR' }} />);
    expect(row).toContain(ru.moderation.unblocking); expect(row).toContain('role="alert"');
  });
  it.each(['../bad', 'bad?start=admin', 'bad/name', '@squad_bot', 'https://evil.test', 'bad#frag', 'bad-name'])('rejects unsafe bot username %s', (username) => {
    expect(communityLink(username, 'rules')).toBeNull(); expect(renderToStaticMarkup(<CommunityLinks botUsername={username} />)).not.toContain('<a');
  });
  it('links only to the configured bot with fixed public start payloads and fallback anchors', () => {
    const html = renderToStaticMarkup(<CommunityLinks botUsername="Squad_test_bot" />);
    for (const command of ['rules', 'privacy', 'help'] as const) {
      expect(communityLink('Squad_test_bot', command)).toBe(`https://t.me/Squad_test_bot?start=${command}`);
      expect(html).toContain(`href="https://t.me/Squad_test_bot?start=${command}"`); expect(html).toContain(ru.moderation.links[command]);
    }
    expect(html).toContain('rel="noopener noreferrer"'); expect(html).toContain('target="_blank"'); expect(html).not.toContain('admin');
  });
  it('has matching Russian and English keys including every reason and moderation error', async () => {
    const paths = (value: object, prefix = ''): string[] => Object.entries(value).flatMap(([key, child]) => typeof child === 'object' ? paths(child as object, `${prefix}${key}.`) : [`${prefix}${key}`]).sort();
    expect(paths(ru.moderation)).toEqual(paths(en.moderation));
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(<ModerationError code="REPORT_TARGET_NOT_FOUND" />);
    expect(html).toContain(en.moderation.errors.REPORT_TARGET_NOT_FOUND);
  });
});
