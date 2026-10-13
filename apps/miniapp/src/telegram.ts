import { createTheme, type TelegramThemeParams } from './theme.js';

interface TelegramWebApp {
  initData: string;
  themeParams?: TelegramThemeParams;
  colorScheme?: 'light' | 'dark';
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openLink(url: string, options?: { try_instant_view: boolean }): void;
  onEvent?(event: 'themeChanged', callback: () => void): void;
  offEvent?(event: 'themeChanged', callback: () => void): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp;
}

export function prepareTelegram(): () => void {
  const app = getTelegramWebApp();
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  function updateTheme() {
    const scheme = app?.colorScheme ?? (media?.matches ? 'light' : 'dark');
    const theme = createTheme(app?.themeParams, scheme);
    for (const [name, value] of Object.entries(theme)) document.documentElement.style.setProperty(name, value);
    document.documentElement.style.colorScheme = scheme;
    if (app?.initData) {
      app.setHeaderColor(theme['--background']);
      app.setBackgroundColor(theme['--background']);
    }
  }
  updateTheme();
  app?.onEvent?.('themeChanged', updateTheme);
  if (!app) media?.addEventListener('change', updateTheme);
  if (app?.initData) {
    app.ready();
    app.expand();
  }
  return () => {
    app?.offEvent?.('themeChanged', updateTheme);
    if (!app) media?.removeEventListener('change', updateTheme);
  };
}

/** Call synchronously from a click; Telegram requires a fresh user gesture. */
export function openExternalLink(url: string): boolean {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:') return false;
    const app = getTelegramWebApp();
    if (app?.openLink) {
      app.openLink(target.href, { try_instant_view: false });
      return true;
    }
  } catch {
    // The visible target=_blank link remains available as a fallback.
  }
  return false;
}
