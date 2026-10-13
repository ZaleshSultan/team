import type { RequestItem } from '@squad/shared';
import { publicProfileFixture } from './profile-fixture.js';

export const requestFixture: RequestItem = {
  id: 'd8745600-2245-4b72-9224-8b8fa9e05a10', status: 'PENDING', message: 'Пойдём играть вечером?',
  createdAt: '2026-10-13T12:00:00.000Z', resolvedAt: null, expiresAt: '2026-10-20T12:00:00.000Z', player: publicProfileFixture,
};
