import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcceptedContact, BlockProfileButton, ConfirmationDialog, FeedRequestActions, RequestError, RequestItemActions } from './RequestActions.js';
import { RequestCard, RequestResults } from './RequestsScreen.js';
import { applyRequestPage, createRequestSubmission, formatRequestDate, replaceRequestItem, requestMessageLength, REQUEST_SUMMARY_INTERVAL_MS, startPendingRequestPolling, telegramContactUrl, validateRequestMessage } from './requests.js';
import { ApiError } from './api.js';
import { publicProfileFixture } from './profile-fixture.js';
import { requestFixture } from './request-fixture.js';
import i18n from './i18n.js';
import ru from './locales/ru.json';
import en from './locales/en.json';

beforeEach(async () => { await i18n.changeLanguage('ru'); });
const callbacks = { onAuthError() {}, onChanged() {}, onBlocked() {}, onUpdated() {}, onProfile() {}, onRequests() {} };

describe('request messages, pagination, and contacts', () => {
  it('normalizes optional messages and sends only a profile reference and safe text', () => {
    expect(createRequestSubmission(publicProfileFixture.id, '  Играем\n вечером  ')).toEqual({ toProfileId: publicProfileFixture.id, message: 'Играем вечером' });
    expect(createRequestSubmission(publicProfileFixture.id, ' \n ')).toEqual({ toProfileId: publicProfileFixture.id });
    expect(createRequestSubmission('not-a-profile', 'Играем?')).toBeNull();
  });
  it.each(['@someone', 'https://example.com', 'example.com', '127.0.0.1', '+7 (777) 555-44-33', 'test。com', 'ｔｅｓｔ．ｃｏｍ'])('uses the existing contact filter for %s', (message) => {
    expect(validateRequestMessage(message)).toBe('CONTACTS_NOT_ALLOWED');
    expect(createRequestSubmission(publicProfileFixture.id, message)).toBeNull();
  });
  it('counts Unicode characters, accepting exactly 200 and rejecting 201 after normalization', () => {
    expect(requestMessageLength('🙂')).toBe(1);
    expect(createRequestSubmission(publicProfileFixture.id, '🙂'.repeat(200))?.message).toBe('🙂'.repeat(200));
    expect(validateRequestMessage('🙂'.repeat(201))).toBe('TOO_LONG');
    expect(createRequestSubmission(publicProfileFixture.id, 'я'.repeat(201))).toBeNull();
    expect(validateRequestMessage('и\u0306'.repeat(200))).toBeNull();
  });
  it('allows ordinary game conversation without treating short numbers as a phone', () => {
    expect(createRequestSubmission(publicProfileFixture.id, 'CS2, 2 игры после 20:00?')).not.toBeNull();
  });
  it('appends distinct requests, updates repeated statuses and replaces all old pages on refresh', () => {
    const other = { ...requestFixture, id: 'f8826806-e4e3-4a19-914d-bb4f0c028529' };
    const accepted = { ...requestFixture, status: 'ACCEPTED' as const };
    const old = { items: [requestFixture], nextCursor: 'old' };
    expect(applyRequestPage(old, { items: [accepted, other], nextCursor: null }, true)).toEqual({ items: [accepted, other], nextCursor: null });
    expect(applyRequestPage(old, { items: [], nextCursor: null }, false)).toEqual({ items: [], nextCursor: null });
    expect(replaceRequestItem(old, accepted)).toEqual({ items: [accepted], nextCursor: 'old' });
  });
  it.each(['', '@player', 'bad-name', 'example.com', '../person', 'player/evil', 'https://evil', 'player?start=evil', 'player#bad', 'bad"><script>', 'x'.repeat(33)])('never builds a Telegram URL from an unsafe username: %s', (username) => {
    expect(telegramContactUrl(username)).toBeNull();
  });
  it.each(['a', 'short', '9player', 'a_b'])('supports current active short and collectible usernames: %s', (username) => {
    expect(telegramContactUrl(username)).toBe(`https://t.me/${username}`);
  });
  it('builds only the fixed HTTPS Telegram host and formats local dates safely', () => {
    expect(telegramContactUrl('Good_player17')).toBe('https://t.me/Good_player17');
    expect(formatRequestDate('bad', 'ru')).toBe('');
    expect(formatRequestDate(requestFixture.createdAt, 'ru')).toContain('13');
    expect(formatRequestDate(requestFixture.createdAt, 'en')).toContain('Oct');
  });
});

describe('request cards and states', () => {
  it('adds invite and block actions while leaving all contacts absent in a feed card', () => {
    const html = renderToStaticMarkup(<FeedRequestActions player={publicProfileFixture} {...callbacks} />);
    expect(html).toContain(ru.requests.invite); expect(html).toContain(ru.requests.block);
    expect(html).not.toContain('t.me/'); expect(html).not.toContain('username'); expect(html).not.toContain('<textarea');
  });
  it('offers only accept/decline to recipients and only cancel to senders while pending', () => {
    const incoming = renderToStaticMarkup(<RequestItemActions item={requestFixture} direction="incoming" {...callbacks} />);
    expect(incoming).toContain(ru.requests.accept); expect(incoming).toContain(ru.requests.decline); expect(incoming).not.toContain(ru.requests.cancel);
    const outgoing = renderToStaticMarkup(<RequestItemActions item={requestFixture} direction="outgoing" {...callbacks} />);
    expect(outgoing).toContain(ru.requests.cancel); expect(outgoing).not.toContain(`>${ru.requests.accept}<`); expect(outgoing).not.toContain(ru.requests.decline);
    expect(incoming).not.toContain(ru.requests.showContact); expect(outgoing).not.toContain('t.me/');
  });
  it.each(['DECLINED', 'CANCELED', 'EXPIRED'] as const)('never offers pending or contact actions for %s', (status) => {
    const html = renderToStaticMarkup(<RequestCard item={{ ...requestFixture, status }} direction="incoming" {...callbacks} />);
    expect(html).toContain(ru.requests.status[status]);
    expect(html).not.toContain(`>${ru.requests.accept}<`); expect(html).not.toContain(`>${ru.requests.decline}<`);
    expect(html).not.toContain(ru.requests.showContact); expect(html).not.toContain('t.me/');
  });
  it('requires a fresh contact check for accepted list entries', () => {
    const html = renderToStaticMarkup(<RequestCard item={{ ...requestFixture, status: 'ACCEPTED' }} direction="outgoing" {...callbacks} />);
    expect(html).toContain(ru.requests.status.ACCEPTED); expect(html).toContain(ru.requests.showContact); expect(html).toContain(ru.requests.contactPrivacy);
    expect(html).not.toContain('t.me/'); expect(html).not.toContain(ru.requests.cancel);
  });
  it('shows a checked contact in an accepted request only and escapes all contact text', () => {
    const accepted = { ...requestFixture, status: 'ACCEPTED' as const };
    const html = renderToStaticMarkup(<AcceptedContact item={accepted} initialUsername="Test_player17" onAuthError={() => undefined} />);
    expect(html).toContain('href="https://t.me/Test_player17"'); expect(html).toContain(ru.requests.writeTelegram); expect(html).toContain('rel="noopener noreferrer"');
    expect(renderToStaticMarkup(<AcceptedContact item={requestFixture} initialUsername="Test_player17" onAuthError={() => undefined} />)).toBe('');
    expect(renderToStaticMarkup(<AcceptedContact item={accepted} initialUsername={'bad"><script>'} onAuthError={() => undefined} />)).not.toContain('<a ');
  });
  it('handles hidden/deleted profiles and still lets the owner decline/cancel', () => {
    const html = renderToStaticMarkup(<RequestCard item={{ ...requestFixture, player: null }} direction="incoming" {...callbacks} />);
    expect(html).toContain(ru.requests.unavailableTitle); expect(html).toContain(ru.requests.unavailableDescription);
    expect(html).toContain(`disabled="">${ru.requests.accept}`); expect(html).toContain(ru.requests.decline);
    expect(html).not.toContain(ru.requests.block);
  });
  it('escapes messages and displays expiry without exposing account identifiers', () => {
    const html = renderToStaticMarkup(<RequestCard item={{ ...requestFixture, message: '<script>oops</script>' }} direction="incoming" {...callbacks} />);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('<time dateTime='); expect(html).toContain('Действует до');
    for (const key of ['telegramId', 'userId', 'steamId', 'username', 'playtimeTotal']) expect(html).not.toContain(key);
  });
  it('has accessible custom confirmation with a specific cancellation consequence', () => {
    const html = renderToStaticMarkup(<ConfirmationDialog title="Заблокировать игрока?" busy={false} onCancel={() => undefined} onConfirm={() => undefined}><p>{ru.requests.blockDescription}</p></ConfirmationDialog>);
    expect(html).toContain('role="dialog"'); expect(html).toContain('aria-modal="true"'); expect(html).toContain('aria-describedby='); expect(html).toContain(ru.requests.blockConfirm); expect(html).toContain(ru.profile.cancel);
    expect(renderToStaticMarkup(<BlockProfileButton player={publicProfileFixture} {...callbacks} />)).not.toContain('role="dialog"');
  });
  it('gives a safe daily reset time and fixed translated errors without displaying the code as content', () => {
    const html = renderToStaticMarkup(<RequestError code="DAILY_LIMIT_REACHED" resetAt="2026-10-14T12:00:00.000Z" />);
    expect(html).toContain(ru.requests.errors.DAILY_LIMIT_REACHED); expect(html).toContain('14'); expect(html).not.toContain('DAILY_LIMIT_REACHED');
    expect(renderToStaticMarkup(<RequestError code="unknown_server_code" />)).toContain(ru.errors.REQUEST_FAILED);
  });
  const results = { page: { items: [], nextCursor: null }, pending: null, error: null, direction: 'incoming' as const, onRetry() {}, onMore() {}, ...callbacks };
  it('distinguishes both empty directions and never flashes empty text while loading', () => {
    expect(renderToStaticMarkup(<RequestResults {...results} />)).toContain(ru.requests.empty.incoming.title);
    expect(renderToStaticMarkup(<RequestResults {...results} direction="outgoing" />)).toContain(ru.requests.empty.outgoing.title);
    const loading = renderToStaticMarkup(<RequestResults {...results} pending="initial" />);
    expect(loading).toContain('aria-busy="true"'); expect(loading).not.toContain(ru.requests.empty.incoming.title);
  });
  it('keeps cards on a load-more error, provides retry/profile guidance and disables duplicate loading', () => {
    const page = { items: [requestFixture], nextCursor: 'next' };
    const failed = renderToStaticMarkup(<RequestResults {...results} page={page} error="NETWORK_ERROR" />);
    expect(failed).toContain(publicProfileFixture.nickname!); expect(failed).toContain(ru.auth.retry); expect(failed).not.toContain(ru.feed.loadMore);
    const more = renderToStaticMarkup(<RequestResults {...results} page={page} pending="more" />);
    expect(more).toContain(ru.feed.loadingMore); expect(more).toContain('disabled=""');
    expect(renderToStaticMarkup(<RequestResults {...results} error="ONBOARDING_INCOMPLETE" />)).toContain(ru.feed.completeProfile);
  });
  it('keeps full RU/EN translation parity and renders request actions in English', async () => {
    const keys = (value: Record<string, unknown>, prefix = ''): string[] => Object.entries(value).flatMap(([key, item]) => item && typeof item === 'object' ? keys(item as Record<string, unknown>, `${prefix}${key}.`) : `${prefix}${key}`);
    expect(keys(ru).sort()).toEqual(keys(en).sort());
    for (const key of keys(ru.requests, 'requests.')) expect(i18n.exists(key)).toBe(true);
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(<RequestCard item={requestFixture} direction="incoming" {...callbacks} />);
    expect(html).toContain(en.requests.accept); expect(html).toContain(en.requests.decline); expect(html).toContain(en.requests.status.PENDING);
  });
});

class VisibilityStub extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  change(state: DocumentVisibilityState) { this.visibilityState = state; this.dispatchEvent(new Event('visibilitychange')); }
}

describe('pending request badge polling', () => {
  it('reads immediately, uses a bounded interval, pauses in background, and resumes when visible', async () => {
    vi.useFakeTimers();
    try {
      const target = new VisibilityStub(); const onCount = vi.fn(); const getSummary = vi.fn().mockResolvedValue({ pendingIncoming: 3 });
      const polling = startPendingRequestPolling({ getSummary, onCount, onAuthError() {}, target });
      await vi.advanceTimersByTimeAsync(0); expect(onCount).toHaveBeenLastCalledWith(3);
      await vi.advanceTimersByTimeAsync(REQUEST_SUMMARY_INTERVAL_MS - 1); expect(getSummary).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); expect(getSummary).toHaveBeenCalledTimes(2);
      target.change('hidden'); await vi.advanceTimersByTimeAsync(90_000); expect(getSummary).toHaveBeenCalledTimes(2);
      target.change('visible'); await vi.advanceTimersByTimeAsync(0); expect(getSummary).toHaveBeenCalledTimes(3);
      polling.stop(); await vi.advanceTimersByTimeAsync(90_000); expect(getSummary).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('cancels old summaries on mutations and ignores responses that arrive late', async () => {
    const target = new VisibilityStub(); const onCount = vi.fn(); const pending: ((value: { pendingIncoming: number }) => void)[] = []; const signals: AbortSignal[] = [];
    const getSummary = vi.fn((signal: AbortSignal) => { signals.push(signal); return new Promise<{ pendingIncoming: number }>((resolve) => pending.push(resolve)); });
    const polling = startPendingRequestPolling({ getSummary, onCount, onAuthError() {}, target });
    polling.refresh(); expect(signals[0]?.aborted).toBe(true);
    pending[0]!({ pendingIncoming: 99 }); await Promise.resolve(); expect(onCount).not.toHaveBeenCalled();
    pending[1]!({ pendingIncoming: 2 }); await Promise.resolve(); expect(onCount).toHaveBeenLastCalledWith(2);
    polling.stop(); expect(signals.every((signal) => signal.aborted || signal === signals[1])).toBe(true);
  });
  it('aborts in-flight work and removes the visibility listener when unmounted', async () => {
    const target = new VisibilityStub(); const onCount = vi.fn(); let signal!: AbortSignal; let finish!: (value: { pendingIncoming: number }) => void;
    const getSummary = vi.fn((next: AbortSignal) => { signal = next; return new Promise<{ pendingIncoming: number }>((resolve) => { finish = resolve; }); });
    const polling = startPendingRequestPolling({ getSummary, onCount, onAuthError() {}, target });
    polling.stop(); expect(signal.aborted).toBe(true); finish({ pendingIncoming: 4 }); await Promise.resolve(); expect(onCount).not.toHaveBeenCalled();
    target.change('visible'); expect(getSummary).toHaveBeenCalledOnce();
  });
  it('keeps badge failures quiet but forwards expired sessions and banned users', async () => {
    const target = new VisibilityStub(); const onCount = vi.fn(); const onAuthError = vi.fn();
    const getSummary = vi.fn().mockRejectedValueOnce(new ApiError('NETWORK_ERROR')).mockRejectedValueOnce(new ApiError('SESSION_EXPIRED'));
    const polling = startPendingRequestPolling({ getSummary, onCount, onAuthError, target });
    await Promise.resolve(); expect(onCount).not.toHaveBeenCalled(); expect(onAuthError).not.toHaveBeenCalled();
    polling.refresh(); await Promise.resolve(); expect(onAuthError).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_EXPIRED' })); polling.stop();
  });
  it('does not poll until an initially hidden WebView becomes visible', async () => {
    const target = new VisibilityStub(); target.visibilityState = 'hidden'; const getSummary = vi.fn().mockResolvedValue({ pendingIncoming: 0 });
    const polling = startPendingRequestPolling({ getSummary, onCount() {}, onAuthError() {}, target });
    expect(getSummary).not.toHaveBeenCalled(); target.change('visible'); await Promise.resolve(); expect(getSummary).toHaveBeenCalledOnce(); polling.stop();
  });
});
