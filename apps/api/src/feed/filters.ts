import { z } from 'zod';
import { feedFiltersSchema, feedQuerySchema, type FeedQuery } from '@squad/shared';
import type { GameProvider } from '../games/provider.js';

const rawList = z.union([z.string().max(4096), z.array(z.string().max(4096)).max(50)]);
function values(options: string[], uppercase = false) {
  return rawList.transform((input) => [...new Set((Array.isArray(input) ? input : [input])
    .flatMap((part) => part.split(','))
    .map((value) => uppercase ? value.trim().toUpperCase() : value.trim().toLowerCase()))].sort())
    .pipe(z.array(z.string().refine((value) => options.includes(value), 'Invalid filter option')).min(1).max(options.length))
    .optional().transform((value) => value ?? []);
}
const booleanValue = z.enum(['true', 'false']).transform((value) => value === 'true');
const integerValue = (max: number) => z.string().regex(/^[1-9]\d*$/).max(2).transform(Number).pipe(z.number().int().min(1).max(max));

/** Fastify query values only; no coercion of arbitrary booleans or unknown keys. */
export function parseFeedQuery(raw: unknown, provider: GameProvider): FeedQuery {
  const options = provider.profileOptions;
  const parsed = z.object({
    faceitLevelMin: integerValue(10).optional(), faceitLevelMax: integerValue(10).optional(),
    roles: values(options.roles), languages: values(options.languages),
    regions: values(options.regions, true), lookingFor: values(options.lookingFor),
    playTimes: values(options.playTimes), hasMic: booleanValue.optional(),
    verifiedOnly: booleanValue.optional().default('false'), noBans: booleanValue.optional().default('true'),
    limit: integerValue(50).optional().default('20'), cursor: z.string().min(1).max(4096).optional(),
  }).strict().parse(raw);
  const { limit, cursor, ...filterValues } = parsed;
  return feedQuerySchema.parse({ filters: feedFiltersSchema.parse(filterValues), limit,
    ...(cursor === undefined ? {} : { cursor }) });
}
