import { feedFiltersSchema, type FeedFilters, type FeedResponse, type ProfileOptions, type PublicPlayerCard } from '@squad/shared';

export const FEED_FILTER_STORAGE_KEY = 'squad.feed.cs2.filters.v1';
export const feedChoiceFields = ['roles', 'languages', 'regions', 'lookingFor', 'playTimes'] as const;
export type FeedChoiceField = typeof feedChoiceFields[number];
export const defaultFeedFilters = (): FeedFilters => feedFiltersSchema.parse({});

/** Stored values are untrusted. Provider choices remain the source of truth. */
export function validateSavedFeedFilters(value: unknown, options: ProfileOptions): FeedFilters | null {
  const result = feedFiltersSchema.safeParse(value);
  if (!result.success) return null;
  const filters = result.data;
  if (feedChoiceFields.some((field) => filters[field].some((choice) => !options[field].includes(choice)))) return null;
  return { ...filters, ...Object.fromEntries(feedChoiceFields.map((field) => [field, [...new Set(filters[field])]])) };
}

interface FilterStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function readFeedFilters(options: ProfileOptions, storage: Pick<FilterStorage, 'getItem'> | undefined = undefined): FeedFilters {
  try {
    const saved = (storage ?? globalThis.localStorage).getItem(FEED_FILTER_STORAGE_KEY);
    return saved ? validateSavedFeedFilters(JSON.parse(saved) as unknown, options) ?? defaultFeedFilters() : defaultFeedFilters();
  } catch { return defaultFeedFilters(); }
}

export function rememberFeedFilters(filters: FeedFilters, storage: Pick<FilterStorage, 'setItem'> | undefined = undefined): void {
  try { (storage ?? globalThis.localStorage).setItem(FEED_FILTER_STORAGE_KEY, JSON.stringify(filters)); }
  catch { /* Restricted Telegram WebViews still have a fully working feed. */ }
}

export function feedSearchParams(filters: FeedFilters, cursor?: string | null): URLSearchParams {
  const params = new URLSearchParams({ limit: '20' });
  for (const field of feedChoiceFields) for (const value of filters[field]) params.append(field, value);
  if (filters.faceitLevelMin !== undefined) params.set('faceitLevelMin', String(filters.faceitLevelMin));
  if (filters.faceitLevelMax !== undefined) params.set('faceitLevelMax', String(filters.faceitLevelMax));
  if (filters.hasMic !== undefined) params.set('hasMic', String(filters.hasMic));
  if (filters.verifiedOnly) params.set('verifiedOnly', 'true');
  params.set('noBans', String(filters.noBans));
  if (cursor) params.set('cursor', cursor);
  return params;
}

export function activeFeedFilterCount(filters: FeedFilters): number {
  return feedChoiceFields.reduce((total, field) => total + filters[field].length, 0)
    + Number(filters.faceitLevelMin !== undefined) + Number(filters.faceitLevelMax !== undefined)
    + Number(filters.hasMic !== undefined) + Number(filters.verifiedOnly) + Number(!filters.noBans);
}

export function toggleFeedChoice(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

export type FeedPageState = { items: PublicPlayerCard[]; nextCursor: string | null };
/** Refresh replaces the page so unpublished/banned players cannot linger in local results. */
export function applyFeedPage(previous: FeedPageState, page: FeedResponse, append: boolean): FeedPageState {
  const items = append ? [...previous.items, ...page.items] : page.items;
  return { items: Array.from(new Map(items.map((card) => [card.id, card])).values()), nextCursor: page.nextCursor };
}

export function canLeaveProfile(dirty: boolean, confirm: () => boolean): boolean { return !dirty || confirm(); }

export function isPullToRefresh(start: { x: number; y: number } | null, end: { x: number; y: number }): boolean {
  return start !== null && end.y - start.y >= 75 && Math.abs(end.x - start.x) <= 50;
}
