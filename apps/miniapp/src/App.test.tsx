import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthErrorPanel } from './App.js';
import i18n from './i18n.js';
import ru from './locales/ru.json';
import en from './locales/en.json';

describe.each([['ru', ru], ['en', en]] as const)('authentication failure presentation in %s', (language, messages) => {
  it.each(['DEPENDENCIES_UNAVAILABLE', 'NETWORK_ERROR'] as const)('explains %s as temporary unavailability and offers retry', async (code) => {
    await i18n.changeLanguage(language);
    const html = renderToStaticMarkup(<AuthErrorPanel code={code} onRetry={() => undefined} />);
    expect(html).toContain(`<h2>${messages.auth.unavailableTitle}</h2>`);
    expect(html).toContain(`<p role="alert">${messages.errors[code]}</p>`);
    expect(html).toContain(messages.auth.retry);
    expect(html).not.toContain(messages.auth.errorTitle);
  });

  it('keeps the sign-in-again title for an expired session', async () => {
    await i18n.changeLanguage(language);
    const html = renderToStaticMarkup(<AuthErrorPanel code="SESSION_EXPIRED" onRetry={() => undefined} />);
    expect(html).toContain(`<h2>${messages.auth.errorTitle}</h2>`);
    expect(html).toContain(messages.errors.SESSION_EXPIRED);
    expect(html).toContain(messages.auth.retry);
  });

  it.each(['TELEGRAM_REQUIRED', 'ACCOUNT_DELETED'] as const)('preserves the dedicated %s state without a retry button', async (code) => {
    await i18n.changeLanguage(language);
    const html = renderToStaticMarkup(<AuthErrorPanel code={code} onRetry={() => undefined} />);
    const title = code === 'TELEGRAM_REQUIRED' ? messages.auth.telegramTitle : messages.profile.accountDeletedTitle;
    expect(html).toContain(`<h2>${title}</h2>`);
    expect(html).not.toContain('<button');
  });
});
