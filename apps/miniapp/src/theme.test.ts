import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTheme, contrastRatio, type TelegramThemeParams } from './theme.js';
import { prepareTelegram } from './telegram.js';

afterEach(() => { vi.unstubAllGlobals(); });

// Independent WCAG oracle: catch regression in the palette as well as its helper.
function wcagContrast(a: string, b: string) {
  const light = (colour: string) => {
    const rgb = colour.slice(1).match(/../g)!.map((channel) => Number.parseInt(channel, 16) / 255);
    const linear = rgb.map((value) => value < 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    return linear.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  };
  const values = [light(a), light(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function assertReadable(theme: ReturnType<typeof createTheme>) {
  for (const foreground of ['--text', '--muted', '--accent', '--warning', '--error'] as const) {
    for (const background of ['--background', '--surface', '--surface-raised'] as const) {
      expect(wcagContrast(theme[foreground], theme[background]), `${foreground} ${theme[foreground]} on ${background} ${theme[background]}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(wcagContrast(theme['--button-text'], theme['--button-background'])).toBeGreaterThanOrEqual(4.5);
  expect(wcagContrast(theme['--accent-text'], theme['--accent'])).toBeGreaterThanOrEqual(4.5);
}

describe('accessible Telegram themes', () => {
  it('matches known WCAG relative luminance ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#777777')).toBeCloseTo(4.478, 3);
    expect(contrastRatio('#121715', '#121715')).toBe(1);
  });

  it.each(['light', 'dark'] as const)('keeps all default %s text and muted text at WCAG AA', (scheme) => {
    assertReadable(createTheme({}, scheme));
  });

  it.each([
    { bg_color: '#ffffff', text_color: '#000000', hint_color: '#999999', secondary_bg_color: '#f1f1f1', button_color: '#2481cc', button_text_color: '#ffffff' },
    { bg_color: '#17212b', text_color: '#f5f5f5', hint_color: '#708499', secondary_bg_color: '#232e3c', button_color: '#5288c1', button_text_color: '#ffffff' },
    { bg_color: '#777777', text_color: '#888888', hint_color: '#777777', section_bg_color: '#ffffff', secondary_bg_color: '#000000', button_color: '#777777' },
    { bg_color: '#fff', text_color: '#fff', hint_color: '#eee', secondary_bg_color: '#000', button_color: '#fff', button_text_color: '#fff' },
  ])('repairs insufficient contrast in common and mixed custom themes: $bg_color', (params) => {
    const theme = createTheme(params);
    expect(theme['--background']).toBe(params.bg_color === '#fff' ? '#ffffff' : params.bg_color);
    assertReadable(theme);
  });

  it('preserves valid theme choices and ignores malformed CSS values', () => {
    const theme = createTheme({ bg_color: '#ffffff', text_color: '#222222', hint_color: '#444444', secondary_bg_color: '#eeeeee', section_bg_color: '#f8f8f8', button_color: 'url(secret)', link_color: 'var(--invalid)' }, 'light');
    expect(theme['--text']).toBe('#222222');
    expect(theme['--muted']).toBe('#444444');
    expect(theme['--surface']).toBe('#f8f8f8');
    expect(theme['--surface-raised']).toBe('#eeeeee');
    expect(theme['--button-background']).toBe('#c5f467');
    assertReadable(theme);
  });

  it('maintains AA across 256 deterministic arbitrary Telegram palettes', () => {
    let seed = 937;
    const randomColour = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return `#${(seed & 0xffffff).toString(16).padStart(6, '0')}`;
    };
    for (let index = 0; index < 256; index += 1) {
      const params: TelegramThemeParams = {
        bg_color: randomColour(), text_color: randomColour(), hint_color: randomColour(),
        section_bg_color: randomColour(), secondary_bg_color: randomColour(),
        link_color: randomColour(), button_color: randomColour(), button_text_color: randomColour(),
        destructive_text_color: randomColour(),
      };
      assertReadable(createTheme(params, index % 2 ? 'light' : 'dark'));
    }
  });

  it('updates CSS and native Telegram chrome on themeChanged and unregisters on cleanup', () => {
    const rootStyle = { setProperty: vi.fn(), colorScheme: '' };
    const app = {
      initData: 'fixture', themeParams: { bg_color: '#ffffff' }, colorScheme: 'light' as 'light' | 'dark',
      ready: vi.fn(), expand: vi.fn(), setHeaderColor: vi.fn(), setBackgroundColor: vi.fn(),
      onEvent: vi.fn(), offEvent: vi.fn(),
    };
    vi.stubGlobal('document', { documentElement: { style: rootStyle } });
    vi.stubGlobal('window', { Telegram: { WebApp: app } });
    const cleanup = prepareTelegram();
    expect(app.ready).toHaveBeenCalledOnce();
    expect(rootStyle.setProperty).toHaveBeenCalledWith('--background', '#ffffff');
    expect(app.setHeaderColor).toHaveBeenLastCalledWith('#ffffff');
    const update = app.onEvent.mock.calls[0]![1] as () => void;
    app.themeParams.bg_color = '#17212b';
    app.colorScheme = 'dark';
    update();
    expect(rootStyle.colorScheme).toBe('dark');
    expect(rootStyle.setProperty).toHaveBeenCalledWith('--background', '#17212b');
    expect(app.setBackgroundColor).toHaveBeenLastCalledWith('#17212b');
    cleanup();
    expect(app.offEvent).toHaveBeenCalledWith('themeChanged', update);
  });

  it('follows the browser scheme outside Telegram without accessing auth', () => {
    const style = { setProperty: vi.fn(), colorScheme: '' };
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('document', { documentElement: { style } });
    vi.stubGlobal('window', { matchMedia: vi.fn(() => media) });
    const cleanup = prepareTelegram();
    expect(style.colorScheme).toBe('light');
    expect(style.setProperty).toHaveBeenCalledWith('--background', '#ffffff');
    cleanup();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', media.addEventListener.mock.calls[0]![1]);
  });
});
