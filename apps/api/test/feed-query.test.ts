import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { feedFiltersSchema, feedQuerySchema, feedResponseSchema } from '@squad/shared';
import { parseFeedQuery } from '../src/feed/filters.js';
import { buildFeedQuery, DECLINED_REQUEST_COOLDOWN_DAYS, type FeedQueryInput, type FeedRow } from '../src/feed/query.js';
import { FeedService } from '../src/feed/service.js';
import { cs2GameProvider } from '../src/games/cs2.js';
import { profileFixture, steamFixture } from './profile-fixtures.js';

const now = new Date('2026-10-13T12:00:00.000Z');
const callerId = '20000000-0000-4000-8000-000000000001';
const gameId = '30000000-0000-4000-8000-000000000001';
const baseInput: FeedQueryInput = { gameId, callerId, provider: cs2GameProvider, filters: feedFiltersSchema.parse({}),
  position: null, limit: 20, now, minimumAge: 18, rulesVersion: 'current' };
function query(overrides: Partial<FeedQueryInput> = {}) { return buildFeedQuery({ ...baseInput, ...overrides }); }
function row(index: number, override: Partial<FeedRow> = {}): FeedRow {
  return { id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, createdAt: new Date(now.getTime() - index),
    nickname: profileFixture.nickname, roles: profileFixture.roles, lookingFor: profileFixture.lookingFor,
    playTimes: profileFixture.playTimes, languages: profileFixture.languages, region: profileFixture.region,
    hasMic: profileFixture.hasMic, bio: profileFixture.bio, steamId64: steamFixture.steamId64,
    personaName: steamFixture.personaName, vacBans: 0, gameBans: 0, communityBanned: false, economyBan: 'none',
    faceitSteamId64: steamFixture.steamId64, faceitLevel: 8, faceitElo: 1800,
    shareSteamActivity: false, playtimeTotal: null, playtime2weeks: null, ...override };
}

describe('provider-owned feed query validation', () => {
  it('uses documented defaults and strictly parses every filter', () => {
    expect(parseFeedQuery({}, cs2GameProvider)).toEqual({ filters: { roles: [], languages: [], regions: [], lookingFor: [],
      playTimes: [], verifiedOnly: false, noBans: true }, limit: 20 });
    expect(parseFeedQuery({ roles: ['AWP, entry', 'entry'], languages: 'EN,ru', regions: ['kz', 'EU'],
      lookingFor: 'DUO,team', playTimes: 'NIGHT,day', faceitLevelMin: '2', faceitLevelMax: '10',
      hasMic: 'false', verifiedOnly: 'true', noBans: 'false', limit: '50', cursor: 'opaque' }, cs2GameProvider))
      .toEqual({ filters: { roles: ['awp', 'entry'], languages: ['en', 'ru'], regions: ['EU', 'KZ'],
        lookingFor: ['duo', 'team'], playTimes: ['day', 'night'], faceitLevelMin: 2, faceitLevelMax: 10,
        hasMic: false, verifiedOnly: true, noBans: false }, limit: 50, cursor: 'opaque' });
  });
  it('takes every allow-list from the supplied provider rather than hardcoding CS2 values', () => {
    const provider = { ...cs2GameProvider, profileOptions: { roles: ['custom'], languages: ['xy'], regions: ['MOON'], lookingFor: ['group'], playTimes: ['dawn'] } };
    expect(parseFeedQuery({ roles: 'custom', languages: 'xy', regions: 'moon', lookingFor: 'group', playTimes: 'dawn' }, provider).filters.roles).toEqual(['custom']);
    expect(() => parseFeedQuery({ roles: 'entry' }, provider)).toThrow();
  });
  it.each([
    { unknown: 'value' }, { roles: 'invalid' }, { languages: 'invalid' }, { regions: 'invalid' },
    { lookingFor: 'invalid' }, { playTimes: 'invalid' }, { roles: '' }, { roles: 'awp,' }, { roles: [] },
    { hasMic: '1' }, { noBans: 'TRUE' }, { verifiedOnly: 'yes' }, { hasMic: ['true', 'false'] },
    { faceitLevelMin: '0' }, { faceitLevelMax: '11' }, { faceitLevelMin: '1.5' },
    { faceitLevelMin: '8', faceitLevelMax: '3' }, { faceitLevelMax: ['1', '2'] },
    { limit: '0' }, { limit: '51' }, { limit: '-1' }, { limit: '1e1' }, { limit: '01' }, { limit: ['1', '2'] },
    { cursor: '' }, { cursor: ['opaque', 'another'] },
  ])('rejects invalid query %# without broad coercion', (input) => {
    expect(() => parseFeedQuery(input, cs2GameProvider)).toThrow();
  });
  it('shared schemas reject unknown filters, reversed ranges and limits outside 1–50', () => {
    expect(feedFiltersSchema.safeParse({ secret: true }).success).toBe(false);
    expect(feedFiltersSchema.safeParse({ faceitLevelMin: 7, faceitLevelMax: 2 }).success).toBe(false);
    expect(feedQuerySchema.safeParse({ filters: {}, limit: 51 }).success).toBe(false);
  });
});

describe('parameterized feed query plan', () => {
  it('requires current eligible users and excludes both block/request directions globally', () => {
    const sql = query();
    expect(sql.text).toContain('p.is_published = true');
    expect(sql.text).toContain('u.id <>'); expect(sql.text).toContain('u.is_banned = false');
    expect(sql.text).toContain('u.bot_blocked = false'); expect(sql.text).toContain('u.username IS NOT NULL');
    expect(sql.text).toContain('u.age_confirmed_at IS NOT NULL'); expect(sql.text).toContain('u.rules_accepted_at IS NOT NULL');
    expect(sql.text).toContain('JOIN steam_accounts sa ON sa.user_id = u.id');
    expect(sql.text.match(/NOT EXISTS \(SELECT 1 FROM blocks/g)).toHaveLength(2);
    expect(sql.text.match(/NOT EXISTS \(SELECT 1 FROM teammate_requests/g)).toHaveLength(3);
    expect(sql.text.match(/r.status = 'ACCEPTED' OR \(r.status = 'PENDING' AND r.expires_at >/g)).toHaveLength(2);
    expect(sql.values).toContainEqual(now);
    expect(sql.text).toContain("r.status = 'DECLINED' AND r.resolved_at >=");
    expect(sql.text).not.toContain('r.game_id');
    expect(sql.values).toContainEqual(new Date(now.getTime() - 14 * 86_400_000));
    expect(DECLINED_REQUEST_COOLDOWN_DAYS).toBe(14);
  });
  it('combines OR array membership within fields with AND across fields and exact mic values', () => {
    const filters = feedFiltersSchema.parse({ roles: ['awp', 'entry'], languages: ['ru', 'en'], regions: ['KZ', 'EU'],
      lookingFor: ['duo'], playTimes: ['night'], hasMic: false, verifiedOnly: true, faceitLevelMin: 3, faceitLevelMax: 8 });
    const sql = query({ filters });
    for (const column of ['roles', 'languages', 'looking_for', 'play_times']) expect(sql.text).toContain(`p.${column} && ARRAY[`);
    expect(sql.text).toMatch(/p.region IN \(\$\d+,\$\d+\)/);
    expect(sql.text).toContain('p.has_mic ='); expect(sql.values).toContain(false);
    expect(sql.text).toContain('AND fa.steam_id64 IS NOT NULL AND fa.level >=');
    expect(sql.text).toContain('AND fa.level <=');
    expect(sql.values).toEqual(expect.arrayContaining(['awp', 'entry', 'ru', 'en', 'KZ', 'EU', 'duo', 'night', 3, 8]));
    for (const value of ['awp', 'entry', 'ru', 'KZ']) expect(sql.text).not.toContain(`'${value}'`);
  });
  it('keeps unknown bans, hides only positive VAC/game bans and adds no filter when disabled', () => {
    expect(query().text).toContain('(sa.vac_bans IS NULL OR sa.vac_bans <= 0) AND (sa.game_bans IS NULL OR sa.game_bans <= 0)');
    const sql = query({ filters: feedFiltersSchema.parse({ noBans: false }) });
    expect(sql.text).not.toContain('sa.vac_bans IS NULL');
    expect(sql.text).not.toContain('sa.community_banned = false');
  });
  it('requires FACEIT Steam matching and avoids reading private activity rows', () => {
    const sql = query();
    expect(sql.text).toContain('fa.user_id = u.id AND fa.steam_id64 = sa.steam_id64');
    expect(sql.text).toContain('AND ps.share_steam_activity = true');
    expect(sql.text).not.toContain('SELECT *');
    expect(sql.text).not.toContain('telegram_id');
  });
  it('uses descending keyset comparison and bound timestamps/UUIDs without offsets', () => {
    const position = { createdAt: now, id: profileFixture.id };
    const sql = query({ position });
    expect(sql.text).toMatch(/\(p.created_at, p.id\) < \(\$\d+, \$\d+::uuid\)/);
    expect(sql.text).toContain('ORDER BY p.created_at DESC, p.id DESC');
    expect(sql.text).not.toContain('OFFSET'); expect(sql.text).not.toContain(profileFixture.id);
    expect(sql.values).toContain(now); expect(sql.values).toContain(profileFixture.id);
  });
});

describe('feed batch service and serializer boundary', () => {
  const config = { AGE_MINIMUM: 18, RULES_VERSION: 'current' };
  function service(batches: FeedRow[][]) {
    const db = { game: { findUnique: vi.fn().mockResolvedValue({ id: gameId }) }, $queryRaw: vi.fn() };
    for (const batch of batches) db.$queryRaw.mockResolvedValueOnce(batch);
    return { service: new FeedService(db as unknown as PrismaClient, config), db };
  }
  const input = { callerId, filters: baseInput.filters, position: null, limit: 2, now };
  it('returns only cards and uses the last included valid row for the next cursor', async () => {
    const fixture = service([[row(1), row(2, { bio: '@unsafe' }), row(3), row(4)]]);
    const page = await fixture.service.listPage(input);
    expect(page.items.map((item) => item.id)).toEqual([row(1).id, row(3).id]);
    expect(page.hasMore).toBe(true); expect(page.position).toEqual({ id: row(3).id, createdAt: row(3).createdAt });
    expect(fixture.db.game.findUnique).toHaveBeenCalledWith({ where: { slug: 'cs2' }, select: { id: true } });
    expect(fixture.db.$queryRaw).toHaveBeenCalledTimes(1);
    const response = feedResponseSchema.parse({ items: page.items, nextCursor: 'opaque' });
    for (const field of ['telegramId', 'username', 'userId', 'steamId64', 'faceitSteamId64', 'library', 'playtimeTotal', 'playtime2weeks', 'createdAt'])
      expect(JSON.stringify(response)).not.toContain(field);
    expect(Object.keys(response.items[0]!).sort()).toMatchInlineSnapshot(`
      [
        "badges",
        "bio",
        "faceit",
        "hasBans",
        "hasMic",
        "id",
        "languages",
        "lookingFor",
        "nickname",
        "playTimes",
        "region",
        "roles",
      ]
    `);
  });
  it('scans invalid legacy rows in batches rather than querying for each player', async () => {
    const invalid = Array.from({ length: 100 }, (_, index) => row(index + 1, { roles: ['invalid'] }));
    const fixture = service([invalid, [row(101), row(102)]]);
    const page = await fixture.service.listPage(input);
    expect(page.items).toHaveLength(2); expect(page.hasMore).toBe(false);
    expect(fixture.db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(fixture.db.$queryRaw.mock.calls[1]![0].values).toContain(row(100).id);
  });
  it('shows hours only with consent and preserves unknown ban status', async () => {
    const fixture = service([[row(1, { shareSteamActivity: false, playtimeTotal: 600 }),
      row(2, { shareSteamActivity: true, playtimeTotal: 600, playtime2weeks: 90, vacBans: null })]]);
    const page = await fixture.service.listPage(input);
    expect(page.items[0]).not.toHaveProperty('activity');
    expect(page.items[1]!.activity).toEqual({ cs2Hours: 10, cs2Hours2weeks: 1.5 });
    expect(page.items[1]!.hasBans).toBeNull();
  });
  it('returns an empty final page, skips malformed cached FACEIT levels, and propagates real query failures', async () => {
    const empty = service([[row(1, { faceitLevel: 99 })]]);
    expect(await empty.service.listPage(input)).toEqual({ items: [], hasMore: false, position: null });
    const failure = service([]); failure.db.$queryRaw.mockRejectedValue(new Error('unavailable'));
    await expect(failure.service.listPage(input)).rejects.toThrow('unavailable');
  });
  it('fails cleanly when the selected provider game is absent', async () => {
    const fixture = service([]); fixture.db.game.findUnique.mockResolvedValue(null);
    await expect(fixture.service.listPage(input)).rejects.toMatchObject({ statusCode: 503, code: 'GAME_UNAVAILABLE' });
    expect(fixture.db.$queryRaw).not.toHaveBeenCalled();
  });
});
