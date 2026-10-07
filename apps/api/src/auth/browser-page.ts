import ru from '../locales/ru.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };

type PageKind = 'success' | 'invalid' | 'expired' | 'cancelled' | 'unavailable' | 'conflict';
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
export function renderSteamPage(kind: PageKind, language: string, botUsername: string): string {
  const locale = language === 'en' ? 'en' : 'ru';
  const copy = locale === 'en' ? en : ru;
  const page = copy.steam[kind];
  const href = `https://t.me/${encodeURIComponent(botUsername)}?start=steam_linked`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.title)}</title><style>body{margin:0;background:#121715;color:#e9efe6;font:16px/1.6 system-ui;min-height:100vh;display:grid;place-items:center}main{max-width:480px;padding:32px}h1{font-size:32px;line-height:1.15}a{display:inline-block;background:#c1f36b;color:#18210e;border-radius:12px;padding:12px 20px;text-decoration:none;font-weight:700}small{display:block;margin-top:24px;color:#a9b5a5}</style></head><body><main><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.description)}</p><a href="${escapeHtml(href)}">${escapeHtml(copy.steam.return)}</a><small>${escapeHtml(copy.steam.privacy)}</small></main></body></html>`;
}
