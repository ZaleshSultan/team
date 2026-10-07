import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternalLink } from './telegram.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('Steam external-browser handoff', () => {
  it('uses the Telegram external browser method with Instant View disabled', () => {
    const openLink = vi.fn();
    vi.stubGlobal('window', { Telegram: { WebApp: { openLink } } });
    expect(openExternalLink('https://squad.example/api/auth/steam/start?code=one-time-code')).toBe(true);
    expect(openLink).toHaveBeenCalledWith('https://squad.example/api/auth/steam/start?code=one-time-code', { try_instant_view: false });
  });

  it('leaves the visible browser link usable if the Telegram method fails', () => {
    vi.stubGlobal('window', { Telegram: { WebApp: { openLink: () => { throw new Error('not supported'); } } } });
    expect(openExternalLink('https://squad.example/api/auth/steam/start?code=one-time-code')).toBe(false);
  });

  it('rejects insecure handoff URLs', () => {
    const openLink = vi.fn();
    vi.stubGlobal('window', { Telegram: { WebApp: { openLink } } });
    expect(openExternalLink('http://squad.example/api/auth/steam/start?code=one-time-code')).toBe(false);
    expect(openLink).not.toHaveBeenCalled();
  });
});
