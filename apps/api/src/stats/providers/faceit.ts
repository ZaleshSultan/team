import { faceitPlayerResponseSchema, faceitStatsResponseSchema } from '@squad/shared';
import { isSteamId64, ProviderError, ProviderHttp, type ProviderOptions } from './http.js';

export interface FaceitPlayer {
  playerId: string;
  nickname: string;
  steamId64: string;
  profileUrl: string | null;
  level: number | null;
  elo: number | null;
}
export interface FaceitSnapshot extends FaceitPlayer {
  kd: number | null;
  winRate: number | null;
  favoriteMaps: string[];
}

function invalid(): never { throw new ProviderError('faceit', 'INVALID_RESPONSE'); }

export function mapFaceitPlayer(value: unknown, steamId64: string): FaceitPlayer {
  const parsed = faceitPlayerResponseSchema.safeParse(value);
  if (!parsed.success || !isSteamId64(steamId64)) invalid();
  const player = parsed.data;
  const game = player.games.cs2;
  // Top-level steam_id_64 and legacy CS:GO never prove ownership of the CS2 account.
  if (!game || game.game_player_id !== steamId64) throw new ProviderError('faceit', 'STEAM_ID_MISMATCH');
  let profileUrl: string | null = null;
  if (player.faceit_url) {
    try {
      const url = new URL(player.faceit_url.replace('{lang}', 'en'));
      if (url.protocol === 'https:' && ['faceit.com', 'www.faceit.com'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash) profileUrl = url.toString();
    } catch { /* Do not forward an untrusted URL. */ }
  }
  return { playerId: player.player_id, nickname: player.nickname, steamId64, profileUrl,
    level: game.skill_level && game.skill_level >= 1 ? game.skill_level : null, elo: game.faceit_elo ?? null };
}

function metric(value: unknown, max = 1_000_000): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
}

export function mapFaceitStats(player: FaceitPlayer, value: unknown): FaceitSnapshot {
  const parsed = faceitStatsResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.player_id !== player.playerId || parsed.data.game_id !== 'cs2') invalid();
  const lifetime = parsed.data.lifetime ?? {};
  // These exact dynamic CS2 keys are NOT specified by FACEIT's public OpenAPI.
  // Missing/changed keys remain unknown; see docs/api-mappings.md verification limits.
  const kd = metric(lifetime['Average K/D Ratio']);
  const winRate = metric(lifetime['Win Rate %'], 100);
  const maps = new Map<string, number>();
  for (const segment of parsed.data.segments ?? []) {
    if (segment.type !== 'Map' || typeof segment.label !== 'string' || !/^de_[a-z0-9_]{1,60}$/i.test(segment.label)) continue;
    if (!segment.stats || typeof segment.stats !== 'object' || Array.isArray(segment.stats)) continue;
    const matches = metric((segment.stats as Record<string, unknown>).Matches, 2_147_483_647);
    if (matches === null || matches === 0) continue;
    maps.set(segment.label, (maps.get(segment.label) ?? 0) + matches);
  }
  const favoriteMaps = [...maps].sort(([labelA, matchesA], [labelB, matchesB]) => matchesB - matchesA || labelA.localeCompare(labelB)).slice(0, 5).map(([label]) => label);
  return { ...player, kd, winRate, favoriteMaps };
}

export class FaceitProvider {
  private readonly http: ProviderHttp;
  constructor(options: ProviderOptions = {}) { this.http = new ProviderHttp('faceit', options); }
  get configured(): boolean { return this.http.configured; }
  private async find(params: Record<string, string>, steamId64: string): Promise<FaceitPlayer | null> {
    if (!isSteamId64(steamId64)) invalid();
    try { return mapFaceitPlayer(await this.http.get('/data/v4/players', params), steamId64); }
    catch (error) { if (error instanceof ProviderError && error.code === 'NOT_FOUND') return null; throw error; }
  }
  findBySteamId(steamId64: string): Promise<FaceitPlayer | null> {
    return this.find({ game: 'cs2', game_player_id: steamId64 }, steamId64);
  }
  findByNickname(nickname: string, steamId64: string): Promise<FaceitPlayer | null> {
    if (!nickname.trim() || nickname.length > 100) invalid();
    return this.find({ nickname: nickname.trim() }, steamId64);
  }
  async findByPlayerId(playerId: string, steamId64: string): Promise<FaceitPlayer | null> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(playerId) || !isSteamId64(steamId64)) invalid();
    try { return mapFaceitPlayer(await this.http.get(`/data/v4/players/${encodeURIComponent(playerId)}`), steamId64); }
    catch (error) { if (error instanceof ProviderError && error.code === 'NOT_FOUND') return null; throw error; }
  }
  async sync(player: FaceitPlayer): Promise<FaceitSnapshot> {
    try {
      const stats = await this.http.get(`/data/v4/players/${encodeURIComponent(player.playerId)}/stats/cs2`);
      return mapFaceitStats(player, stats);
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'NOT_FOUND') return { ...player, kd: null, winRate: null, favoriteMaps: [] };
      throw error;
    }
  }
}
