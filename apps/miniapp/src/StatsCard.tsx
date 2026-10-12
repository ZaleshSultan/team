import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { StatsResponse } from '@squad/shared';
import { api, errorCode } from './api.js';
import { cooldownSeconds, formatPlaytime, pollCachedStats, providerUnavailable, statsPending } from './stats.js';

export function StatsCard({ onAuthError }: { onAuthError(error: unknown): void }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<'refresh' | 'faceit' | null>(null);
  const [generation, setGeneration] = useState(0);
  const [nickname, setNickname] = useState('');
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const operationController = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationController.current?.abort();
      operationController.current = null;
    };
  }, []);

  function handleError(cause: unknown) {
    if (!mounted.current) return;
    const code = errorCode(cause);
    if (['SESSION_EXPIRED', 'SESSION_INVALID', 'UNAUTHORIZED', 'USER_BANNED'].includes(code)) onAuthError(cause);
    else setError(code);
  }

  useEffect(() => {
    const controller = new AbortController();
    void pollCachedStats({
      signal: controller.signal,
      read: (signal) => api.stats(signal),
      onStats: (result) => { setStats(result); setLoading(false); },
      onError: (cause) => { handleError(cause); setLoading(false); },
    });
    return () => controller.abort();
    // The callback uses the same session identity for this mounted card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') setGeneration((value) => value + 1);
    };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, []);

  useEffect(() => {
    const availableAt = stats?.sync.manualAvailableAt ?? null;
    setNow(Date.now());
    if (cooldownSeconds(availableAt) === 0) return;
    const timer = setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (cooldownSeconds(availableAt, currentTime) === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [stats?.sync.manualAvailableAt]);

  async function refresh() {
    if (operationController.current || !stats || statsPending(stats.sync) || cooldownSeconds(stats.sync.manualAvailableAt) > 0) return;
    const controller = new AbortController();
    operationController.current = controller;
    setOperation('refresh');
    setError(null);
    try {
      const result = await api.refreshStats(controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      setStats((current) => current ? { ...current, sync: result.sync } : null);
      setNow(Date.now());
      setGeneration((value) => value + 1);
    } catch (cause) {
      if (controller.signal.aborted || !mounted.current) return;
      handleError(cause);
      setGeneration((value) => value + 1);
    } finally {
      if (operationController.current === controller) operationController.current = null;
      if (!controller.signal.aborted && mounted.current) setOperation(null);
    }
  }

  async function linkFaceit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operationController.current || !nickname.trim() || !stats?.availability.faceit || statsPending(stats.sync)) return;
    const controller = new AbortController();
    operationController.current = controller;
    setOperation('faceit');
    setError(null);
    try {
      const result = await api.linkFaceit(nickname, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      setStats(result);
      setNickname('');
      setGeneration((value) => value + 1);
    } catch (cause) {
      if (!controller.signal.aborted) handleError(cause);
    } finally {
      if (operationController.current === controller) operationController.current = null;
      if (!controller.signal.aborted && mounted.current) setOperation(null);
    }
  }

  const cooldown = cooldownSeconds(stats?.sync.manualAvailableAt ?? null, now);
  const pending = stats && statsPending(stats.sync);
  const refreshUnavailable = !stats || (!stats.availability.steam && !stats.availability.faceit);

  return <section className="account-panel stats-panel" aria-busy={loading || Boolean(operation)}>
    <div className="section-heading"><span className="step-label">{t('stats.step')}</span>
      <span className="badge badge-muted">{t('stats.cached')}</span></div>
    <h2>{t('stats.title')}</h2>
    <p className="panel-description">{t('stats.description')}</p>
    {loading && <p className="stats-status" role="status">{t('stats.loading')}</p>}
    {stats && <StatsView stats={stats} />}
    {error && <p className="stats-error" role="alert">{t(`errors.${error}`, { defaultValue: t('errors.REQUEST_FAILED') })}</p>}
    {stats && <>
      <div className="stats-refresh">
        <button className="secondary-button" type="button" disabled={refreshUnavailable || Boolean(operation) || Boolean(pending) || cooldown > 0}
          onClick={() => { void refresh(); }}>{t(operation === 'refresh' || pending ? 'stats.refreshing' : 'stats.refresh')}</button>
        {cooldown > 0 && <span>{t('stats.cooldown', { seconds: cooldown })}</span>}
        {error === 'STATS_STATUS_TIMEOUT' && <button className="text-button" type="button" onClick={() => { setError(null); setGeneration((value) => value + 1); }}>
          {t('stats.checkStatus')}
        </button>}
      </div>
      <form className="faceit-link-form" onSubmit={(event) => { void linkFaceit(event); }}>
        <label htmlFor="faceit-nickname">{t('stats.faceitNickname')}</label>
        <p>{t('stats.faceitLinkDescription')}</p>
        <div className="faceit-input-row">
          <input id="faceit-nickname" type="text" value={nickname} maxLength={100} autoComplete="off" spellCheck={false}
            placeholder={t('stats.faceitPlaceholder')} disabled={!stats.availability.faceit || Boolean(operation) || Boolean(pending)}
            onChange={(event) => setNickname(event.target.value)} />
          <button className="secondary-button" type="submit" disabled={!stats.availability.faceit || !nickname.trim() || Boolean(operation) || Boolean(pending)}>
            {t(operation === 'faceit' ? 'stats.faceitLinking' : 'stats.faceitLink')}
          </button>
        </div>
      </form>
    </>}
    {!loading && !stats && <button type="button" className="secondary-button" onClick={() => { setLoading(true); setError(null); setGeneration((value) => value + 1); }}>
      {t('auth.retry')}
    </button>}
  </section>;
}

/** A pure cached-data view, also used by server-rendered presentation tests. */
export function StatsView({ stats }: { stats: StatsResponse }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage === 'en' ? 'en' : 'ru';
  const unknown = t('stats.unknown');
  const hours = (minutes: number | null | undefined) => {
    const formatted = formatPlaytime(minutes, language);
    return formatted === null ? unknown : t('stats.hours', { value: formatted });
  };
  const steamUnavailable = providerUnavailable(stats, 'steam');
  const faceitUnavailable = providerUnavailable(stats, 'faceit');
  const bans = stats.steam?.bans;
  const economy = bans?.economyBan;
  const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : t('stats.neverSynced');

  return <div className="stats-content">
    <p className="stats-status" role="status">{t(`stats.status.${stats.sync.status}`)}</p>
    {stats.sync.status === 'FAILED' && <p className="stats-warning">{t('stats.syncFailed')}</p>}
    {steamUnavailable && <p className="stats-warning">{t('stats.steamUnavailable')}</p>}
    <dl className="stats-grid">
      <div><dt>{t('stats.cs2Total')}</dt><dd>{hours(stats.steam?.cs2?.playtimeTotal)}</dd></div>
      <div><dt>{t('stats.cs2Recent')}</dt><dd>{hours(stats.steam?.cs2?.playtime2weeks)}</dd></div>
      <div><dt>{t('stats.vacBans')}</dt><dd>{bans?.vacBans ?? unknown}</dd></div>
      <div><dt>{t('stats.gameBans')}</dt><dd>{bans?.gameBans ?? unknown}</dd></div>
      <div><dt>{t('stats.communityBan')}</dt><dd>{bans?.communityBanned == null ? unknown : t(bans.communityBanned ? 'stats.banned' : 'stats.clear')}</dd></div>
      <div><dt>{t('stats.economyBan')}</dt><dd>{economy == null ? unknown : t(economy === 'none' ? 'stats.clear' : economy === 'probation' ? 'stats.probation' : 'stats.restricted')}</dd></div>
    </dl>
    {bans?.daysSinceLastBan != null && (Boolean(bans.vacBans) || Boolean(bans.gameBans)) && <p className="stats-meta">{t('stats.lastBan', { days: bans.daysSinceLastBan })}</p>}
    {stats.guidance.map((guidance) => <p className="stats-guidance" key={guidance}>{t(`stats.guidance.${guidance}`)}</p>)}
    <p className="stats-meta">{t('stats.updated', { date: date(stats.steam?.syncedAt) })}</p>
    <div className="faceit-summary">
      <h3>{t('stats.faceit')}</h3>
      {faceitUnavailable && <p className="stats-warning">{t('stats.faceitUnavailable')}</p>}
      {stats.faceit?.verified ? <>
        <p className="faceit-nickname">{stats.faceit.nickname}<span className="badge">{t('stats.faceitVerified')}</span></p>
        <dl className="stats-grid">
          <div><dt>{t('stats.faceitLevel')}</dt><dd>{stats.faceit.level ?? unknown}</dd></div>
          <div><dt>{t('stats.faceitElo')}</dt><dd>{stats.faceit.elo ?? unknown}</dd></div>
          <div><dt>{t('stats.faceitKd')}</dt><dd>{stats.faceit.kd == null ? unknown : new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(stats.faceit.kd)}</dd></div>
          <div><dt>{t('stats.faceitWinRate')}</dt><dd>{stats.faceit.winRate == null ? unknown : t('stats.percent', { value: new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(stats.faceit.winRate) })}</dd></div>
        </dl>
        {stats.faceit.favoriteMaps.length > 0 && <p className="stats-meta">{t('stats.favoriteMaps', { maps: stats.faceit.favoriteMaps.join(', ') })}</p>}
        <p className="stats-meta">{t('stats.updated', { date: date(stats.faceit.syncedAt) })}</p>
      </> : <p className="stats-meta">{t('stats.faceitNotLinked')}</p>}
    </div>
  </div>;
}
