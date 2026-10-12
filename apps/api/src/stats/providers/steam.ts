import { steamBansResponseSchema, steamOwnedGamesResponseSchema, steamSummariesResponseSchema } from '@squad/shared';
import { isSteamId64, ProviderError, ProviderHttp, type ProviderOptions } from './http.js';

export interface SteamGame {
  steamAppId: number;
  name: string | null;
  playtimeTotal: number;
  playtime2weeks: number;
}

export interface SteamSnapshot {
  steamId64: string;
  personaName: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  visibility: number;
  timeCreated: Date | null;
  gameDetailsPublic: boolean;
  games: SteamGame[];
  vacBans: number;
  gameBans: number;
  daysSinceLastBan: number;
  communityBanned: boolean;
  economyBan: string;
}

function invalid(): never { throw new ProviderError('steam', 'INVALID_RESPONSE'); }

function safeSteamUrl(value: string, profile = false): string | null {
  try {
    const url = new URL(value);
    const validHost = profile ? url.hostname === 'steamcommunity.com'
      : url.hostname === 'steamcdn-a.akamaihd.net' || url.hostname.endsWith('.steamstatic.com') || url.hostname.endsWith('.steamusercontent.com');
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && validHost ? url.toString() : null;
  } catch { return null; }
}

export function mapSteamSnapshot(steamId64: string, owned: unknown, summaries: unknown, bans: unknown): SteamSnapshot {
  const gamesParsed = steamOwnedGamesResponseSchema.safeParse(owned);
  const summariesParsed = steamSummariesResponseSchema.safeParse(summaries);
  const bansParsed = steamBansResponseSchema.safeParse(bans);
  if (!isSteamId64(steamId64) || !gamesParsed.success || !summariesParsed.success || !bansParsed.success) invalid();
  const summary = summariesParsed.data.response.players.find((player) => player.steamid === steamId64);
  const ban = bansParsed.data.players.find((player) => player.SteamId === steamId64);
  if (!summary || !ban) invalid();
  const library = gamesParsed.data.response;
  // Explicit game_count=0 is an accessible empty library. Missing fields represent hidden details.
  const gameDetailsPublic = summary.communityvisibilitystate === 3 && (Array.isArray(library.games) || library.game_count === 0);
  if (library.games && library.game_count !== undefined && library.game_count !== library.games.length) invalid();
  const uniqueGames = new Map<number, SteamGame>();
  if (gameDetailsPublic) {
    for (const game of library.games ?? []) {
      if (uniqueGames.has(game.appid)) invalid();
      uniqueGames.set(game.appid, { steamAppId: game.appid, name: game.name?.slice(0, 200) ?? null,
        playtimeTotal: game.playtime_forever, playtime2weeks: game.playtime_2weeks ?? 0 });
    }
  }
  return {
    steamId64, personaName: summary.personaname.slice(0, 100),
    avatarUrl: safeSteamUrl(summary.avatarfull), profileUrl: safeSteamUrl(summary.profileurl, true),
    visibility: summary.communityvisibilitystate,
    timeCreated: summary.timecreated === undefined ? null : new Date(summary.timecreated * 1_000),
    gameDetailsPublic, games: [...uniqueGames.values()],
    vacBans: ban.NumberOfVACBans, gameBans: ban.NumberOfGameBans, daysSinceLastBan: ban.DaysSinceLastBan,
    communityBanned: ban.CommunityBanned, economyBan: ban.EconomyBan,
  };
}

export class SteamProvider {
  private readonly http: ProviderHttp;
  constructor(options: ProviderOptions = {}) { this.http = new ProviderHttp('steam', options); }
  get configured(): boolean { return this.http.configured; }
  async sync(steamId64: string): Promise<SteamSnapshot> {
    if (!isSteamId64(steamId64)) invalid();
    const summaries = await this.http.get('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId64 });
    const parsedSummaries = steamSummariesResponseSchema.safeParse(summaries);
    if (!parsedSummaries.success) invalid();
    const summary = parsedSummaries.data.response.players.find((player) => player.steamid === steamId64);
    if (!summary) invalid();
    const bans = await this.http.get('/ISteamUser/GetPlayerBans/v1/', { steamids: steamId64 });
    const owned = summary.communityvisibilitystate !== 3 ? { response: {} } : await this.http.get('/IPlayerService/GetOwnedGames/v1/', {
      steamid: steamId64, include_appinfo: 'true', include_played_free_games: 'true',
    });
    return mapSteamSnapshot(steamId64, owned, summaries, bans);
  }
}
