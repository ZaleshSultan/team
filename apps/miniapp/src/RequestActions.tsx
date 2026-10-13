import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PublicPlayerCard, RequestItem } from '@squad/shared';
import { api, ApiError, errorCode } from './api.js';
import { createRequestSubmission, formatRequestDate, REQUEST_MESSAGE_MAX_LENGTH, requestAuthErrors, requestEligibilityErrors, requestMessageLength, telegramContactUrl, validateRequestMessage, type RequestDirection } from './requests.js';
import { openExternalLink } from './telegram.js';
import './requests.css';

type ActionCallbacks = { onAuthError(error: unknown): void; onChanged(): void };

function useOperation() {
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  return {
    start: () => { active.current?.abort(); const controller = new AbortController(); active.current = controller; return controller; },
  };
}

export function RequestError({ code, resetAt }: { code: string; resetAt?: string | null }) {
  const { t, i18n } = useTranslation();
  return <p className="request-error" role="alert">{t(`requests.errors.${code}`, { defaultValue: t(`errors.${code}`, { defaultValue: t('errors.REQUEST_FAILED') }) })}
    {code === 'DAILY_LIMIT_REACHED' && resetAt && <span className="request-error-detail">{t('requests.dailyReset', { date: formatRequestDate(resetAt, i18n.resolvedLanguage ?? 'ru') })}</span>}</p>;
}

export function ConfirmationDialog({ title, children, busy, error, confirmLabel, onCancel, onConfirm }: {
  title: string; children: ReactNode; busy: boolean; error?: string | null; confirmLabel?: string; onCancel(): void; onConfirm(): void;
}) {
  const { t } = useTranslation();
  const titleId = useId(); const descriptionId = useId();
  const dialog = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  return <div className="request-dialog-overlay" onClick={(event) => { if (!busy && event.currentTarget === event.target) onCancel(); }}>
    <div className="request-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} ref={dialog}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) { event.stopPropagation(); onCancel(); }
        if (event.key !== 'Tab') return;
        const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
        if (!controls?.length) { event.preventDefault(); return; }
        const first = controls[0]!; const last = controls[controls.length - 1]!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
      }}>
      <h2 id={titleId}>{title}</h2><div id={descriptionId}>{children}</div>
      {error && <RequestError code={error} />}
      <div className="request-dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>{t('profile.cancel')}</button>
        <button className="profile-danger-button" type="button" disabled={busy} onClick={onConfirm}>{confirmLabel ?? t(busy ? 'requests.blocking' : 'requests.blockConfirm')}</button></div>
    </div>
  </div>;
}

export function BlockProfileButton({ player, disabled = false, onBlocked, onAuthError, onChanged }: ActionCallbacks & {
  player: PublicPlayerCard; disabled?: boolean; onBlocked(profileId: string): void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useOperation();
  async function block() {
    if (busy) return;
    const controller = operation.start(); setBusy(true); setError(null);
    try {
      await api.blockProfile(player.id, controller.signal);
      if (controller.signal.aborted) return;
      setConfirming(false); onBlocked(player.id); onChanged();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (requestAuthErrors.includes(errorCode(cause))) onAuthError(cause);
      else setError(errorCode(cause));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <><button className="text-button request-block-button" type="button" disabled={disabled || busy} onClick={() => { setError(null); setConfirming(true); }}>{t('requests.block')}</button>
    {confirming && <ConfirmationDialog title={t('requests.blockTitle', { nickname: player.nickname ?? t('profile.unnamed') })} busy={busy} error={error} onCancel={() => setConfirming(false)} onConfirm={() => { void block(); }}>
      <p>{t('requests.blockDescription')}</p></ConfirmationDialog>}</>;
}

export function FeedRequestActions({ player, onBlocked, onAuthError, onChanged, onRequests, onProfile }: ActionCallbacks & {
  player: PublicPlayerCard; onBlocked(profileId: string): void; onRequests(): void; onProfile(): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetAt, setResetAt] = useState<string | null>(null);
  const operation = useOperation();
  const validation = validateRequestMessage(message);
  const terminal = ['REQUEST_ALREADY_SENT', 'REQUEST_ALREADY_RECEIVED', 'REQUEST_ALREADY_ACCEPTED', 'REQUEST_DECLINED_RECENTLY', 'REQUEST_TARGET_UNAVAILABLE'].includes(error ?? '');
  useEffect(() => {
    if (error !== 'DAILY_LIMIT_REACHED' || !resetAt) return;
    const timer = setTimeout(() => { setError(null); setResetAt(null); }, Math.max(0, Date.parse(resetAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [error, resetAt]);
  async function send(event: FormEvent) {
    event.preventDefault();
    const input = createRequestSubmission(player.id, message);
    if (!input || busy || sent) return;
    const controller = operation.start(); setBusy(true); setError(null); setResetAt(null);
    try {
      await api.sendRequest(input, controller.signal);
      if (controller.signal.aborted) return;
      setSent(true); setExpanded(false); setMessage(''); onChanged();
    } catch (cause) {
      if (controller.signal.aborted) return;
      const code = errorCode(cause);
      if (requestAuthErrors.includes(code)) onAuthError(cause);
      else { setError(code); setResetAt(cause instanceof ApiError ? cause.resetAt ?? null : null); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <div className="request-card-actions">
    {sent ? <p className="request-success" role="status">{t('requests.sent')}</p> : expanded ? <form className="request-message-form" onSubmit={(event) => { void send(event); }} noValidate>
      <label className="profile-field" htmlFor={id}><span>{t('requests.optionalMessage')}</span><textarea id={id} value={message} rows={2} disabled={busy || terminal}
        aria-invalid={Boolean(validation)} aria-describedby={`${id}-hint ${id}-counter${validation ? ` ${id}-error` : ''}`}
        onChange={(event) => setMessage(Array.from(event.target.value).slice(0, REQUEST_MESSAGE_MAX_LENGTH).join(''))} /></label>
      <div className="request-message-meta"><p id={`${id}-hint`}>{t('requests.messageHint')}</p><span id={`${id}-counter`} aria-live="polite">{t('requests.messageCounter', { count: requestMessageLength(message), max: REQUEST_MESSAGE_MAX_LENGTH })}</span></div>
      {validation && <p className="request-error" id={`${id}-error`} role="alert">{t(`requests.validation.${validation}`)}</p>}
      <div className="request-action-row"><button className="primary-button" type="submit" disabled={busy || Boolean(validation) || terminal || error === 'DAILY_LIMIT_REACHED'}>{t(busy ? 'requests.sending' : 'requests.send')}</button>
        <button className="text-button" type="button" disabled={busy} onClick={() => setExpanded(false)}>{t('profile.cancel')}</button></div>
    </form> : <button className="primary-button" type="button" disabled={terminal || error === 'DAILY_LIMIT_REACHED'} onClick={() => setExpanded(true)}>{t('requests.invite')}</button>}
    {error && <RequestError code={error} resetAt={resetAt} />}
    {(sent || error === 'REQUEST_ALREADY_RECEIVED' || error === 'REQUEST_ALREADY_SENT' || error === 'REQUEST_ALREADY_ACCEPTED') && <button className="secondary-button" type="button" onClick={onRequests}>{t(error === 'REQUEST_ALREADY_RECEIVED' ? 'requests.openIncoming' : 'requests.openRequests')}</button>}
    {error && requestEligibilityErrors.includes(error) && <button className="secondary-button" type="button" onClick={onProfile}>{t('feed.completeProfile')}</button>}
    <BlockProfileButton player={player} disabled={busy} onBlocked={onBlocked} onAuthError={onAuthError} onChanged={onChanged} />
  </div>;
}

export function AcceptedContact({ item, initialUsername, onAuthError }: { item: RequestItem; initialUsername?: string | null; onAuthError(error: unknown): void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState(initialUsername ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useOperation();
  // A fresh list/refresh discards previously checked contacts held in this component only.
  useEffect(() => { setUsername(initialUsername ?? null); setError(null); }, [item, initialUsername]);
  if (item.status !== 'ACCEPTED') return null;
  const contactUrl = username ? telegramContactUrl(username) : null;
  async function reveal() {
    if (busy) return;
    const controller = operation.start(); setBusy(true); setError(null); setUsername(null);
    try {
      const response = await api.requestContact(item.id, controller.signal);
      if (controller.signal.aborted) return;
      if (response.request.status !== 'ACCEPTED' || !response.contact || !telegramContactUrl(response.contact.username)) setError('CONTACT_UNAVAILABLE');
      else setUsername(response.contact.username);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (requestAuthErrors.includes(errorCode(cause))) onAuthError(cause);
      else setError(errorCode(cause));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <div className="request-contact">
    <p className="request-card-note">{t('requests.contactPrivacy')}</p>
    {contactUrl ? <><p className="request-contact-username">@{username}</p><a className="primary-button" href={contactUrl} target="_blank" rel="noopener noreferrer"
      onClick={(event) => { if (openExternalLink(contactUrl)) event.preventDefault(); }}>{t('requests.writeTelegram')}</a>
      <button className="text-button" type="button" disabled={busy} onClick={() => { void reveal(); }}>{t('requests.recheckContact')}</button></> : <button className="primary-button" type="button" disabled={busy} onClick={() => { void reveal(); }}>{t(busy ? 'requests.checkingContact' : 'requests.showContact')}</button>}
    {error && <RequestError code={error} />}
  </div>;
}

export function RequestItemActions({ item, direction, onUpdated, onBlocked, onAuthError, onChanged }: ActionCallbacks & {
  item: RequestItem; direction: RequestDirection; onUpdated(item: RequestItem): void; onBlocked(profileId: string): void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'accept' | 'decline' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useOperation();
  useEffect(() => { setError(null); }, [item.id, item.status]);
  async function resolve(action: 'accept' | 'decline' | 'cancel') {
    if (busy || item.status !== 'PENDING') return;
    const controller = operation.start(); setBusy(action); setError(null);
    try {
      const response = await api.resolveRequest(item.id, action, controller.signal);
      if (controller.signal.aborted) return;
      onUpdated(response.request); onChanged();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (requestAuthErrors.includes(errorCode(cause))) onAuthError(cause);
      else setError(errorCode(cause));
    } finally { if (!controller.signal.aborted) setBusy(null); }
  }
  return <div className="request-card-actions">
    {item.status === 'PENDING' && <div className="request-action-row">{direction === 'incoming' ? <>
      <button className="primary-button" type="button" disabled={Boolean(busy) || !item.player} onClick={() => { void resolve('accept'); }}>{t(busy === 'accept' ? 'requests.accepting' : 'requests.accept')}</button>
      <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => { void resolve('decline'); }}>{t(busy === 'decline' ? 'requests.declining' : 'requests.decline')}</button>
    </> : <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => { void resolve('cancel'); }}>{t(busy === 'cancel' ? 'requests.canceling' : 'requests.cancel')}</button>}</div>}
    {error && <RequestError code={error} />}
    {item.status === 'ACCEPTED' && <AcceptedContact item={item} onAuthError={onAuthError} />}
    {item.player && <BlockProfileButton player={item.player} disabled={Boolean(busy)} onBlocked={onBlocked} onAuthError={onAuthError} onChanged={onChanged} />}
  </div>;
}
