import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getTelegramWebApp, prepareTelegram } from './telegram.js';

function Crosshair({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2v5m0 10v5M2 12h5m10 0h5" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function App() {
  const { t, i18n } = useTranslation();
  const isTelegram = Boolean(getTelegramWebApp()?.initData);

  useEffect(() => prepareTelegram(), []);
  useEffect(() => {
    document.title = t('app.title');
    document.documentElement.lang = i18n.resolvedLanguage ?? 'ru';
  }, [i18n.resolvedLanguage, t]);

  function changeLanguage(language: 'ru' | 'en') {
    try {
      localStorage.setItem('squad.language', language);
    } catch {
      // The language switch still works when WebView storage is unavailable.
    }
    void i18n.changeLanguage(language);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label={t('app.name')}>
          <span className="brand-symbol"><Crosshair /></span>
          <span>{t('app.name')}<span className="brand-dot">.</span></span>
        </a>
        <div className="language-toggle" role="group" aria-label={t('app.language')}>
          {(['ru', 'en'] as const).map((language) => (
            <button key={language} type="button" aria-pressed={i18n.resolvedLanguage === language}
              onClick={() => changeLanguage(language)}>
              {t(language === 'ru' ? 'app.russian' : 'app.english')}
            </button>
          ))}
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="game-tag"><span className="live-dot" />{t('app.game')}</div>
          <p className="eyebrow">{t('home.eyebrow')}</p>
          <h1>{t('home.headline')}<br /><span>{t('home.headlineAccent')}</span></h1>
          <p className="hero-description">{t('home.description')}</p>
          <div className="connection-note">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 17-7-3 17-5-5-3 3v-5l8-7-10 6z" /></svg>
            <div><strong>{t(isTelegram ? 'home.telegramDetected' : 'home.telegramNotice')}</strong>
              <p>{t('home.authPending')}</p></div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-grid" />
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <Crosshair className="art-crosshair" />
            <span className="art-coordinate coordinate-one">+</span>
            <span className="art-coordinate coordinate-two">+</span>
          </div>
        </section>

        <section className="features">
          {(['Identity', 'Match', 'Connection'] as const).map((feature, index) => (
            <article className="feature" key={feature}>
              <span className="feature-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <h2>{t(`home.feature${feature}`)}</h2>
              <p>{t(`home.feature${feature}Detail`)}</p>
            </article>
          ))}
        </section>

        <section className="roadmap">
          <div className="roadmap-heading">
            <p className="eyebrow">{t('roadmap.label')}</p>
            <h2>{t('roadmap.title')}</h2>
            <p>{t('roadmap.description')}</p>
          </div>
          <ol className="milestones">
            {(['foundation', 'identity', 'discovery'] as const).map((milestone, index) => (
              <li key={milestone} className={index === 0 ? 'active' : ''}>
                <span className="milestone-marker" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <div className="milestone-copy"><h3>{t(`roadmap.${milestone}`)}</h3><p>{t(`roadmap.${milestone}Detail`)}</p></div>
                <span className="milestone-status">{t(`roadmap.${milestone}Status`)}</span>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer><span>{t('app.footer')}</span><span>{t('app.development')}</span></footer>
    </div>
  );
}
