/** Telegram ThemeParams uses CSS hex colours. Ignore malformed/custom CSS values. */
export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  section_bg_color?: string;
  accent_text_color?: string;
  destructive_text_color?: string;
}

function hex(value: string | undefined, fallback: string): string {
  if (/^#[\da-f]{6}$/i.test(value ?? '')) return value!.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(value ?? '')) return `#${[...value!.slice(1)].map((digit) => digit + digit).join('')}`.toLowerCase();
  return fallback;
}

/** Use Telegram theme colours and matching light/dark fallbacks. */
export function createTheme(params: TelegramThemeParams = {}, scheme: 'light' | 'dark' = 'dark') {
  const light = scheme === 'light';
  return {
    '--background': hex(params.bg_color, light ? '#ffffff' : '#121715'),
    '--surface': hex(params.section_bg_color ?? params.secondary_bg_color, light ? '#f3f6f2' : '#19201b'),
    '--surface-raised': hex(params.secondary_bg_color, light ? '#e8eee5' : '#202721'),
    '--text': hex(params.text_color, light ? '#162019' : '#eef2eb'),
    '--muted': hex(params.hint_color, light ? '#667063' : '#939d93'),
    '--accent': hex(params.accent_text_color ?? params.link_color, light ? '#48671d' : '#c5f467'),
    '--accent-text': light ? '#ffffff' : '#17201b',
    '--button-background': hex(params.button_color, '#c5f467'),
    '--button-text': hex(params.button_text_color, '#17201b'),
    '--border': light ? '#cfd7cd' : '#4c534d',
    '--warning': light ? '#805618' : '#e8c99d',
    '--error': hex(params.destructive_text_color, light ? '#aa3026' : '#e8c0a7'),
  };
}
