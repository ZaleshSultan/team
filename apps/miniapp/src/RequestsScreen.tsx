import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RequestItem, RequestListResponse } from '@squad/shared';
import { api, errorCode } from './api.js';
import { FeedPlayerCard, FeedSkeleton } from './FeedScreen.js';
import { RequestError, RequestItemActions } from './RequestActions.js';
import { applyRequestPage, formatRequestDate, replaceRequestItem, requestAuthErrors, requestEligibilityErrors, type RequestDirection } from './requests.js';
import './requests.css';

type Pending = 'initial' | 'refresh' | 'more' | null;

export function RequestsScreen({ onAuthError, onChanged, onProfile }: { onAuthError(error: unknown): void; onChanged(): void; onProfile(): void }) {
  const { t } = useTranslation();
  const [direction, setDirection] = useState<RequestDirection>('incoming');
  const [page, setPage] = useState<RequestListResponse>({ items: [], nextCursor: null });
  const [pending, setPending] = useState<Pending>('initial');
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  useEffect(() => { void load(false, true); return () => active.current?.abort(); }, [direction]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(append = false, initial = false) {
    const cursor = append ? page.nextCursor : null;
    if (append && (!cursor || active.current)) return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setPending(append ? 'more' : initial ? 'initial' : 'refresh'); setError(null);
    if (!append) setPage({ items: [], nextCursor: null });
    try {
      const result = await api.requests(direction, cursor, controller.signal);
      if (!controller.signal.aborted && mounted.current) { setPage((current) => applyRequestPage(current, result, append)); if (!append) onChanged(); }
    } catch (cause) {
      if (controller.signal.aborted || !mounted.current) return;
      if (requestAuthErrors.includes(errorCode(cause))) onAuthError(cause);
      else setError(errorCode(cause));
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted && mounted.current) setPending(null);
    }
  }
  const blocked = (profileId: string) => setPage((current) => ({ ...current, items: current.items.filter((item) => item.player?.id !== profileId) }));
  return <section className="requests-screen" aria-labelledby="requests-title">
    <div className="feed-heading"><div><p className="eyebrow">{t('requests.eyebrow')}</p><h1 id="requests-title">{t('requests.title')}</h1></div>
      <button className="secondary-button" type="button" disabled={Boolean(pending)} onClick={() => { void load(); }}>{t(pending === 'refresh' ? 'feed.refreshing' : 'feed.refresh')}</button></div>
    <p className="feed-description">{t('requests.description')}</p>
    <div className="request-tabs" role="tablist" aria-label={t('requests.tabsLabel')}>{(['incoming', 'outgoing'] as const).map((value) => <button key={value} id={`requests-${value}-tab`} type="button" role="tab" aria-selected={direction === value}
      aria-controls="request-list-panel" onClick={() => { if (value !== direction) { active.current?.abort(); setPage({ items: [], nextCursor: null }); setPending('initial'); setError(null); setDirection(value); } }}>{t(`requests.${value}`)}</button>)}</div>
    <div id="request-list-panel" role="tabpanel" aria-labelledby={`requests-${direction}-tab`}>
      <RequestResults page={page} pending={pending} error={error} direction={direction}
        onRetry={() => { void load(page.items.length > 0 && page.nextCursor !== null && error !== 'INVALID_CURSOR'); }} onMore={() => { void load(true); }} onProfile={onProfile}
        onUpdated={(item) => setPage((current) => replaceRequestItem(current, item))} onBlocked={blocked} onAuthError={onAuthError} onChanged={onChanged} />
    </div>
  </section>;
}

export function RequestResults({ page, pending, error, direction, onRetry, onMore, onProfile, onUpdated, onBlocked, onAuthError, onChanged }: {
  page: RequestListResponse; pending: Pending; error: string | null; direction: RequestDirection;
  onRetry(): void; onMore(): void; onProfile(): void; onUpdated(item: RequestItem): void;
  onBlocked(profileId: string): void; onAuthError(error: unknown): void; onChanged(): void;
}) {
  const { t } = useTranslation();
  return <div className="request-results" aria-busy={Boolean(pending)}>
    {error && <div className="account-panel feed-state"><h2>{t('requests.errorTitle')}</h2><RequestError code={error} />
      <button className="secondary-button" type="button" disabled={Boolean(pending)} onClick={onRetry}>{t('auth.retry')}</button>
      {requestEligibilityErrors.includes(error) && <button className="secondary-button" type="button" onClick={onProfile}>{t('feed.completeProfile')}</button>}</div>}
    {page.items.length > 0 && <div className="feed-grid">{page.items.map((item) => <RequestCard key={item.id} item={item} direction={direction} onUpdated={onUpdated} onBlocked={onBlocked} onAuthError={onAuthError} onChanged={onChanged} />)}</div>}
    {pending && <FeedSkeleton />}
    {!pending && !error && page.items.length === 0 && <div className="account-panel feed-state"><h2>{t(`requests.empty.${direction}.title`)}</h2><p>{t(`requests.empty.${direction}.description`)}</p></div>}
    {page.nextCursor && !error && <button className="secondary-button feed-more" type="button" disabled={Boolean(pending)} onClick={onMore}>{t(pending === 'more' ? 'feed.loadingMore' : 'feed.loadMore')}</button>}
    {!pending && !error && page.items.length > 0 && !page.nextCursor && <p className="feed-end" role="status">{t('requests.end')}</p>}
  </div>;
}

export function RequestCard({ item, direction, onUpdated, onBlocked, onAuthError, onChanged }: {
  item: RequestItem; direction: RequestDirection; onUpdated(item: RequestItem): void;
  onBlocked(profileId: string): void; onAuthError(error: unknown): void; onChanged(): void;
}) {
  const { t, i18n } = useTranslation();
  const details = <div className="request-details">
    <div className="request-status-row"><span className={`request-status request-status-${item.status.toLowerCase()}`}>{t(`requests.status.${item.status}`)}</span>
      <time dateTime={item.createdAt}>{formatRequestDate(item.createdAt, i18n.resolvedLanguage ?? 'ru')}</time></div>
    {item.message && <blockquote className="request-message">{item.message}</blockquote>}
    {item.status === 'PENDING' && <p className="request-card-note">{t('requests.expires', { date: formatRequestDate(item.expiresAt, i18n.resolvedLanguage ?? 'ru') })}</p>}
    <RequestItemActions item={item} direction={direction} onUpdated={onUpdated} onBlocked={onBlocked} onAuthError={onAuthError} onChanged={onChanged} />
  </div>;
  return item.player ? <FeedPlayerCard card={item.player} actions={details} /> : <article className="feed-card request-unavailable"><h2>{t('requests.unavailableTitle')}</h2><p className="request-card-note">{t('requests.unavailableDescription')}</p>{details}</article>;
}
