interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openLink(url: string, options?: { try_instant_view: boolean }): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp;
}

export function prepareTelegram(): void {
  const app = getTelegramWebApp();
  if (!app?.initData) return;
  app.ready();
  app.expand();
  app.setHeaderColor('#121715');
  app.setBackgroundColor('#121715');
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
