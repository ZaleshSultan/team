interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openLink(url: string): void;
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
