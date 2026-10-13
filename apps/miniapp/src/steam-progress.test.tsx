import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from './i18n.js';
import { SteamLinkProgress } from './SteamLinkProgress.js';
import type { SteamLinkSnapshot } from './steam-polling.js';
import ru from './locales/ru.json';
import en from './locales/en.json';

afterEach(async () => { await i18n.changeLanguage('ru'); });

function render(status: SteamLinkSnapshot['status'], busy = false) {
  return renderToStaticMarkup(<SteamLinkProgress link={{ id: 'link-fixture', url: 'https://squad.example/start?code=fixture', expiresAt: '2026-10-13T12:10:00Z', status, failureCode: null }}
    busy={busy} onContinue={() => {}} onCheckStatus={() => {}} onNewLink={() => {}} />);
}

describe('Steam connection recovery and onboarding wording', () => {
  it('distinguishes authentication from age/rules completion in both languages', () => {
    expect(ru.identity.telegramVerified).toBe('Вход выполнен');
    expect(en.identity.telegramVerified).toBe('Signed in');
  });

  it('shows network guidance alongside Open Steam and offers a fresh pending attempt', () => {
    const html = render('PENDING');
    expect(html).toContain(ru.steam.openExternal);
    expect(html).toContain(ru.steam.connectionHint);
    expect(html).toContain(ru.steam.newLink);
    expect(html).toContain('target="_blank"');
  });

  it('lets a started attempt be replaced without reusing its consumed start URL', async () => {
    await i18n.changeLanguage('en');
    const html = render('STARTED');
    expect(html).toContain(en.steam.connectionHint);
    expect(html).toContain(en.steam.newLink);
    expect(html).toContain(en.steam.checkStatus);
    expect(html).not.toContain('href=');
  });

  it('prevents another fresh attempt while a replacement request is in flight', () => {
    expect(render('STARTED', true)).toContain('disabled=""');
    expect(render('STARTED', true)).toContain(ru.steam.creatingLink);
  });

  it('does not supersede verification already in progress', () => {
    expect(render('VERIFYING')).not.toContain(ru.steam.newLink);
    expect(render('VERIFYING')).not.toContain('href=');
  });
});
