import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedFilterSheet, FeedFilterSummary, FeedPlayerCard, FeedResults, FeedSkeleton } from './FeedScreen.js';
import { activeFeedFilterCount, applyFeedPage, canLeaveProfile, defaultFeedFilters, FEED_FILTER_STORAGE_KEY, feedSearchParams, isPullToRefresh, readFeedFilters, rememberFeedFilters, toggleFeedChoice, validateSavedFeedFilters } from './feed.js';
import { profileOptionsFixture, publicProfileFixture } from './profile-fixture.js';
import i18n from './i18n.js';
import ru from './locales/ru.json';
import en from './locales/en.json';

beforeEach(async () => { await i18n.changeLanguage('ru'); });

describe('feed filters and persistence', () => {
  it('uses the default ban filter and page size without accidental extra filters', () => {
    expect(defaultFeedFilters()).toEqual({ roles: [], languages: [], regions: [], lookingFor: [], playTimes: [], verifiedOnly: false, noBans: true });
    expect(feedSearchParams(defaultFeedFilters()).toString()).toBe('limit=20&noBans=true');
    expect(activeFeedFilterCount(defaultFeedFilters())).toBe(0);
  });

  it('maps all filter groups to repeated query parameters, keeps false microphone, and carries opaque cursors', () => {
    const filters = { ...defaultFeedFilters(), roles: ['awp', 'support'], languages: ['ru', 'kk'], regions: ['KZ', 'CIS'], lookingFor: ['duo', 'team'], playTimes: ['evening', 'night'], faceitLevelMin: 3, faceitLevelMax: 8, hasMic: false, verifiedOnly: true, noBans: false };
    const query = feedSearchParams(filters, 'opaque_cursor-safe');
    for (const field of ['roles', 'languages', 'regions', 'lookingFor', 'playTimes'] as const) expect(query.getAll(field)).toEqual(filters[field]);
    expect(Object.fromEntries(query)).toMatchObject({ faceitLevelMin: '3', faceitLevelMax: '8', hasMic: 'false', verifiedOnly: 'true', noBans: 'false', cursor: 'opaque_cursor-safe', limit: '20' });
    expect(activeFeedFilterCount(filters)).toBe(15);
  });

  it('leaves each chip group unrestricted and removes a selected chip', () => {
    expect(toggleFeedChoice(['awp'], 'support')).toEqual(['awp', 'support']);
    expect(toggleFeedChoice(['awp', 'support'], 'awp')).toEqual(['support']);
    expect(toggleFeedChoice(['entry', 'awp', 'support'], 'igl')).toEqual(['entry', 'awp', 'support', 'igl']);
  });

  it('reads only safe current provider values and drops duplicates', () => {
    const filters = { ...defaultFeedFilters(), roles: ['awp', 'awp'], regions: ['KZ'], hasMic: false };
    const storage = { getItem: vi.fn().mockReturnValue(JSON.stringify(filters)) };
    expect(readFeedFilters(profileOptionsFixture, storage)).toEqual({ ...filters, roles: ['awp'] });
    expect(storage.getItem).toHaveBeenCalledWith(FEED_FILTER_STORAGE_KEY);
    expect(validateSavedFeedFilters({ ...filters, roles: ['invented'] }, profileOptionsFixture)).toBeNull();
    expect(validateSavedFeedFilters({ ...filters, languages: ['xx'] }, profileOptionsFixture)).toBeNull();
  });

  it.each([
    null, [], { unknown: true }, { hasMic: 'false' }, { noBans: 'true' }, { roles: 'awp' },
    { faceitLevelMin: 0 }, { faceitLevelMax: 11 }, { faceitLevelMin: 9, faceitLevelMax: 2 },
    { regions: ['UNKNOWN'] }, { lookingFor: ['friends'] }, { playTimes: ['flexible'] },
  ])('rejects malformed or obsolete stored filters: %j', (saved) => {
    expect(readFeedFilters(profileOptionsFixture, { getItem: () => JSON.stringify(saved) })).toEqual(defaultFeedFilters());
  });

  it('works without localStorage and does not persist identity or sessions', () => {
    expect(readFeedFilters(profileOptionsFixture, { getItem() { throw new Error('blocked'); } })).toEqual(defaultFeedFilters());
    expect(readFeedFilters(profileOptionsFixture, { getItem: () => '{broken' })).toEqual(defaultFeedFilters());
    expect(() => rememberFeedFilters(defaultFeedFilters(), { setItem() { throw new Error('blocked'); } })).not.toThrow();
    const storage = { setItem: vi.fn() };
    rememberFeedFilters({ ...defaultFeedFilters(), hasMic: true }, storage);
    expect(storage.setItem).toHaveBeenCalledWith(FEED_FILTER_STORAGE_KEY, JSON.stringify({ ...defaultFeedFilters(), hasMic: true }));
    for (const key of ['token', 'telegramId', 'userId']) expect(storage.setItem.mock.calls[0]![1]).not.toContain(key);
  });

  it('shows provider chips, three microphone states and an invalid level range', () => {
    const html = renderToStaticMarkup(<FeedFilterSheet filters={{ ...defaultFeedFilters(), roles: ['awp'], faceitLevelMin: 8, faceitLevelMax: 2, hasMic: false }} options={profileOptionsFixture} onApply={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain('role="dialog"'); expect(html).toContain('aria-modal="true"');
    expect(html).toContain(ru.feed.invalidRange); expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('type="submit" disabled=""');
    for (const label of Object.values(ru.feed.mic)) expect(html).toContain(label);
    for (const label of Object.values(ru.profile.options.roles)) expect(html).toContain(label);
    expect(html).toContain(ru.feed.filterSemantics);
  });

  it('summarizes filters and the default safety choice, offering reset only for changes', () => {
    const normal = renderToStaticMarkup(<FeedFilterSummary filters={defaultFeedFilters()} onReset={() => undefined} />);
    expect(normal).toContain(ru.feed.noBans); expect(normal).not.toContain('<button');
    const active = renderToStaticMarkup(<FeedFilterSummary filters={{ ...defaultFeedFilters(), roles: ['awp'], faceitLevelMin: 4, hasMic: true, verifiedOnly: true, noBans: false }} onReset={() => undefined} />);
    for (const text of ['AWP', 'FACEIT 4–10', ru.feed.micYes, ru.feed.verifiedOnly, ru.feed.includeBans, ru.feed.reset]) expect(active).toContain(text);
  });
});

describe('feed pagination, refresh and navigation', () => {
  const second = { ...publicProfileFixture, id: 'aeadbc28-9acc-43f6-bf5d-e6178c0ba33d', nickname: 'Second' };
  it('appends pages, advances the cursor and tolerates duplicate cards without duplicate React keys', () => {
    const first = applyFeedPage({ items: [], nextCursor: null }, { items: [publicProfileFixture], nextCursor: 'page2' }, false);
    expect(first.nextCursor).toBe('page2');
    const next = applyFeedPage(first, { items: [publicProfileFixture, second], nextCursor: null }, true);
    expect(next.items.map((card) => card.id)).toEqual([publicProfileFixture.id, second.id]);
    expect(next.nextCursor).toBeNull();
  });
  it('refresh and filter changes replace stale cards rather than leaving banned or unpublished entries', () => {
    const old = { items: [publicProfileFixture], nextCursor: 'old' };
    expect(applyFeedPage(old, { items: [second], nextCursor: 'fresh' }, false)).toEqual({ items: [second], nextCursor: 'fresh' });
    expect(applyFeedPage(old, { items: [], nextCursor: null }, false)).toEqual({ items: [], nextCursor: null });
  });
  it('requires a downward gesture at page top, ignoring short and horizontal swipes', () => {
    expect(isPullToRefresh(null, { x: 0, y: 100 })).toBe(false);
    expect(isPullToRefresh({ x: 0, y: 20 }, { x: 20, y: 95 })).toBe(true);
    expect(isPullToRefresh({ x: 0, y: 20 }, { x: 0, y: 94 })).toBe(false);
    expect(isPullToRefresh({ x: 0, y: 20 }, { x: 51, y: 100 })).toBe(false);
    expect(isPullToRefresh({ x: 0, y: 100 }, { x: 0, y: 0 })).toBe(false);
  });
  it('preserves the profile dirty guard when navigating to the feed', () => {
    const cancel = vi.fn().mockReturnValue(false);
    expect(canLeaveProfile(false, cancel)).toBe(true); expect(cancel).not.toHaveBeenCalled();
    expect(canLeaveProfile(true, cancel)).toBe(false); expect(cancel).toHaveBeenCalledOnce();
    expect(canLeaveProfile(true, () => true)).toBe(true);
  });
});

describe('feed result states and public cards', () => {
  const props = { page: { items: [], nextCursor: null }, pending: null, error: null, requirements: [], hasFilters: false, onRetry() {}, onReset() {}, onProfile() {}, onMore() {} };
  it('explains missing requirements and provides a profile navigation action', () => {
    const html = renderToStaticMarkup(<FeedResults {...props} error="FEED_REQUIREMENTS_MISSING" requirements={[{ code: 'ONBOARDING_INCOMPLETE' }, { code: 'STEAM_REQUIRED' }, { code: 'PUBLISHED_PROFILE_REQUIRED' }]} />);
    for (const label of Object.values(ru.feed.requirements)) expect(html).toContain(label);
    expect(html).toContain(ru.feed.completeProfile); expect(html).not.toContain(ru.feed.emptyTitle);
  });
  it('suggests resetting filters for empty search and explains no-profile results separately', () => {
    const filtered = renderToStaticMarkup(<FeedResults {...props} hasFilters />);
    expect(filtered).toContain(ru.feed.emptyFiltered); expect(filtered).toContain(ru.feed.reset);
    const normal = renderToStaticMarkup(<FeedResults {...props} />);
    expect(normal).toContain(ru.feed.emptyDefault); expect(normal).not.toContain(ru.feed.reset);
  });
  it('shows accessible skeletons without flashing the empty state', () => {
    const html = renderToStaticMarkup(<FeedResults {...props} pending="initial" />);
    expect(html).toContain('aria-busy="true"'); expect(html).toContain(ru.feed.loading); expect(html).not.toContain(ru.feed.emptyTitle);
    expect(renderToStaticMarkup(<FeedSkeleton />)).toContain('aria-hidden="true"');
  });
  it('provides retry and keeps already-loaded cards after load-more failure', () => {
    const html = renderToStaticMarkup(<FeedResults {...props} page={{ items: [publicProfileFixture], nextCursor: 'next' }} error="NETWORK_ERROR" hasFilters />);
    expect(html).toContain(ru.errors.NETWORK_ERROR); expect(html).toContain(ru.auth.retry); expect(html).toContain(ru.feed.reset);
    expect(html).toContain(publicProfileFixture.nickname!); expect(html).not.toContain(ru.feed.loadMore);
  });
  it('shows load-more only while a next cursor exists and disables it during the request', () => {
    const html = renderToStaticMarkup(<FeedResults {...props} page={{ items: [publicProfileFixture], nextCursor: 'next' }} />);
    expect(html).toContain(ru.feed.loadMore); expect(html).not.toContain(ru.feed.end);
    const loading = renderToStaticMarkup(<FeedResults {...props} pending="more" page={{ items: [publicProfileFixture], nextCursor: 'next' }} />);
    expect(loading).toContain(ru.feed.loadingMore); expect(loading).toContain('disabled=""');
    const end = renderToStaticMarkup(<FeedResults {...props} page={{ items: [publicProfileFixture], nextCursor: null }} />);
    expect(end).toContain(ru.feed.end); expect(end).not.toContain(ru.feed.loadMore);
  });
  it('renders only public player details, no card actions, and hides unshared playtime', () => {
    const html = renderToStaticMarkup(<FeedPlayerCard card={publicProfileFixture} />);
    for (const text of [publicProfileFixture.nickname!, ru.profile.steamVerified, ru.profile.faceitVerified, ru.profile.options.regions.KZ, ru.feed.micYes, 'AWP', '1800 ELO']) expect(html).toContain(text);
    for (const label of [ru.feed.cardRoles, ru.feed.cardPlayTimes, ru.feed.cardLookingFor]) expect(html).toContain(label);
    for (const viewerLabel of [ru.profile.roles, ru.profile.playTimes, ru.profile.lookingFor]) expect(html).not.toContain(viewerLabel);
    expect(html).not.toContain('<button'); expect(html).not.toContain('<a '); expect(html).not.toContain(ru.stats.cs2Total);
    for (const privateName of ['telegramId', 'username', 'steamId', 'userId', 'playtimeTotal', 'userGames']) expect(html).not.toContain(privateName);
  });
  it('shows ban warnings and public-only activity, escaping biography text', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(<FeedPlayerCard card={{ ...publicProfileFixture, nickname: null, hasBans: true, bio: '<script>unsafe</script>', activity: { cs2Hours: 123.5, cs2Hours2weeks: null } }} />);
    for (const text of [en.profile.unnamed, en.feed.banWarning, en.stats.cs2Total, '123.5 h', en.stats.unknown]) expect(html).toContain(text);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  });
  it('keeps RU/EN key parity for every feed state and provider choice', () => {
    const keys = (value: Record<string, unknown>, prefix = ''): string[] => Object.entries(value).flatMap(([key, item]) => item && typeof item === 'object' ? keys(item as Record<string, unknown>, `${prefix}${key}.`) : `${prefix}${key}`);
    expect(keys(ru).sort()).toEqual(keys(en).sort());
    for (const key of keys(ru.feed, 'feed.')) expect(i18n.exists(key)).toBe(true);
  });
});
