import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, errorCode } from './api.js';
import { createReportSubmission, REPORT_DETAILS_MAX_LENGTH, REPORT_REASONS, reportDetailsLength, submitReportAndBlock, type ReportReason, type ReportTarget } from './moderation.js';
import { formatRequestDate, requestAuthErrors } from './requests.js';
import './moderation.css';

type Props = { target: ReportTarget; profileId: string | null; disabled?: boolean; onAuthError(error: unknown): void; onBlocked(profileId: string): void; onChanged(): void };

export function ReportButton({ disabled, ...props }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <><button className="text-button report-button" type="button" disabled={disabled} onClick={() => setOpen(true)}>{t('moderation.report')}</button>
    {open && <ReportDialog {...props} onClose={() => setOpen(false)} />}</>;
}

export function ModerationError({ code, resetAt }: { code: string; resetAt?: string | null }) {
  const { t, i18n } = useTranslation();
  return <p className="request-error" role="alert">{t(`moderation.errors.${code}`, { defaultValue: t(`requests.errors.${code}`, { defaultValue: t(`errors.${code}`, { defaultValue: t('errors.REQUEST_FAILED') }) }) })}
    {code === 'REPORT_DAILY_LIMIT_REACHED' && resetAt && <span className="request-error-detail">{t('moderation.dailyReset', { date: formatRequestDate(resetAt, i18n.resolvedLanguage ?? 'ru') })}</span>}</p>;
}

export function ReportDialog({ target, profileId, onAuthError, onBlocked, onChanged, onClose }: Omit<Props, 'disabled'> & { onClose(): void }) {
  const { t } = useTranslation();
  const id = useId(); const dialog = useRef<HTMLDivElement | null>(null);
  const [reason, setReason] = useState<ReportReason | ''>(''); const [details, setDetails] = useState('');
  const [blockToo, setBlockToo] = useState(false); const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false); const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null); const [resetAt, setResetAt] = useState<string | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null); const active = useRef<AbortController | null>(null);
  const blockedRef = useRef(false);
  const input = createReportSubmission(target, reason, details);
  useEffect(() => {
    const previousFocus = document.activeElement; const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog.current?.focus();
    return () => { active.current?.abort(); document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  useEffect(() => {
    if (error !== 'REPORT_DAILY_LIMIT_REACHED' || !resetAt) return;
    const remaining = Date.parse(resetAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    const timer = setTimeout(() => { setError(null); setResetAt(null); }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [error, resetAt]);
  function close() { if (busy) return; if (blockedRef.current && profileId) { onBlocked(profileId); onChanged(); } onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!input || busy || active.current || success) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(null); setResetAt(null);
    try {
      const result = await submitReportAndBlock(input, profileId, blockToo, {
        report: (value) => api.report(value, controller.signal), block: (value) => api.blockProfile(value, controller.signal),
      });
      if (controller.signal.aborted) return;
      setSuccess(true); setDetails(''); setBlockError(result.blockError); setBlocked(result.blocked); blockedRef.current = result.blocked;
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (requestAuthErrors.includes(errorCode(cause))) onAuthError(cause);
      else { setError(errorCode(cause)); setResetAt(cause instanceof ApiError ? cause.resetAt ?? null : null); }
    } finally { if (!controller.signal.aborted) { setBusy(false); active.current = null; } }
  }
  async function retryBlock() {
    if (!profileId || busy || active.current || blocked) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setBlockError(null);
    try { await api.blockProfile(profileId, controller.signal); if (!controller.signal.aborted) { setBlocked(true); blockedRef.current = true; } }
    catch (cause) { if (!controller.signal.aborted) setBlockError(errorCode(cause)); }
    finally { if (!controller.signal.aborted) { setBusy(false); active.current = null; } }
  }
  return <div className="request-dialog-overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="request-dialog moderation-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={dialog}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); }
        if (event.key !== 'Tab') return;
        const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]');
        if (!controls?.length) { event.preventDefault(); return; }
        const first = controls[0]!; const last = controls[controls.length - 1]!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
      }}>
      <h2 id={`${id}-title`}>{t('moderation.reportTitle')}</h2>
      {success ? <ReportSuccess blocked={blocked} blockError={blockError} busy={busy} onRetryBlock={() => { void retryBlock(); }} onClose={close} />
        : <ReportForm id={id} reason={reason} details={details} blockToo={blockToo} canBlock={profileId !== null} busy={busy} error={error} resetAt={resetAt}
          onReason={setReason} onDetails={setDetails} onBlockToo={setBlockToo} onSubmit={(event) => { void submit(event); }} onClose={close} valid={Boolean(input)} />}
    </div>
  </div>;
}

export function ReportForm({ id, reason, details, blockToo, canBlock, busy, error, resetAt, valid, onReason, onDetails, onBlockToo, onSubmit, onClose }: {
  id: string; reason: ReportReason | ''; details: string; blockToo: boolean; canBlock: boolean; busy: boolean; error: string | null; resetAt?: string | null; valid: boolean;
  onReason(value: ReportReason | ''): void; onDetails(value: string): void; onBlockToo(value: boolean): void; onSubmit(event: FormEvent): void; onClose(): void;
}) {
  const { t } = useTranslation(); const count = reportDetailsLength(details);
  return <form className="report-form" onSubmit={onSubmit} noValidate>
    <p id={`${id}-privacy`}>{t('moderation.reportPrivacy')}</p>
    <label className="profile-field" htmlFor={`${id}-reason`}><span>{t('moderation.reason')}</span>
      <select id={`${id}-reason`} value={reason} disabled={busy} required onChange={(event) => onReason(event.target.value as ReportReason | '')}>
        <option value="">{t('moderation.reasonPlaceholder')}</option>{REPORT_REASONS.map((value) => <option key={value} value={value}>{t(`moderation.reasons.${value}`)}</option>)}
      </select></label>
    <label className="profile-field" htmlFor={`${id}-details`}><span>{t('moderation.details')}</span>
      <textarea id={`${id}-details`} value={details} rows={4} disabled={busy} aria-describedby={`${id}-privacy ${id}-counter`} aria-invalid={count > REPORT_DETAILS_MAX_LENGTH}
        onChange={(event) => onDetails(Array.from(event.target.value).slice(0, REPORT_DETAILS_MAX_LENGTH).join(''))} /></label>
    <span id={`${id}-counter`} className="profile-counter" aria-live="polite">{t('moderation.counter', { count, max: REPORT_DETAILS_MAX_LENGTH })}</span>
    {canBlock && <label className="checkbox-row"><input type="checkbox" checked={blockToo} disabled={busy} onChange={(event) => onBlockToo(event.target.checked)} /><span>{t('moderation.blockToo')}<small>{t('moderation.blockDescription')}</small></span></label>}
    <p className="report-confirmation">{t('moderation.confirmation')}</p>
    {error && <ModerationError code={error} resetAt={resetAt} />}
    <div className="request-dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>{t('profile.cancel')}</button>
      <button className="primary-button" type="submit" disabled={busy || !valid || error === 'REPORT_DAILY_LIMIT_REACHED'}>{t(busy ? 'moderation.sending' : 'moderation.send')}</button></div>
  </form>;
}

export function ReportSuccess({ blocked, blockError, busy, onRetryBlock, onClose }: { blocked: boolean; blockError: string | null; busy: boolean; onRetryBlock(): void; onClose(): void }) {
  const { t } = useTranslation();
  return <div className="report-success"><p role="status">{t('moderation.received')}</p>
    {blocked && <p role="status">{t('moderation.blocked')}</p>}
    {blockError && <div><p>{t('moderation.blockFailed')}</p><ModerationError code={blockError} />
      <button className="secondary-button" type="button" disabled={busy} onClick={onRetryBlock}>{t(busy ? 'requests.blocking' : 'moderation.retryBlock')}</button></div>}
    <button className="primary-button" type="button" disabled={busy} onClick={onClose}>{t('moderation.close')}</button>
  </div>;
}
