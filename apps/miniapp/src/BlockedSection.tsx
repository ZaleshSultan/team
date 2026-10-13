import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockListResponse } from '@squad/shared';
import { api, errorCode } from './api.js';
import { applyBlockPage, communityLink } from './moderation.js';
import { ModerationError } from './ReportDialog.js';
import { requestAuthErrors } from './requests.js';
import { openExternalLink } from './telegram.js';
import './moderation.css';

export function BlockedSection({ onAuthError }: { onAuthError(error: unknown): void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false); const [page, setPage] = useState<BlockListResponse>({ items: [], nextCursor: null });
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const [unblocking, setUnblocking] = useState<string | null>(null); const [rowError, setRowError] = useState<{ profileId: string; code: string } | null>(null);
  const active = useRef<AbortController | null>(null); const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); mutation.current?.abort(); }, []);
  async function load(append = false) {
    const cursor = append ? page.nextCursor : null;
    if (append && (!cursor || active.current)) return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setPending(true); setError(null);
    if (!append) setPage({ items: [], nextCursor: null });
    try { const next = await api.blocks(cursor, controller.signal); if (!controller.signal.aborted) setPage((current) => applyBlockPage(current, next, append)); }
    catch (cause) { if (!controller.signal.aborted) { if (requestAuthErrors.includes(errorCode(cause))) onAuthError(cause); else setError(errorCode(cause)); } }
    finally { if (active.current === controller) active.current = null; if (!controller.signal.aborted) setPending(false); }
  }
  async function unblock(profileId: string) {
    if (mutation.current) return;
    const controller = new AbortController(); mutation.current = controller; setUnblocking(profileId); setRowError(null);
    try { await api.unblockProfile(profileId, controller.signal);
      if (!controller.signal.aborted) setPage((current) => ({ ...current, items: current.items.filter((item) => item.profileId !== profileId) })); }
    catch (cause) { if (!controller.signal.aborted) {
      if (errorCode(cause) === 'BLOCK_NOT_FOUND') setPage((current) => ({ ...current, items: current.items.filter((item) => item.profileId !== profileId) }));
      else if (requestAuthErrors.includes(errorCode(cause))) onAuthError(cause);
      else setRowError({ profileId, code: errorCode(cause) });
    } }
    finally { if (mutation.current === controller) mutation.current = null; if (!controller.signal.aborted) setUnblocking(null); }
  }
  return <section className="moderation-section" aria-labelledby="blocked-title">
    <h3 id="blocked-title">{t('moderation.blocksTitle')}</h3><p>{t('moderation.blocksDescription')}</p>
    <button className="secondary-button" type="button" aria-expanded={open} aria-controls="blocked-list"
      onClick={() => { const next = !open; setOpen(next); if (next) void load(); else { active.current?.abort(); active.current = null; } }}>{t(open ? 'moderation.hideBlocks' : 'moderation.showBlocks')}</button>
    {open && <div id="blocked-list"><div className="blocked-heading"><button className="text-button" type="button" disabled={pending || Boolean(unblocking)} onClick={() => { void load(); }}>{t('feed.refresh')}</button></div>
      <BlockedResults page={page} pending={pending} error={error} unblocking={unblocking} rowError={rowError}
        onRetry={() => { void load(page.items.length > 0 && error !== 'INVALID_CURSOR'); }} onMore={() => { void load(true); }} onUnblock={(id) => { void unblock(id); }} />
    </div>}
  </section>;
}

export function BlockedResults({ page, pending, error, unblocking, rowError, onRetry, onMore, onUnblock }: {
  page: BlockListResponse; pending: boolean; error: string | null; unblocking: string | null; rowError: { profileId: string; code: string } | null;
  onRetry(): void; onMore(): void; onUnblock(profileId: string): void;
}) {
  const { t } = useTranslation();
  return <div aria-busy={pending} className="blocked-results">
    {error && <div><ModerationError code={error} /><button className="secondary-button" type="button" disabled={pending} onClick={onRetry}>{t('auth.retry')}</button></div>}
    {page.items.length > 0 && <ul className="blocked-list">{page.items.map((item) => <li key={item.profileId}>
      <div><h4>{item.player?.nickname ?? t('moderation.unavailablePlayer')}</h4>
        {item.player ? <p>{t(`profile.options.regions.${item.player.region}`, { defaultValue: item.player.region })} · {item.player.roles.map((role) => t(`profile.options.roles.${role}`, { defaultValue: role })).join(', ')}</p> : <p>{t('moderation.unavailableDescription')}</p>}
        {rowError?.profileId === item.profileId && <ModerationError code={rowError.code} />}</div>
      <button className="secondary-button" type="button" disabled={Boolean(unblocking)} onClick={() => onUnblock(item.profileId)}>{t(unblocking === item.profileId ? 'moderation.unblocking' : 'moderation.unblock')}</button>
    </li>)}</ul>}
    {pending && <p role="status">{t('moderation.loadingBlocks')}</p>}
    {!pending && !error && page.items.length === 0 && <p>{t('moderation.emptyBlocks')}</p>}
    {page.nextCursor && !error && <button className="secondary-button" type="button" disabled={pending} onClick={onMore}>{t(pending ? 'feed.loadingMore' : 'feed.loadMore')}</button>}
  </div>;
}

export function CommunitySection() {
  const { t } = useTranslation();
  const [botUsername, setBotUsername] = useState<string | null>(null); const [error, setError] = useState(false); const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(false);
    void api.community(controller.signal).then((data) => { if (!controller.signal.aborted) setBotUsername(data.botUsername); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [generation]);
  return <section className="moderation-section" aria-labelledby="community-title"><h3 id="community-title">{t('moderation.communityTitle')}</h3>
    <p>{t('moderation.communityDescription')}</p>
    {botUsername && <CommunityLinks botUsername={botUsername} />}
    {error && <div><p role="alert">{t('moderation.communityUnavailable')}</p><button className="text-button" type="button" onClick={() => setGeneration((value) => value + 1)}>{t('auth.retry')}</button></div>}
    {!botUsername && !error && <p role="status">{t('moderation.communityLoading')}</p>}
  </section>;
}

export function CommunityLinks({ botUsername }: { botUsername: string }) {
  const { t } = useTranslation();
  return <nav className="community-links" aria-label={t('moderation.communityTitle')}>{(['rules', 'privacy', 'help'] as const).map((command) => {
    const url = communityLink(botUsername, command);
    return url ? <a className="secondary-button" key={command} href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => { if (openExternalLink(url)) event.preventDefault(); }}>{t(`moderation.links.${command}`)}</a> : null;
  })}</nav>;
}
