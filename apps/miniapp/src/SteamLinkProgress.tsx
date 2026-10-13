import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { SteamLinkSnapshot } from './steam-polling.js';

export function SteamLinkProgress({ link, busy, onContinue, onCheckStatus, onNewLink }: {
  link: SteamLinkSnapshot & { url: string };
  busy: boolean;
  onContinue: (event: MouseEvent<HTMLAnchorElement>) => void;
  onCheckStatus: () => void;
  onNewLink: () => void;
}) {
  const { t } = useTranslation();
  return <div className="link-progress" aria-live="polite">
    <h3>{t(`steam.status.${link.status}`)}</h3><p>{t('steam.returnInstructions')}</p>
    <p className="steam-connection-hint">{t('steam.connectionHint')}</p>
    {link.status === 'PENDING' && <>
      <a className="primary-button full-width" href={link.url} target="_blank" rel="noopener noreferrer" onClick={onContinue}>
        {t('steam.openExternal')}
      </a>
      <a className="fallback-link" href={link.url} target="_blank" rel="noopener noreferrer">{t('steam.browserFallback')}</a>
    </>}
    <button className="text-button" type="button" onClick={onCheckStatus}>{t('steam.checkStatus')}</button>
    {(link.status === 'PENDING' || link.status === 'STARTED') && <button className="secondary-button" type="button" disabled={busy} onClick={onNewLink}>
      {t(busy ? 'steam.creatingLink' : 'steam.newLink')}
    </button>}
  </div>;
}
