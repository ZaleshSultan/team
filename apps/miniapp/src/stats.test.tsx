import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { faceitLinkInputSchema, statsResponseSchema } from '@squad/shared';
import i18n from './i18n.js';
import ru from './locales/ru.json';
import en from './locales/en.json';
import { StatsView } from './StatsCard.js';
import { cooldownSeconds, formatPlaytime, pollCachedStats, providerUnavailable } from './stats.js';
import { statsFixture } from './stats-fixture.js';

beforeEach(async () => { await i18n.changeLanguage('ru'); });

describe('cached stats presentation and contract', () => {
  it('converts provider minutes to localized hours without inventing a zero for hidden data', () => {
    expect(formatPlaytime(150, 'en')).toBe('2.5');
    expect(formatPlaytime(150, 'ru')).toBe('2,5');
    expect(formatPlaytime(0, 'ru')).toBe('0');
    expect(formatPlaytime(null, 'ru')).toBeNull();
    expect(formatPlaytime(undefined, 'en')).toBeNull();
  });

  it('uses the server cooldown boundary and permits refresh exactly at expiry', () => {
    const boundary = '2026-10-12T12:05:00.000Z';
    expect(cooldownSeconds(boundary, Date.parse(boundary) - 250)).toBe(1);
    expect(cooldownSeconds(boundary, Date.parse(boundary))).toBe(0);
    expect(cooldownSeconds(boundary, Date.parse(boundary) + 5000)).toBe(0);
    expect(cooldownSeconds(null)).toBe(0);
  });

  it('keeps cached numbers visible when a provider fails or its key is missing', () => {
    const stats = { ...statsFixture, availability: { steam: false, faceit: true }, sync: { ...statsFixture.sync, status: 'FAILED' as const, lastErrorCode: 'FACEIT_UNAVAILABLE' } };
    expect(providerUnavailable(stats, 'steam')).toBe(true);
    expect(providerUnavailable(stats, 'faceit')).toBe(true);
    const html = renderToStaticMarkup(<StatsView stats={stats} />);
    expect(html).toContain('123,3 ч');
    expect(html).toContain('1800');
    expect(html).toContain(ru.stats.steamUnavailable);
    expect(html).toContain(ru.stats.faceitUnavailable);
  });

  it('shows private profile guidance and unavailable time instead of fabricated zero hours', () => {
    const stats = { ...statsFixture, steam: { ...statsFixture.steam!, profileVisibility: 1, gameDetailsPublic: false, cs2: null, games: [] }, guidance: ['STEAM_PROFILE_PRIVATE' as const] };
    const html = renderToStaticMarkup(<StatsView stats={stats} />);
    expect(html).toContain(ru.stats.guidance.STEAM_PROFILE_PRIVATE);
    expect(html).toContain(ru.stats.unknown);
    expect(html).not.toContain('0 ч');
  });

  it('renders English and never gives an unmatched FACEIT account a verified badge', async () => {
    await i18n.changeLanguage('en');
    const stats = { ...statsFixture, faceit: { ...statsFixture.faceit!, verified: false } };
    const html = renderToStaticMarkup(<StatsView stats={stats} />);
    expect(html).toContain('123.3 h');
    expect(html).toContain(en.stats.faceitNotLinked);
    expect(html).not.toContain(en.stats.faceitVerified);
    expect(html).not.toContain('TestPlayer');
  });

  it('has matching translation keys in both languages, including every guidance and sync state', () => {
    function keys(value: Record<string, unknown>, prefix = ''): string[] {
      return Object.entries(value).flatMap(([key, item]) => typeof item === 'object' && item !== null ? keys(item as Record<string, unknown>, `${prefix}${key}.`) : `${prefix}${key}`);
    }
    expect(keys(ru).sort()).toEqual(keys(en).sort());
    for (const status of ['IDLE', 'QUEUED', 'RUNNING', 'FAILED']) expect(i18n.exists(`stats.status.${status}`)).toBe(true);
  });

  it('rejects malformed cached numbers and trims nickname input without accepting unknown fields', () => {
    expect(statsResponseSchema.safeParse(statsFixture).success).toBe(true);
    expect(statsResponseSchema.safeParse({ ...statsFixture, steam: { ...statsFixture.steam, cs2: { playtimeTotal: -1, playtime2weeks: 2 } } }).success).toBe(false);
    expect(faceitLinkInputSchema.parse({ nickname: ' test ' })).toEqual({ nickname: 'test' });
    expect(faceitLinkInputSchema.safeParse({ nickname: ' ' }).success).toBe(false);
    expect(faceitLinkInputSchema.safeParse({ nickname: 'test', steamId: 'untrusted-id' }).success).toBe(false);
  });
});

describe('cached status polling', () => {
  it('reads once for idle caches and never schedules a refresh', async () => {
    const read = vi.fn().mockResolvedValue(statsFixture);
    const onStats = vi.fn();
    const onError = vi.fn();
    await pollCachedStats({ signal: new AbortController().signal, read, onStats, onError });
    expect(read).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledWith(statsFixture);
    expect(onError).not.toHaveBeenCalled();
  });

  it('polls queued and running caches until completion, then stops', async () => {
    vi.useFakeTimers();
    try {
      const queued = { ...statsFixture, sync: { ...statsFixture.sync, status: 'QUEUED' as const } };
      const running = { ...statsFixture, sync: { ...statsFixture.sync, status: 'RUNNING' as const } };
      const read = vi.fn().mockResolvedValueOnce(queued).mockResolvedValueOnce(running).mockResolvedValueOnce(statsFixture);
      const onStats = vi.fn();
      const polling = pollCachedStats({ signal: new AbortController().signal, read, onStats, onError: vi.fn() });
      await vi.advanceTimersByTimeAsync(6000);
      await polling;
      expect(read).toHaveBeenCalledTimes(3);
      expect(onStats).toHaveBeenLastCalledWith(statsFixture);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('cancels pending timers and ignores an in-flight response after unmount or logout', async () => {
    const controller = new AbortController();
    let finish!: (value: typeof statsFixture) => void;
    const read = vi.fn().mockReturnValue(new Promise<typeof statsFixture>((resolve) => { finish = resolve; }));
    const onStats = vi.fn();
    const onError = vi.fn();
    const polling = pollCachedStats({ signal: controller.signal, read, onStats, onError });
    controller.abort();
    finish(statsFixture);
    await polling;
    expect(onStats).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops and surfaces an error without retrying forever', async () => {
    const failure = new Error('safe-error');
    const read = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();
    await pollCachedStats({ signal: new AbortController().signal, read, onStats: vi.fn(), onError });
    expect(read).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('bounds a stuck queued or running status and lets the UI offer a new status check', async () => {
    vi.useFakeTimers();
    try {
      const running = { ...statsFixture, sync: { ...statsFixture.sync, status: 'RUNNING' as const } };
      const read = vi.fn().mockResolvedValue(running);
      const onError = vi.fn();
      const polling = pollCachedStats({ signal: new AbortController().signal, read, onStats: vi.fn(), onError, maxDurationMs: 1000, intervalMs: 250 });
      await vi.advanceTimersByTimeAsync(1000);
      await polling;
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'STATS_STATUS_TIMEOUT' }));
      const calls = read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(calls);
    } finally { vi.useRealTimers(); }
  });

  it('cleans up the next poll timer immediately on unmount', async () => {
    vi.useFakeTimers();
    try {
      const queued = { ...statsFixture, sync: { ...statsFixture.sync, status: 'QUEUED' as const } };
      const controller = new AbortController();
      const read = vi.fn().mockResolvedValue(queued);
      const polling = pollCachedStats({ signal: controller.signal, read, onStats: vi.fn(), onError: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
      controller.abort();
      await polling;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
