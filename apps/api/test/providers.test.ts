import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { Cs2GameProvider, isFaceitVerified } from '../src/games/cs2.js';
import { FaceitProvider, mapFaceitPlayer, mapFaceitStats } from '../src/stats/providers/faceit.js';
import { ProviderError, ProviderHttp, parseRetryAfter, redactProviderSecrets } from '../src/stats/providers/http.js';
import { SteamProvider, mapSteamSnapshot } from '../src/stats/providers/steam.js';

const ID = '76561198000000000';
const OTHER = '76561198000000001';
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/providers/${name}.json`, import.meta.url), 'utf8'));
const steamMap = (owned = fixture('steam-owned-games'), summary = fixture('steam-summary'), bans = fixture('steam-bans')) => mapSteamSnapshot(ID, owned, summary, bans);
const faceitPlayer = () => mapFaceitPlayer(fixture('faceit-player'), ID);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('CS2 provider', () => {
  const provider = new Cs2GameProvider();
  const profile = { gameSlug: 'cs2', nickname: null, roles: ['awp'], hasMic: true, languages: ['ru'], region: 'EU', playTimes: ['evening'], lookingFor: ['duo'], bio: '' };
  it('pins CS2 catalog and validates game-specific inputs', () => {
    expect(provider.slug).toBe('cs2'); expect(provider.steamAppId).toBe(730);
    expect(provider.validateProfile(profile)).toEqual(profile);
    expect(() => provider.validateProfile({ ...profile, gameSlug: 'dota2' })).toThrow();
    expect(() => provider.validateProfile({ ...profile, roles: ['healer'] })).toThrow();
  });
  it('requires Steam; optional FACEIT is separately verified only by an exact Steam ID', () => {
    expect(provider.isVerified({ steamId64: null, faceitSteamId64: ID })).toEqual({ steamVerified: false, faceitVerified: false });
    expect(provider.isVerified({ steamId64: ID, faceitSteamId64: null })).toEqual({ steamVerified: true, faceitVerified: false });
    expect(provider.isVerified({ steamId64: 'invalid', faceitSteamId64: null })).toEqual({ steamVerified: false, faceitVerified: false });
    expect(isFaceitVerified({ steamId64: ID, faceitSteamId64: ID })).toBe(true);
    expect(isFaceitVerified({ steamId64: ID, faceitSteamId64: OTHER })).toBe(false);
    expect(isFaceitVerified({ steamId64: null, faceitSteamId64: null })).toBe(false);
  });
});

describe('Steam fixture mappings', () => {
  it('retains every app in minutes including omitted recent playtime', () => {
    const snapshot = steamMap();
    expect(snapshot.games).toEqual([
      { steamAppId: 730, name: 'Counter-Strike 2', playtimeTotal: 124800, playtime2weeks: 900 },
      { steamAppId: 570, name: 'Dota 2', playtimeTotal: 10500, playtime2weeks: 120 },
      { steamAppId: 440, name: 'Team Fortress 2', playtimeTotal: 360, playtime2weeks: 0 },
    ]);
    expect(snapshot).toMatchObject({ personaName: 'FixturePlayer', visibility: 3, gameDetailsPublic: true, vacBans: 1, gameBans: 2, daysSinceLastBan: 500, communityBanned: false, economyBan: 'none', timeCreated: new Date(1250000000000) });
  });
  it.each([1, 2])('private/friends-only summary (%s) discards games without error', (visibility) => {
    const summary = fixture('steam-summary'); summary.response.players[0].communityvisibilitystate = visibility;
    expect(steamMap(fixture('steam-owned-games'), summary)).toMatchObject({ gameDetailsPublic: false, games: [] });
  });
  it('distinguishes inaccessible details from an explicitly public empty library', () => {
    expect(steamMap({ response: {} })).toMatchObject({ gameDetailsPublic: false, games: [] });
    expect(steamMap({ response: { game_count: 0 } })).toMatchObject({ gameDetailsPublic: true, games: [] });
    expect(steamMap({ response: { game_count: 0, games: [] } })).toMatchObject({ gameDetailsPublic: true, games: [] });
  });
  it('rejects malformed or different-account responses instead of silently clearing caches', () => {
    expect(() => steamMap({ response: { game_count: 1, games: [] } })).toThrow('STEAM_INVALID_RESPONSE');
    const summaries = fixture('steam-summary'); summaries.response.players[0].steamid = OTHER;
    expect(() => steamMap(undefined, summaries)).toThrow('STEAM_INVALID_RESPONSE');
    const bans = fixture('steam-bans'); bans.players[0].SteamId = OTHER;
    expect(() => steamMap(undefined, undefined, bans)).toThrow('STEAM_INVALID_RESPONSE');
    const owned = fixture('steam-owned-games'); owned.response.games[0].playtime_forever = -1;
    expect(() => steamMap(owned)).toThrow('STEAM_INVALID_RESPONSE');
  });
  it('drops dangerous URLs and clamps names to database limits', () => {
    const summary = fixture('steam-summary'); summary.response.players[0].avatarfull = 'https://attacker.example/photo';
    summary.response.players[0].profileurl = 'javascript:alert(1)';
    const owned = fixture('steam-owned-games'); owned.response.games[0].name = 'a'.repeat(300);
    const snapshot = steamMap(owned, summary);
    expect(snapshot.avatarUrl).toBeNull(); expect(snapshot.profileUrl).toBeNull();
    expect(snapshot.games[0]?.name).toHaveLength(200);
  });
  it('never forwards query or fragment secrets from upstream display URLs', () => {
    const summary = fixture('steam-summary');
    summary.response.players[0].avatarfull += '?key=fixture-key'; summary.response.players[0].profileurl += '#key=fixture-key';
    expect(steamMap(undefined, summary)).toMatchObject({ avatarUrl: null, profileUrl: null });
    const player = fixture('faceit-player'); player.faceit_url += '?key=fixture-key';
    expect(mapFaceitPlayer(player, ID).profileUrl).toBeNull();
  });
  it('calls fixed documented endpoints for all games, including played free games', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('steam-summary')))
      .mockResolvedValueOnce(json(fixture('steam-bans'))).mockResolvedValueOnce(json(fixture('steam-owned-games')));
    expect((await new SteamProvider({ apiKey: 'fixture-key', fetch: fetcher }).sync(ID)).games).toHaveLength(3);
    const urls = fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.pathname)).toEqual(['/ISteamUser/GetPlayerSummaries/v2/', '/ISteamUser/GetPlayerBans/v1/', '/IPlayerService/GetOwnedGames/v1/']);
    expect(urls[2]?.searchParams.get('include_appinfo')).toBe('true');
    expect(urls[2]?.searchParams.get('include_played_free_games')).toBe('true');
    expect(urls[2]?.searchParams.has('appids_filter')).toBe(false);
  });
  it('never requests private libraries', async () => {
    const summary = fixture('steam-summary'); summary.response.players[0].communityvisibilitystate = 1;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(summary)).mockResolvedValueOnce(json(fixture('steam-bans')));
    expect(await new SteamProvider({ apiKey: 'fixture-key', fetch: fetcher }).sync(ID)).toMatchObject({ games: [], gameDetailsPublic: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('FACEIT fixture mappings', () => {
  it('maps the exact CS2 player and optional stats safely', () => {
    expect(mapFaceitStats(faceitPlayer(), fixture('faceit-stats'))).toMatchObject({ steamId64: ID, level: 8, elo: 1800, kd: 1.23, winRate: 57, favoriteMaps: ['de_mirage', 'de_dust2'], profileUrl: 'https://www.faceit.com/en/players/FixturePlayer' });
  });
  it('represents an unranked zero skill level as unknown rather than an invalid level', () => {
    const player = fixture('faceit-player'); player.games.cs2.skill_level = 0;
    expect(mapFaceitPlayer(player, ID)).toMatchObject({ level: null, elo: 1800 });
  });
  it('does not accept top-level or CS:GO matches when the CS2 Steam ID differs', () => {
    const player = fixture('faceit-player'); player.games.cs2.game_player_id = OTHER;
    expect(() => mapFaceitPlayer(player, ID)).toThrow('FACEIT_STEAM_ID_MISMATCH');
    delete player.games.cs2;
    expect(() => mapFaceitPlayer(player, ID)).toThrow('FACEIT_STEAM_ID_MISMATCH');
  });
  it('represents missing/dynamic unrecognized metrics as unknown, including invalid percentages', () => {
    expect(mapFaceitStats(faceitPlayer(), { player_id: faceitPlayer().playerId, game_id: 'cs2' })).toMatchObject({ kd: null, winRate: null, favoriteMaps: [] });
    const stats = fixture('faceit-stats'); stats.lifetime['Average K/D Ratio'] = 'NaN'; stats.lifetime['Win Rate %'] = '200';
    stats.segments.push({ type: 'Map', label: '<script>', stats: { Matches: '10000' } });
    expect(mapFaceitStats(faceitPlayer(), stats)).toMatchObject({ kd: null, winRate: null, favoriteMaps: ['de_mirage', 'de_dust2'] });
  });
  it('rejects cross-player/cross-game stats', () => {
    expect(() => mapFaceitStats(faceitPlayer(), { ...fixture('faceit-stats'), game_id: 'csgo' })).toThrow('FACEIT_INVALID_RESPONSE');
    expect(() => mapFaceitStats(faceitPlayer(), { ...fixture('faceit-stats'), player_id: 'other' })).toThrow('FACEIT_INVALID_RESPONSE');
  });
  it('auto-detects by CS2 Steam ID and sends authorization only in header', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('faceit-player')));
    expect(await new FaceitProvider({ apiKey: 'fixture-key', fetch: fetcher }).findBySteamId(ID)).toEqual(faceitPlayer());
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://open.faceit.com/data/v4/players?game=cs2&game_player_id=${ID}`);
    expect(options?.headers).toMatchObject({ authorization: 'Bearer fixture-key' });
  });
  it('nickname fallback also verifies Steam identity', async () => {
    const body = fixture('faceit-player'); body.games.cs2.game_player_id = OTHER;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    await expect(new FaceitProvider({ apiKey: 'fixture-key', fetch: fetcher }).findByNickname(' Somebody ', ID)).rejects.toMatchObject({ code: 'STEAM_ID_MISMATCH' });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('nickname')).toBe('Somebody');
  });
  it('refreshes by a stable player ID after nickname changes and still verifies ownership', async () => {
    const body = fixture('faceit-player'); body.nickname = 'Renamed';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    const provider = new FaceitProvider({ apiKey: 'fixture-key', fetch: fetcher });
    expect(await provider.findByPlayerId(body.player_id, ID)).toMatchObject({ nickname: 'Renamed' });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe(`/data/v4/players/${body.player_id}`);
    body.games.cs2.game_player_id = OTHER; fetcher.mockResolvedValue(json(body));
    await expect(provider.findByPlayerId(body.player_id, ID)).rejects.toMatchObject({ code: 'STEAM_ID_MISMATCH' });
  });
  it('returns null for unknown nicknames and preserves valid level/ELO if no match stats exist', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, 404));
    const provider = new FaceitProvider({ apiKey: 'fixture-key', fetch: fetcher });
    expect(await provider.findByNickname('missing', ID)).toBeNull();
    expect(await provider.sync(faceitPlayer())).toMatchObject({ level: 8, elo: 1800, kd: null, winRate: null, favoriteMaps: [] });
  });
});

describe('safe provider transport', () => {
  it.each(['steam', 'faceit'] as const)('missing %s key makes no HTTP call', async (provider) => {
    const fetcher = vi.fn<typeof fetch>(); const client = new ProviderHttp(provider, { fetch: fetcher });
    expect(client.configured).toBe(false);
    await expect(client.get('/unused')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('whitespace-only keys are unavailable', async () => {
    const http = new ProviderHttp('steam', { apiKey: '   ' });
    expect(http.configured).toBe(false); await expect(http.get('/x')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it.each([429, 503])('exposes %s Retry-After as safe retry metadata', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ key: 'never-forward-body' }, status, { 'retry-after': '60' }));
    await expect(new ProviderHttp('steam', { apiKey: 'fixture-secret', fetch: fetcher }).get('/x')).rejects.toMatchObject({ retryable: true, retryAfterMs: 60_000, statusCode: status });
  });
  it('parses HTTP-date delays and rejects malformed Retry-After values', () => {
    expect(parseRetryAfter('Mon, 12 Oct 2026 12:01:00 GMT', Date.parse('2026-10-12T12:00:00Z'))).toBe(60_000);
    expect(parseRetryAfter('0')).toBe(0); expect(parseRetryAfter('garbage')).toBeUndefined();
  });
  it.each([400, 401, 403, 404])('does not retry permanent %s', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, status));
    await expect(new ProviderHttp('faceit', { apiKey: 'fixture-secret', fetch: fetcher }).get('/x')).rejects.toMatchObject({ retryable: false, statusCode: status });
  });
  it('never retains raw transport errors, secret query URLs or cause', async () => {
    const secret = 'fixture-secret-never-log';
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`GET https://api.steampowered.com/x?key=${secret}`));
    const http = new ProviderHttp('steam', { apiKey: secret, fetch: fetcher });
    try { await http.get('/x'); throw new Error('expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(inspect(error)).not.toContain(secret); expect(JSON.stringify(error)).not.toContain(secret);
      expect(String(error)).toBe('ProviderError: STEAM_UNAVAILABLE');
    }
    expect(inspect(http)).not.toContain(secret); expect(JSON.stringify(http)).not.toContain(secret);
    expect(redactProviderSecrets(`GET https://api.steampowered.com/x?key=${secret}&steamid=${ID}`)).not.toContain(secret);
    expect(redactProviderSecrets(`GET https://api.steampowered.com/x?%6bey=${secret}&KEY=${secret}`)).not.toContain(secret);
  });
  it('preserves safe distributed limiter retry signals', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const gateError = new ProviderError('steam', 'RATE_LIMITED', true, 1000, 429);
    const http = new ProviderHttp('steam', { apiKey: 'fixture-key', fetch: fetcher, beforeRequest: async () => { throw gateError; } });
    await expect(http.get('/x')).rejects.toBe(gateError); expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects redirects and malformed/oversized bodies without exposing body data', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('not-json-fixture-secret'));
    await expect(new ProviderHttp('steam', { apiKey: 'fixture-key', fetch: fetcher }).get('/x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('abcdef', { headers: { 'content-length': '6' } }));
    await expect(new ProviderHttp('steam', { apiKey: 'fixture-key', fetch: huge, maxResponseBytes: 5 }).get('/x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('times out stalled fetches and response bodies', async () => {
    const stalledFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    await expect(new ProviderHttp('steam', { apiKey: 'fixture-key', fetch: stalledFetch, timeoutMs: 10 }).get('/x')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    const stalledBody = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() { /* deliberate stalled body */ } })));
    await expect(new ProviderHttp('steam', { apiKey: 'fixture-key', fetch: stalledBody, timeoutMs: 10 }).get('/x')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });
});
