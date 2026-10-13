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

function channels(colour: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(colour.slice(offset, offset + 2), 16));
}

function luminance(colour: string): number {
  const [r = 0, g = 0, b = 0] = channels(colour).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG relative-luminance contrast ratio for opaque six-digit hex colours. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function mix(from: string, to: string, amount: number): string {
  const target = channels(to);
  return `#${channels(from).map((channel, index) => Math.round(channel + ((target[index] ?? 0) - channel) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function readable(preferred: string, backgrounds: string[], endpoint: string): string {
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mix(preferred, endpoint, step / 100);
    if (backgrounds.every((background) => contrastRatio(candidate, background) >= 4.5)) return candidate;
  }
  return endpoint;
}

function accessibleSurface(preferred: string, background: string, foreground: string): string {
  // A custom Telegram theme may give its panels opposite luminance to the page.
  // Keep each surface within the same readable range before deriving text tokens.
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mix(preferred, background, step / 100);
    if (contrastRatio(foreground, candidate) >= 4.5) return candidate;
  }
  return background;
}

export function createTheme(params: TelegramThemeParams = {}, scheme: 'light' | 'dark' = 'dark') {
  const light = scheme === 'light';
  const background = hex(params.bg_color, light ? '#ffffff' : '#121715');
  const endpoint = contrastRatio('#000000', background) >= contrastRatio('#ffffff', background) ? '#000000' : '#ffffff';
  const surface = accessibleSurface(hex(params.section_bg_color ?? params.secondary_bg_color, light ? '#f3f6f2' : '#19201b'), background, endpoint);
  const raised = accessibleSurface(hex(params.secondary_bg_color, light ? '#e8eee5' : '#202721'), background, endpoint);
  const backgrounds = [background, surface, raised];
  const text = readable(hex(params.text_color, light ? '#162019' : '#eef2eb'), backgrounds, endpoint);
  const muted = readable(hex(params.hint_color, light ? '#525e51' : '#afb7ad'), backgrounds, endpoint);
  const accent = readable(hex(params.accent_text_color ?? params.link_color, light ? '#48671d' : '#c5f467'), backgrounds, endpoint);
  const accentEndpoint = contrastRatio('#000000', accent) >= contrastRatio('#ffffff', accent) ? '#000000' : '#ffffff';
  const buttonBackground = hex(params.button_color, '#c5f467');
  const buttonEndpoint = contrastRatio('#000000', buttonBackground) >= contrastRatio('#ffffff', buttonBackground) ? '#000000' : '#ffffff';
  return {
    '--background': background,
    '--surface': surface,
    '--surface-raised': raised,
    '--text': text,
    '--muted': muted,
    '--accent': accent,
    '--accent-text': readable('#17201b', [accent], accentEndpoint),
    '--button-background': buttonBackground,
    '--button-text': readable(hex(params.button_text_color, '#17201b'), [buttonBackground], buttonEndpoint),
    '--border': mix(surface, text, 0.24),
    '--warning': readable(light ? '#805618' : '#e8c99d', backgrounds, endpoint),
    '--error': readable(hex(params.destructive_text_color, light ? '#aa3026' : '#e8c0a7'), backgrounds, endpoint),
  };
}
