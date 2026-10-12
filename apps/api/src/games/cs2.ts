import { cs2ProfileSchema, type PlayerProfileInput } from '@squad/shared';
import { isSteamId64 } from '../stats/providers/http.js';
import type { GameProvider } from './provider.js';

type Accounts = Parameters<GameProvider['isVerified']>[0];
export function isFaceitVerified(accounts: Accounts): boolean {
  return isSteamId64(accounts.steamId64) && accounts.faceitSteamId64 === accounts.steamId64;
}

export class Cs2GameProvider implements GameProvider {
  readonly slug = 'cs2';
  readonly steamAppId = 730;
  validateProfile(input: unknown): PlayerProfileInput {
    return cs2ProfileSchema.extend({ gameSlug: cs2ProfileSchema.shape.gameSlug.refine((slug) => slug === 'cs2') }).parse(input);
  }
  isVerified(accounts: Accounts): boolean { return isSteamId64(accounts.steamId64); }
}

export const cs2GameProvider = new Cs2GameProvider();
