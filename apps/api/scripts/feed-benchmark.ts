import { performance } from 'node:perf_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import { feedFiltersSchema, type FeedFilters } from '@squad/shared';
import { buildFeedQuery, type FeedPosition, type FeedRow } from '../src/feed/query.js';
import { cs2GameProvider } from '../src/games/cs2.js';
import { requireSyntheticTarget, syntheticConsent, SyntheticGuardError } from '../src/dev/synthetic-guard.js';
import { syntheticId } from '../src/dev/synthetic-data.js';

interface ExplainNode {
  'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string;
  'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number; Plans?: ExplainNode[];
}
interface ExplainPlan { Plan: ExplainNode; 'Planning Time': number; 'Execution Time': number }
interface Scenario { name: string; filters: FeedFilters; position?: FeedPosition }

function planSummary(node: ExplainNode): object[] {
  return [{ node: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'],
    rows: node['Actual Rows'], loops: node['Actual Loops'], removed: node['Rows Removed by Filter'] },
  ...(node.Plans ?? []).flatMap(planSummary)];
}
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0) * 100) / 100;
}

let prisma: PrismaClient | undefined;
try {
  const target = requireSyntheticTarget(process.env);
  const consent = syntheticConsent(process.env);
  if (process.argv.length > 2) throw new SyntheticGuardError('SYNTHETIC_ARGUMENTS_INVALID');
  prisma = new PrismaClient({ datasourceUrl: target.databaseUrl, log: [] });
  const game = await prisma.game.findUnique({ where: { slug: 'cs2' }, select: { id: true } });
  const caller = await prisma.user.findUnique({ where: { id: syntheticId('user', 1) }, select: { id: true } });
  const anchor = await prisma.playerProfile.findUnique({ where: { id: syntheticId('profile', 3_000) }, select: { id: true, createdAt: true } });
  if (!game || !caller || !anchor) throw new SyntheticGuardError('SYNTHETIC_BENCHMARK_SEED_REQUIRED');
  // Planner statistics only, on the already guarded disposable database.
  await prisma.$executeRaw`ANALYZE users, player_profiles, steam_accounts, faceit_accounts, privacy_settings, user_games, blocks, teammate_requests`;
  const scenarios: Scenario[] = [
    { name: 'default', filters: feedFiltersSchema.parse({}) },
    { name: 'roles_languages_mic', filters: feedFiltersSchema.parse({ roles: ['awp', 'support'], languages: ['ru', 'en'], hasMic: true }) },
    { name: 'regions_team_evening', filters: feedFiltersSchema.parse({ regions: ['KZ', 'EU'], lookingFor: ['duo', 'team'], playTimes: ['evening', 'night'] }) },
    { name: 'verified_faceit_range', filters: feedFiltersSchema.parse({ verifiedOnly: true, faceitLevelMin: 6, faceitLevelMax: 10 }) },
    { name: 'selective_all_fields', filters: feedFiltersSchema.parse({ roles: ['igl'], languages: ['kk'], regions: ['KZ'], lookingFor: ['team'], playTimes: ['night'], hasMic: true, verifiedOnly: true, faceitLevelMin: 8, faceitLevelMax: 10 }) },
    { name: 'include_bans', filters: feedFiltersSchema.parse({ noBans: false }) },
    { name: 'deep_cursor', filters: feedFiltersSchema.parse({}), position: anchor },
  ];
  const output: object[] = [];
  for (const scenario of scenarios) {
    const query = buildFeedQuery({ gameId: game.id, callerId: caller.id, provider: cs2GameProvider,
      filters: scenario.filters, position: scenario.position ?? null, limit: 100,
      now: new Date(), minimumAge: consent.ageMinimum, rulesVersion: consent.rulesVersion });
    const coldStart = performance.now();
    const rows = await prisma.$queryRaw<FeedRow[]>(query);
    const firstMs = performance.now() - coldStart;
    const timings: number[] = [];
    for (let repetition = 0; repetition < 30; repetition++) {
      const started = performance.now();
      await prisma.$queryRaw<FeedRow[]>(query);
      timings.push(performance.now() - started);
    }
    const explain = await prisma.$queryRaw<Array<{ 'QUERY PLAN': ExplainPlan[] }>>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
    const plan = explain[0]?.['QUERY PLAN'][0];
    if (!plan) throw new SyntheticGuardError('SYNTHETIC_BENCHMARK_PLAN_INVALID');
    output.push({ scenario: scenario.name, rows: rows.length, batchLimit: 100, warmSamples: timings.length,
      firstMs: Math.round(firstMs * 100) / 100, p50Ms: percentile(timings, 0.5), p95Ms: percentile(timings, 0.95),
      planningMs: plan['Planning Time'], executionMs: plan['Execution Time'],
      sharedHitBlocks: plan.Plan['Shared Hit Blocks'], sharedReadBlocks: plan.Plan['Shared Read Blocks'],
      plan: planSummary(plan.Plan) });
  }
  // Only public scenario names and aggregate timings/plans: no rows, IDs or URLs.
  console.info(JSON.stringify({ profileCount: await prisma.playerProfile.count(), scenarios: output }, null, 2));
} catch (error) {
  console.error(error instanceof SyntheticGuardError ? error.code : 'SYNTHETIC_BENCHMARK_FAILED');
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect().catch(() => undefined);
}
