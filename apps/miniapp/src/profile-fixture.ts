import type { ProfileOptions, ProfileResponse, ProfileUpdateInput, PublicPlayerCard } from '@squad/shared';

export const profileOptionsFixture: ProfileOptions = {
  roles: ['entry', 'awp', 'support', 'lurk', 'igl'], lookingFor: ['duo', 'five_stack', 'team'],
  playTimes: ['morning', 'day', 'evening', 'night'],
  languages: ['ru', 'kk', 'en', 'de', 'fr', 'es', 'it', 'pt', 'tr', 'uk', 'pl', 'uz', 'ky', 'tg', 'az', 'hy', 'ka', 'be', 'zh', 'ko', 'ja', 'ar'],
  regions: ['KZ', 'RU', 'CIS', 'EU', 'OTHER'],
};
export const profileInputFixture: ProfileUpdateInput = {
  nickname: 'Игрок_17', roles: ['awp', 'support'], lookingFor: ['duo'], playTimes: ['evening'],
  languages: ['ru', 'kk'], region: 'KZ', hasMic: true, bio: 'Играю спокойно, ищу постоянную команду.',
};
export const profileFixture: ProfileResponse = {
  profile: { ...profileInputFixture, id: '08c514b6-1dd8-4547-b912-7a7fc15da187', gameSlug: 'cs2', updatedAt: '2026-10-13T12:00:00.000Z' },
  published: false, requirements: [], privacy: { shareSteamActivity: false },
  badges: { steamVerified: true, faceitVerified: true }, options: profileOptionsFixture,
};
export const publicProfileFixture: PublicPlayerCard = {
  ...profileInputFixture, id: '08c514b6-1dd8-4547-b912-7a7fc15da187', badges: profileFixture.badges,
  faceit: { level: 8, elo: 1800 }, hasBans: false,
};
