import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthUser } from '@squad/shared';
import { api, errorCode } from './api.js';
import { getTelegramWebApp, openExternalLink, prepareTelegram } from './telegram.js';
import { isPendingSteamLink, pollSteamLink, type SteamLinkSnapshot } from './steam-polling.js';
import { createOnboardingSubmission } from './onboarding.js';
import { StatsCard } from './StatsCard.js';
import { SteamLinkProgress } from './SteamLinkProgress.js';
import { AccountDeletionSection, ProfileScreen } from './ProfileScreen.js';
import { FeedScreen } from './FeedScreen.js';
import { RequestsScreen } from './RequestsScreen.js';
import { ConfirmationDialog } from './RequestActions.js';
import { startPendingRequestPolling } from './requests.js';

type LinkAttempt = SteamLinkSnapshot & { url: string };
type Operation = 'onboarding' | 'telegram' | 'steam' | 'logout' | null;

function Crosshair({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2v5m0 10v5M2 12h5m10 0h5" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function AuthErrorPanel({ code, onRetry, minimumAge }: { code: string; onRetry: () => void; minimumAge?: number }) {
  const { t } = useTranslation();
  const title = code === 'TELEGRAM_REQUIRED' ? 'auth.telegramTitle'
    : code === 'ACCOUNT_DELETED' ? 'profile.accountDeletedTitle'
      : ['DEPENDENCIES_UNAVAILABLE', 'NETWORK_ERROR'].includes(code) ? 'auth.unavailableTitle' : 'auth.errorTitle';
  return <section className="account-panel state-panel">
    <span className="state-icon" aria-hidden="true"><Crosshair /></span>
    <h2>{t(title)}</h2>
    <p role="alert">{t(`errors.${code}`, { age: minimumAge, defaultValue: t('errors.REQUEST_FAILED') })}</p>
    {!['TELEGRAM_REQUIRED', 'ACCOUNT_DELETED'].includes(code) && <button className="primary-button" type="button"
      onClick={onRetry}>{t('auth.retry')}</button>}
  </section>;
}

export function App() {
  const { t, i18n } = useTranslation();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loginGeneration, setLoginGeneration] = useState(0);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [link, setLink] = useState<LinkAttempt | null>(null);
  const [minimumAgeConfirmed, setMinimumAgeConfirmed] = useState<number | null>(null);
  const [rulesVersionAccepted, setRulesVersionAccepted] = useState<string | null>(null);
  const [shareSteamActivity, setShareSteamActivity] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [screen, setScreen] = useState<'profile' | 'feed' | 'requests'>('profile');
  const [pendingNavigation, setPendingNavigation] = useState<'feed' | 'requests' | null>(null);
  const [pendingIncoming, setPendingIncoming] = useState(0);
  const summaryPolling = useRef<ReturnType<typeof startPendingRequestPolling> | null>(null);

  useEffect(() => {
    const releaseTheme = prepareTelegram();
    let disposed = false;
    setLoading(true);
    setAuthError(null);
    // The API client shares an in-flight login across React StrictMode effects.
    void api.authenticate(getTelegramWebApp()?.initData ?? '').then((result) => {
      if (disposed) return;
      setUser(result.user);
      setScreen('profile');
      setExpiresAt(result.expiresAt);
      setMinimumAgeConfirmed(result.user.onboarding.ageConfirmed ? result.user.onboarding.minimumAge : null);
      setRulesVersionAccepted(result.user.onboarding.rulesAccepted ? result.user.onboarding.rulesVersion : null);
      setShareSteamActivity(result.user.privacy.shareSteamActivity);
    }).catch((error: unknown) => {
      if (!disposed) setAuthError(errorCode(error));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; releaseTheme(); };
  }, [loginGeneration]);

  useEffect(() => {
    document.title = t('app.title');
    document.documentElement.lang = i18n.resolvedLanguage ?? 'ru';
  }, [i18n.resolvedLanguage, t]);

  useEffect(() => {
    setPendingIncoming(0);
    if (!user || user.onboarding.required || !user.username) return;
    const polling = startPendingRequestPolling({ getSummary: (signal) => api.requestSummary(signal), onCount: setPendingIncoming, onAuthError: handleError, target: document });
    summaryPolling.current = polling;
    return () => { polling.stop(); if (summaryPolling.current === polling) summaryPolling.current = null; };
    // Polling follows identity and eligibility, not every profile/cache update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.onboarding.required, Boolean(user?.username)]);

  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => {
      api.forgetSession();
      setUser(null);
      setLink(null);
      setAuthError('SESSION_EXPIRED');
    }, Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (!link || !isPendingSteamLink(link.status)) return;
    const controller = new AbortController();
    void pollSteamLink(link, {
      signal: controller.signal,
      getStatus: (id, signal) => api.steamLinkStatus(id, signal),
      onStatus: (status) => {
        setNotice(null);
        setLink((current) => current?.id === status.id ? { ...current, ...status } : current);
        if (status.status === 'COMPLETED') {
          void api.me(controller.signal).then((result) => {
            if (!controller.signal.aborted) setUser(result.user);
          }).catch((error: unknown) => {
            if (!controller.signal.aborted) handleError(error);
          });
        }
      },
      onError: handleError,
    });
    return () => controller.abort();
    // Status updates should not restart the same poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link?.id, link?.expiresAt, pollGeneration]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    function resume() {
      if (document.visibilityState !== 'visible') return;
      void api.me(controller.signal).then((result) => {
        if (!controller.signal.aborted) {
          setUser(result.user);
          setPollGeneration((generation) => generation + 1);
        }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) handleError(error);
      });
    }
    document.addEventListener('visibilitychange', resume);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', resume);
    };
    // User identity remains stable while its verification details change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  function handleError(error: unknown) {
    const code = errorCode(error);
    if (['SESSION_EXPIRED', 'UNAUTHORIZED', 'SESSION_INVALID', 'USER_BANNED'].includes(code)) {
      api.forgetSession();
      setUser(null);
      setLink(null);
      setAuthError(code === 'USER_BANNED' ? code : 'SESSION_EXPIRED');
    } else {
      setNotice(code);
    }
  }

  function errorText(code: string): string {
    return t(`errors.${code}`, { age: user?.onboarding.minimumAge, defaultValue: t('errors.REQUEST_FAILED') });
  }

  function changeLanguage(language: 'ru' | 'en') {
    try { localStorage.setItem('squad.language', language); } catch { /* WebView storage can be unavailable. */ }
    void i18n.changeLanguage(language);
  }

  async function submitOnboarding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || operation) return;
    const input = createOnboardingSubmission(user, { minimumAgeConfirmed, rulesVersionAccepted, shareSteamActivity }, i18n.resolvedLanguage === 'en' ? 'en' : 'ru');
    if (!input) return;
    setNotice(null);
    setOperation('onboarding');
    try {
      const result = await api.onboarding(input);
      setUser(result.user);
    } catch (error) { handleError(error); }
    finally { setOperation(null); }
  }

  async function refreshUsername() {
    setOperation('telegram');
    setNotice(null);
    try {
      const result = await api.refreshTelegram();
      setUser(result.user);
      if (!result.user.username) setNotice('USERNAME_REQUIRED');
    } catch (error) { handleError(error); }
    finally { setOperation(null); }
  }

  async function createSteamLink() {
    setOperation('steam');
    setNotice(null);
    try {
      const result = await api.createSteamLink();
      setLink({ ...result, status: 'PENDING', failureCode: null });
      // The next, explicit button click opens the external browser synchronously.
    } catch (error) { handleError(error); }
    finally { setOperation(null); }
  }

  function continueToSteam(event: MouseEvent<HTMLAnchorElement>) {
    if (link && openExternalLink(link.url)) event.preventDefault();
  }

  async function logout() {
    if (profileDirty && !window.confirm(t('profile.leaveConfirmation'))) return;
    setOperation('logout');
    try { await api.logout(); } catch { /* Local memory is cleared even when logout cannot reach the server. */ }
    setUser(null);
    setLink(null);
    setExpiresAt(null);
    setAuthError('SIGNED_OUT');
    setOperation(null);
  }

  function navigate(next: 'profile' | 'feed' | 'requests') {
    if (next === screen) return;
    if (screen === 'profile' && profileDirty && next !== 'profile') { setPendingNavigation(next); return; }
    setProfileDirty(false);
    setScreen(next);
  }

  const pendingLink = link && isPendingSteamLink(link.status);
  const onboardingRequired = user?.onboarding.required || !user?.username;
  const ageConfirmed = Boolean(user && minimumAgeConfirmed === user.onboarding.minimumAge);
  const rulesAccepted = Boolean(user && rulesVersionAccepted === user.onboarding.rulesVersion);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label={t('app.name')}>
          <span className="brand-symbol"><Crosshair /></span>
          <span>{t('app.name')}<span className="brand-dot">.</span></span>
        </div>
        <div className="language-toggle" role="group" aria-label={t('app.language')}>
          {(['ru', 'en'] as const).map((language) => (
            <button key={language} type="button" aria-pressed={i18n.resolvedLanguage === language}
              onClick={() => changeLanguage(language)}>{t(language === 'ru' ? 'app.russian' : 'app.english')}</button>
          ))}
        </div>
      </header>

      <main>
        {(screen === 'profile' || !user) && <section className="hero">
          <div className="game-tag"><span className="live-dot" />{t('app.game')}</div>
          <p className="eyebrow">{t('home.eyebrow')}</p>
          <h1>{t('home.headline')}<br /><span>{t('home.headlineAccent')}</span></h1>
          <p className="hero-description">{t('home.description')}</p>
          <div className="hero-art" aria-hidden="true">
            <div className="art-grid" /><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
            <Crosshair className="art-crosshair" />
          </div>
        </section>}

        {loading && <section className="account-panel state-panel" aria-live="polite" aria-busy="true">
          <span className="spinner" aria-hidden="true" /><h2>{t('auth.loading')}</h2><p>{t('auth.loadingDetail')}</p>
        </section>}

        {!loading && authError && <AuthErrorPanel code={authError} minimumAge={user?.onboarding.minimumAge}
          onRetry={() => setLoginGeneration((generation) => generation + 1)} />}

        {!loading && user && <>
          <nav className="squad-navigation" aria-label={t('feed.navigation')}>
            <button type="button" aria-current={screen === 'profile' ? 'page' : undefined} onClick={() => navigate('profile')}>{t('feed.profileTab')}</button>
            <button type="button" aria-current={screen === 'feed' ? 'page' : undefined} onClick={() => navigate('feed')}>{t('feed.feedTab')}</button>
            <button type="button" aria-current={screen === 'requests' ? 'page' : undefined} onClick={() => navigate('requests')}>{t('requests.navigation')}
              {pendingIncoming > 0 && <span className="request-nav-badge" aria-label={t('requests.pendingBadge', { count: pendingIncoming })}>{pendingIncoming > 99 ? t('requests.badgeOverflow') : pendingIncoming}</span>}</button>
          </nav>
          {screen === 'feed' ? <FeedScreen key={`feed-${user.id}`} onProfile={() => navigate('profile')} onAuthError={handleError} onRequests={() => navigate('requests')} onChanged={() => summaryPolling.current?.refresh()} /> : screen === 'requests' ?
            <RequestsScreen key={`requests-${user.id}`} onAuthError={handleError} onChanged={() => summaryPolling.current?.refresh()} onProfile={() => navigate('profile')} /> : <div className="account-layout">
          <section className="account-panel">
            <div className="section-heading"><span className="step-label">{t('identity.step')}</span>
              <span className="badge">{t('identity.telegramVerified')}</span></div>
            <h2>{t(onboardingRequired ? 'onboarding.title' : 'identity.title')}</h2>
            <p className="panel-description">{t(onboardingRequired ? 'onboarding.description' : 'identity.description')}</p>
            <div className="identity-row"><span>{t('identity.telegram')}</span>
              <strong>{user.username ? `@${user.username}` : t('identity.noUsername')}</strong></div>

            {onboardingRequired ? <form onSubmit={(event) => { void submitOnboarding(event); }}>
              {!user.username && <div className="username-note">
                <h3>{t('onboarding.usernameTitle')}</h3>
                <p>{t('onboarding.usernameDescription')}</p>
                <p className="settings-path">{t('onboarding.usernameInstructions')}</p>
                <button className="secondary-button" type="button" disabled={Boolean(operation)}
                  onClick={() => { void refreshUsername(); }}>
                  {t(operation === 'telegram' ? 'onboarding.refreshingUsername' : 'onboarding.refreshUsername')}
                </button>
              </div>}
              <div className="rules-block">
                <h3>{t('onboarding.rulesTitle')}</h3>
                <ul>{(['respect', 'fairPlay', 'privacy', 'spam'] as const).map((rule) => <li key={rule}>{t(`onboarding.rules.${rule}`)}</li>)}</ul>
              </div>
              <label className="checkbox-row"><input type="checkbox" checked={ageConfirmed}
                onChange={(event) => setMinimumAgeConfirmed(event.target.checked ? user.onboarding.minimumAge : null)} />
                <span>{t('onboarding.ageConfirmation', { age: user.onboarding.minimumAge })}</span></label>
              <label className="checkbox-row"><input type="checkbox" checked={rulesAccepted}
                onChange={(event) => setRulesVersionAccepted(event.target.checked ? user.onboarding.rulesVersion : null)} />
                <span>{t('onboarding.rulesConfirmation')}</span></label>
              <label className="checkbox-row activity-choice"><input type="checkbox" checked={shareSteamActivity}
                onChange={(event) => setShareSteamActivity(event.target.checked)} />
                <span>{t('onboarding.activityConsent')}<small>{t('onboarding.activityDescription')}</small></span></label>
              <p className="privacy-note">{t('onboarding.privacyNote')}</p>
              <button className="primary-button full-width" type="submit"
                disabled={!user.username || !ageConfirmed || !rulesAccepted || Boolean(operation)}>
                {t(operation === 'onboarding' ? 'onboarding.saving' : 'onboarding.continue')}
              </button>
            </form> : <div className="identity-complete">
              <p><span className="checkmark" aria-hidden="true">✓</span>{t('identity.communityReady')}</p>
              <p><span className="checkmark" aria-hidden="true">✓</span>{t('identity.contactsConsent')}</p>
              <p className="privacy-note">{t(user.privacy.shareSteamActivity ? 'identity.activityShared' : 'identity.activityPrivate')}</p>
              <button className="text-button" type="button" disabled={Boolean(operation)} onClick={() => { void logout(); }}>
                {t(operation === 'logout' ? 'auth.loggingOut' : 'auth.logout')}
              </button>
            </div>}
          </section>

          <section className="account-panel steam-panel">
            <div className="section-heading"><span className="step-label">{t('steam.step')}</span>
              <span className={`badge ${user.steam ? '' : 'badge-muted'}`}>{t(user.steam ? 'steam.verified' : 'steam.required')}</span></div>
            <h2>{t('steam.title')}</h2><p className="panel-description">{t('steam.description')}</p>
            {user.steam ? <div className="steam-linked">
              <div className="verified-icon" aria-hidden="true">✓</div><h3>{t('steam.linkedTitle')}</h3>
              <p>{t('steam.linkedDescription')}</p>
              <div className="steam-id"><span>{t('steam.accountId')}</span><code>{user.steam.steamId64}</code></div>
              <a className="secondary-button" href={`https://steamcommunity.com/profiles/${user.steam.steamId64}`}
                target="_blank" rel="noopener noreferrer"
                onClick={(event) => { if (openExternalLink(event.currentTarget.href)) event.preventDefault(); }}>{t('steam.viewProfile')}</a>
            </div> : <>
              <div className="steam-explainer"><Crosshair /><p>{t('steam.externalDescription')}</p></div>
              {onboardingRequired && <p className="privacy-note">{t('steam.completeOnboarding')}</p>}
              {pendingLink && link && <SteamLinkProgress link={link} busy={Boolean(operation)} onContinue={continueToSteam}
                onCheckStatus={() => setPollGeneration((generation) => generation + 1)} onNewLink={() => { void createSteamLink(); }} />}
              {link && !pendingLink && link.status !== 'COMPLETED' && <p className="link-terminal" role="alert">
                {link.status === 'FAILED' && link.failureCode ? errorText(link.failureCode) : t(`steam.status.${link.status}`)}
              </p>}
              {link?.status === 'COMPLETED' && !user.steam && <div className="link-progress" aria-live="polite">
                <p>{t('steam.status.COMPLETED')}</p>
                <button className="secondary-button" type="button" onClick={() => { void api.me().then((result) => setUser(result.user)).catch(handleError); }}>{t('steam.checkStatus')}</button>
              </div>}
              {!pendingLink && link?.status !== 'COMPLETED' && <button className="primary-button full-width" type="button"
                disabled={Boolean(onboardingRequired || operation)} onClick={() => { void createSteamLink(); }}>
                {t(operation === 'steam' ? 'steam.creatingLink' : link ? 'steam.newLink' : 'steam.connect')}
              </button>}
              <p className="privacy-note">{t('steam.passwordNote')}</p>
            </>}
          </section>
          {user.steam && !onboardingRequired && <StatsCard key={user.id} onAuthError={handleError} />}
          {user.steam && !onboardingRequired && <ProfileScreen key={`profile-${user.id}`} onAuthError={handleError}
            onPrivacyChanged={setUser} onDirtyChange={setProfileDirty} />}
          <AccountDeletionSection key={`delete-${user.id}`} onAuthError={handleError} onDeleted={() => {
              api.forgetSession(); setUser(null); setLink(null); setExpiresAt(null); setProfileDirty(false); setAuthError('ACCOUNT_DELETED');
            }} />
        </div>}
          {notice && <div className="error-notice" role="alert">{errorText(notice)}
            <button type="button" onClick={() => setNotice(null)} aria-label={t('app.dismiss')}>×</button></div>}
        </>}
        {user && pendingNavigation && <ConfirmationDialog title={t('requests.leaveTitle')} busy={false} confirmLabel={t('requests.leaveConfirm')} onCancel={() => setPendingNavigation(null)}
          onConfirm={() => { setProfileDirty(false); setScreen(pendingNavigation); setPendingNavigation(null); }}><p>{t('feed.leaveProfile')}</p></ConfirmationDialog>}
      </main>
      <footer><span>{t('app.footer')}</span><span>{t('app.edition')}</span></footer>
    </div>
  );
}
