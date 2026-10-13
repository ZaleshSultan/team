import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { feedRequirementSchema, type FeedFilters, type FeedRequirement, type ProfileOptions, type PublicPlayerCard } from '@squad/shared';
import { api, ApiError, errorCode } from './api.js';
import { activeFeedFilterCount, applyFeedPage, defaultFeedFilters, feedChoiceFields, isPullToRefresh, readFeedFilters, rememberFeedFilters, toggleFeedChoice, type FeedChoiceField, type FeedPageState } from './feed.js';
import './feed.css';

const authErrors = ['SESSION_EXPIRED', 'SESSION_INVALID', 'UNAUTHORIZED', 'USER_BANNED'];
type Pending = 'initial' | 'refresh' | 'more' | null;

export function FeedScreen({ onProfile, onAuthError }: { onProfile(): void; onAuthError(error: unknown): void }) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<ProfileOptions | null>(null);
  const [filters, setFilters] = useState<FeedFilters>(defaultFeedFilters);
  const [page, setPage] = useState<FeedPageState>({ items: [], nextCursor: null });
  const [pending, setPending] = useState<Pending>('initial');
  const [error, setError] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<FeedRequirement[]>([]);
  const [sheet, setSheet] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [pulling, setPulling] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const count = activeFeedFilterCount(filters);

  function handleError(cause: unknown) {
    const code = errorCode(cause);
    if (authErrors.includes(code)) onAuthError(cause);
    else {
      setError(code);
      const missing = cause instanceof ApiError ? cause.requirements?.flatMap((item) => {
        const parsed = feedRequirementSchema.safeParse(item); return parsed.success ? [parsed.data] : [];
      }) ?? [] : [];
      setRequirements(missing);
      if (code === 'FEED_REQUIREMENTS_MISSING') setPage({ items: [], nextCursor: null });
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);

  // Load provider choices before trusting locally remembered filters.
  useEffect(() => {
    const controller = new AbortController();
    active.current?.abort(); active.current = controller;
    setPending('initial'); setError(null); setRequirements([]);
    void api.profile(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setOptions(result.options);
      const saved = readFeedFilters(result.options);
      setFilters(saved);
      return api.feed(saved, null, controller.signal).then((response) => {
        if (!controller.signal.aborted) setPage(applyFeedPage({ items: [], nextCursor: null }, response, false));
      });
    }).catch((cause: unknown) => { if (!controller.signal.aborted) handleError(cause); })
      .finally(() => { if (!controller.signal.aborted) { setPending(null); active.current = null; } });
    return () => controller.abort();
    // Reopening the screen or retrying options is an explicit new first-page read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  async function load(nextFilters: FeedFilters, append = false) {
    const cursor = append ? page.nextCursor : null;
    if (append && (!cursor || active.current)) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setPending(append ? 'more' : 'refresh'); setError(null); setRequirements([]);
    if (!append) setPage({ items: [], nextCursor: null });
    try {
      const response = await api.feed(nextFilters, cursor, controller.signal);
      if (!controller.signal.aborted && mounted.current) setPage((current) => applyFeedPage(current, response, append));
    } catch (cause) { if (!controller.signal.aborted && mounted.current) handleError(cause); }
    finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted && mounted.current) setPending(null);
    }
  }

  function apply(filters: FeedFilters) {
    setFilters(filters); rememberFeedFilters(filters); setSheet(false); void load(filters);
  }
  function retry() {
    if (!options) setGeneration((value) => value + 1);
    else void load(filters, !['INVALID_CURSOR', 'FEED_INVALID_CURSOR'].includes(error ?? '') && page.items.length > 0 && page.nextCursor !== null);
  }
  const reset = () => apply(defaultFeedFilters());

  return <section className="feed-screen" aria-labelledby="feed-title"
    onTouchStart={(event) => { const first = event.touches[0]; touch.current = first && window.scrollY <= 0 ? { x: first.clientX, y: first.clientY } : null; }}
    onTouchMove={(event) => { const point = event.touches[0]; if (point) setPulling(isPullToRefresh(touch.current, { x: point.clientX, y: point.clientY })); }}
    onTouchCancel={() => { touch.current = null; setPulling(false); }}
    onTouchEnd={(event) => { const end = event.changedTouches[0]; const refresh = end && isPullToRefresh(touch.current, { x: end.clientX, y: end.clientY }); touch.current = null; setPulling(false); if (refresh && !pending) void load(filters); }}>
    <div className="feed-heading"><div><p className="eyebrow">{t('feed.eyebrow')}</p><h1 id="feed-title">{t('feed.title')}</h1></div>
      <button className="secondary-button" type="button" disabled={Boolean(pending)} onClick={() => { if (options) void load(filters); else retry(); }}>{t(pending === 'refresh' ? 'feed.refreshing' : 'feed.refresh')}</button></div>
    <p className="feed-description">{t('feed.description')}</p>
    <div className="feed-toolbar"><button className="primary-button" type="button" disabled={!options} onClick={() => setSheet(true)}>{t('feed.filters')}{count > 0 && <span className="feed-filter-count">{count}</span>}</button>
      <p>{t('feed.filterSemantics')}</p></div>
    <FeedFilterSummary filters={filters} onReset={reset} />
    <p className="feed-pull-hint" role="status">{t(pulling ? 'feed.releaseRefresh' : 'feed.pullRefresh')}</p>
    <FeedResults page={page} pending={pending} error={error} requirements={requirements} hasFilters={count > 0} onRetry={retry} onReset={reset} onProfile={onProfile} onMore={() => { void load(filters, true); }} />
    {sheet && options && <FeedFilterSheet filters={filters} options={options} onApply={apply} onCancel={() => setSheet(false)} />}
  </section>;
}

export function FeedResults({ page, pending, error, requirements, hasFilters, onRetry, onReset, onProfile, onMore }: {
  page: FeedPageState; pending: Pending; error: string | null; requirements: FeedRequirement[]; hasFilters: boolean;
  onRetry(): void; onReset(): void; onProfile(): void; onMore(): void;
}) {
  const { t } = useTranslation();
  if (error === 'FEED_REQUIREMENTS_MISSING') return <div className="account-panel feed-state" role="status"><h2>{t('feed.requirementsTitle')}</h2><p>{t('feed.requirementsDescription')}</p>
    <ul>{requirements.map((item) => <li key={item.code}>{t(`feed.requirements.${item.code}`)}</li>)}</ul>
    <button className="primary-button" type="button" onClick={onProfile}>{t('feed.completeProfile')}</button></div>;
  return <div className="feed-results" aria-busy={Boolean(pending)}>
    {error && <div className="account-panel feed-state feed-error" role="alert"><h2>{t('feed.errorTitle')}</h2>
      <p>{t(`feed.errors.${error}`, { defaultValue: t(`errors.${error}`, { defaultValue: t('errors.REQUEST_FAILED') }) })}</p>
      <button className="secondary-button" type="button" disabled={Boolean(pending)} onClick={onRetry}>{t('auth.retry')}</button>
      {hasFilters && <button className="text-button" type="button" disabled={Boolean(pending)} onClick={onReset}>{t('feed.reset')}</button>}</div>}
    {page.items.length > 0 && <div className="feed-grid">{page.items.map((card) => <FeedPlayerCard key={card.id} card={card} />)}</div>}
    {pending && <FeedSkeleton />}
    {!pending && !error && page.items.length === 0 && <div className="account-panel feed-state"><h2>{t('feed.emptyTitle')}</h2><p>{t(hasFilters ? 'feed.emptyFiltered' : 'feed.emptyDefault')}</p>
      {hasFilters ? <button className="secondary-button" type="button" onClick={onReset}>{t('feed.reset')}</button> : <button className="secondary-button" type="button" onClick={onRetry}>{t('feed.refresh')}</button>}</div>}
    {page.nextCursor && !error && <button className="secondary-button feed-more" type="button" disabled={Boolean(pending)} onClick={onMore}>{t(pending === 'more' ? 'feed.loadingMore' : 'feed.loadMore')}</button>}
    {!pending && !error && page.items.length > 0 && !page.nextCursor && <p className="feed-end" role="status">{t('feed.end')}</p>}
  </div>;
}

export function FeedSkeleton() {
  const { t } = useTranslation();
  return <div className="feed-loading" role="status"><span className="feed-visually-hidden">{t('feed.loading')}</span><div className="feed-grid" aria-hidden="true">{[0, 1, 2].map((index) => <div className="feed-card feed-skeleton" key={index}><span /><span /><span /><span /></div>)}</div></div>;
}

export function FeedPlayerCard({ card }: { card: PublicPlayerCard }) {
  const { t, i18n } = useTranslation();
  const hours = (value: number | null) => value === null ? t('stats.unknown') : t('stats.hours', { value: new Intl.NumberFormat(i18n.resolvedLanguage === 'en' ? 'en' : 'ru', { maximumFractionDigits: 1 }).format(value) });
  const chipList = (field: 'roles' | 'lookingFor' | 'playTimes') => <div className="feed-card-chips">{card[field].map((value) => <span className="feed-card-chip" key={value}>{t(`profile.options.${field}.${value}`, { defaultValue: value })}</span>)}</div>;
  return <article className="feed-card">
    <div className="feed-card-heading"><h2>{card.nickname ?? t('profile.unnamed')}</h2>{card.faceit && <div className="feed-faceit"><span>{t('stats.faceit')}</span><strong>{card.faceit.level ?? '—'}</strong><small>{t('feed.eloValue', { value: card.faceit.elo ?? '—' })}</small></div>}</div>
    <div className="profile-badges">{card.badges.steamVerified && <span className="badge">{t('profile.steamVerified')}</span>}{card.badges.faceitVerified && <span className="badge">{t('profile.faceitVerified')}</span>}</div>
    <div className="feed-card-section"><h3>{t('feed.cardRoles')}</h3>{chipList('roles')}</div>
    <div className="feed-card-meta"><span>{card.languages.map((language) => t(`profile.options.languages.${language}`, { defaultValue: language })).join(' · ')}</span>
      <span>{t(`profile.options.regions.${card.region}`, { defaultValue: card.region })}</span><span><span aria-hidden="true">{card.hasMic ? '🎙' : '—'}</span> {t(card.hasMic ? 'feed.micYes' : 'feed.micNo')}</span></div>
    <div className="feed-card-section"><h3>{t('feed.cardLookingFor')}</h3>{chipList('lookingFor')}</div>
    <div className="feed-card-section"><h3>{t('feed.cardPlayTimes')}</h3>{chipList('playTimes')}</div>
    {card.bio && <p className="feed-card-bio">{card.bio}</p>}
    {card.hasBans === true && <p className="feed-ban-warning">{t('feed.banWarning')}</p>}
    {card.hasBans === null && <p className="feed-card-note">{t('feed.banUnknown')}</p>}
    {card.activity && <dl className="feed-activity"><div><dt>{t('stats.cs2Total')}</dt><dd>{hours(card.activity.cs2Hours)}</dd></div><div><dt>{t('stats.cs2Recent')}</dt><dd>{hours(card.activity.cs2Hours2weeks)}</dd></div></dl>}
    {/* M6/M7 action slot: requests, contacts and reporting intentionally render no controls in M5. */}
  </article>;
}

export function FeedFilterSummary({ filters, onReset }: { filters: FeedFilters; onReset(): void }) {
  const { t } = useTranslation();
  const labels = feedChoiceFields.flatMap((field) => filters[field].map((value) => t(`profile.options.${field}.${value}`, { defaultValue: value })));
  if (filters.faceitLevelMin !== undefined || filters.faceitLevelMax !== undefined) labels.push(t('feed.faceitRangeSummary', { min: filters.faceitLevelMin ?? 1, max: filters.faceitLevelMax ?? 10 }));
  if (filters.hasMic !== undefined) labels.push(t(filters.hasMic ? 'feed.micYes' : 'feed.micNo'));
  if (filters.verifiedOnly) labels.push(t('feed.verifiedOnly'));
  labels.push(t(filters.noBans ? 'feed.noBans' : 'feed.includeBans'));
  return <div className="feed-filter-summary" aria-label={t('feed.activeFilters')}><div>{labels.map((label, index) => <span key={`${index}-${label}`}>{label}</span>)}</div>
    {activeFeedFilterCount(filters) > 0 && <button className="text-button" type="button" onClick={onReset}>{t('feed.reset')}</button>}</div>;
}

export function FeedFilterSheet({ filters, options, onApply, onCancel }: { filters: FeedFilters; options: ProfileOptions; onApply(filters: FeedFilters): void; onCancel(): void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(filters);
  const dialog = useRef<HTMLDivElement | null>(null);
  const rangeValid = (draft.faceitLevelMin ?? 1) <= (draft.faceitLevelMax ?? 10);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, []);
  function submit(event: FormEvent) { event.preventDefault(); if (rangeValid) onApply(draft); }
  function choices(field: FeedChoiceField) {
    return <fieldset className="profile-chip-field" key={field}><legend>{t(field === 'regions' ? 'feed.regions' : `profile.${field}`)}</legend><div className="profile-chips">
      {options[field].map((choice) => <button className="profile-chip" key={choice} type="button" aria-pressed={draft[field].includes(choice)}
        onClick={() => setDraft((current) => ({ ...current, [field]: toggleFeedChoice(current[field], choice) }))}>{t(`profile.options.${field}.${choice}`, { defaultValue: choice })}</button>)}</div></fieldset>;
  }
  return <div className="feed-sheet-overlay" onClick={(event) => { if (event.currentTarget === event.target) onCancel(); }}><div className="feed-sheet" role="dialog" aria-modal="true" aria-labelledby="feed-filter-title" tabIndex={-1} ref={dialog}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onCancel(); }
      if (event.key === 'Tab') {
        const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
        if (!focusable?.length) return;
        const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
      }
    }}><form onSubmit={submit} noValidate>
      <div className="feed-sheet-heading"><h2 id="feed-filter-title">{t('feed.filters')}</h2><button className="secondary-button" type="button" onClick={onCancel}>{t('profile.cancel')}</button></div>
      <p className="feed-description">{t('feed.filterSemantics')}</p>
      <fieldset className="feed-level-field"><legend>{t('feed.faceitLevel')}</legend><div className="feed-level-range">{(['faceitLevelMin', 'faceitLevelMax'] as const).map((field) => <label className="profile-field" key={field}><span>{t(field === 'faceitLevelMin' ? 'feed.minimum' : 'feed.maximum')}</span><select value={draft[field] ?? ''} aria-invalid={!rangeValid} aria-describedby={!rangeValid ? 'feed-range-error' : undefined}
        onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value ? Number(event.target.value) : undefined }))}><option value="">{t('feed.anyLevel')}</option>{Array.from({ length: 10 }, (_, index) => index + 1).map((level) => <option key={level} value={level}>{level}</option>)}</select></label>)}</div>
        {!rangeValid && <p id="feed-range-error" role="alert" className="profile-field-error">{t('feed.invalidRange')}</p>}</fieldset>
      {feedChoiceFields.map(choices)}
      <fieldset className="profile-chip-field"><legend>{t('profile.microphone')}</legend><div className="profile-chips">{(['any', 'yes', 'no'] as const).map((value) => <button type="button" className="profile-chip" key={value} aria-pressed={draft.hasMic === (value === 'any' ? undefined : value === 'yes')}
        onClick={() => setDraft((current) => ({ ...current, hasMic: value === 'any' ? undefined : value === 'yes' }))}>{t(`feed.mic.${value}`)}</button>)}</div></fieldset>
      <label className="checkbox-row"><input type="checkbox" checked={draft.verifiedOnly} onChange={(event) => setDraft((current) => ({ ...current, verifiedOnly: event.target.checked }))} /><span>{t('feed.verifiedOnly')}<small>{t('feed.verifiedHint')}</small></span></label>
      <label className="checkbox-row"><input type="checkbox" checked={draft.noBans} onChange={(event) => setDraft((current) => ({ ...current, noBans: event.target.checked }))} /><span>{t('feed.noBans')}<small>{t('feed.noBansHint')}</small></span></label>
      <div className="feed-sheet-actions"><button className="text-button" type="button" onClick={() => setDraft(defaultFeedFilters())}>{t('feed.reset')}</button><button className="primary-button" type="submit" disabled={!rangeValid}>{t('feed.apply')}</button></div>
    </form></div></div>;
}
