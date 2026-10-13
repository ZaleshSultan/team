import type { FaceitAccount, PlayerProfile, SteamAccount, UserGame } from '@prisma/client';
import { publicPlayerCardSchema, type PublicPlayerCard } from '@squad/shared';
import { cs2GameProvider, safeDisplayNickname } from '../games/cs2.js';
import { profileInput } from './gate.js';
import { AppError } from '../errors.js';

export interface PublicCardSource {
  profile: PlayerProfile; steam: SteamAccount | null; faceit: FaceitAccount | null;
  shareSteamActivity: boolean; cs2Game: Pick<UserGame, 'playtimeTotal' | 'playtime2weeks'> | null;
}

// Explicit projection is the only public boundary. Never spread a Prisma user,
// provider payload or owner response into this object.
export function serializePublicPlayerCard(source: PublicCardSource): PublicPlayerCard {
  const { profile, steam, faceit } = source;
  let validated;
  try { validated = cs2GameProvider.validateProfile({ ...profileInput(profile), gameSlug: 'cs2' }); }
  catch { throw new AppError(409, 'PROFILE_INVALID', 'Save a valid profile before previewing it'); }
  const badges = cs2GameProvider.isVerified({ steamId64: steam?.steamId64.toString() ?? null,
    faceitSteamId64: faceit?.steamId64.toString() ?? null });
  const knownBans = steam && steam.vacBans !== null && steam.gameBans !== null
    && steam.communityBanned !== null && steam.economyBan !== null;
  const anyBan = steam && ((steam.vacBans ?? 0) > 0 || (steam.gameBans ?? 0) > 0
    || steam.communityBanned === true || (steam.economyBan !== null && steam.economyBan !== 'none'));
  return publicPlayerCardSchema.parse({ id: profile.id,
    nickname: validated.nickname ?? safeDisplayNickname(steam?.personaName),
    roles: validated.roles, lookingFor: validated.lookingFor, playTimes: validated.playTimes,
    languages: validated.languages, region: validated.region, hasMic: validated.hasMic, bio: validated.bio,
    badges, faceit: badges.faceitVerified && faceit ? { level: faceit.level, elo: faceit.elo } : null,
    hasBans: anyBan ? true : knownBans ? false : null,
    ...(source.shareSteamActivity ? { activity: {
      cs2Hours: source.cs2Game ? source.cs2Game.playtimeTotal / 60 : null,
      cs2Hours2weeks: source.cs2Game?.playtime2weeks == null ? null : source.cs2Game.playtime2weeks / 60,
    } } : {}),
  });
}
