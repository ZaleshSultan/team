import { PrismaClient } from '@prisma/client';
import { requireSyntheticTarget, syntheticConsent, syntheticCount, SYNTHETIC_TELEGRAM_MIN, SYNTHETIC_TELEGRAM_MAX, SyntheticGuardError } from '../src/dev/synthetic-guard.js';
import { ownsSyntheticUser, syntheticBatch } from '../src/dev/synthetic-data.js';
import { requireSyntheticConstraint, type SyntheticConstraint } from '../src/dev/synthetic-constraint.js';

let prisma: PrismaClient | undefined;
try {
  const target = requireSyntheticTarget(process.env);
  const [action, countArgument, ...extra] = process.argv.slice(2);
  if (!['seed', 'cleanup'].includes(action ?? '') || extra.length || (action === 'cleanup' && countArgument !== undefined)) throw new SyntheticGuardError('SYNTHETIC_ARGUMENTS_INVALID');
  const count = action === 'seed' ? syntheticCount(countArgument) : 0;
  const consent = syntheticConsent(process.env);
  prisma = new PrismaClient({ datasourceUrl: target.databaseUrl, log: [] });
  const affected = await prisma.$transaction(async (tx) => {
    // Serializes cooperating tools; seed's DDL also exclusively locks users in
    // this explicitly guarded disposable database for the transaction duration.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(705005, 1)`;
    const constraints = await tx.$queryRaw<SyntheticConstraint[]>`
      SELECT conname AS name, pg_get_expr(conbin, conrelid) AS expression, convalidated AS validated
      FROM pg_constraint
      WHERE conrelid = 'public.users'::regclass AND conname = 'users_telegram_id_positive' AND contype = 'c'`;
    requireSyntheticConstraint(constraints, false);
    const where = { telegramId: { gte: SYNTHETIC_TELEGRAM_MIN, lte: SYNTHETIC_TELEGRAM_MAX } };
    const existing = await tx.user.findMany({ where, select: { id: true, telegramId: true } });
    if (existing.some((user) => !ownsSyntheticUser(user))) throw new SyntheticGuardError('SYNTHETIC_RESERVED_RANGE_COLLISION');
    if (action === 'cleanup') {
      const removed = (await tx.user.deleteMany({ where })).count;
      await tx.$executeRaw`ALTER TABLE public.users VALIDATE CONSTRAINT users_telegram_id_positive`;
      return removed;
    }
    if (existing.length) throw new SyntheticGuardError('SYNTHETIC_SEED_ALREADY_EXISTS');
    requireSyntheticConstraint(constraints, true);
    // Disposable DB only, within the atomic transaction. Restore the exact CHECK
    // as NOT VALID before committing: new/updated users still require positive
    // IDs, while the existing synthetic rows can be read for feed benchmarks.
    await tx.$executeRaw`ALTER TABLE public.users DROP CONSTRAINT users_telegram_id_positive`;
    const game = await tx.game.upsert({ where: { slug: 'cs2' }, update: {}, create: { slug: 'cs2', name: 'Counter-Strike 2', steamAppId: 730 } });
    for (let start = 0; start < count; start += 500) {
      const batch = syntheticBatch(start, Math.min(500, count - start), game.id, consent);
      await tx.user.createMany({ data: batch.users });
      await tx.playerProfile.createMany({ data: batch.profiles });
      await tx.privacySettings.createMany({ data: batch.privacy });
      if (batch.steam.length) await tx.steamAccount.createMany({ data: batch.steam });
      if (batch.faceit.length) await tx.faceitAccount.createMany({ data: batch.faceit });
      if (batch.games.length) await tx.userGame.createMany({ data: batch.games });
    }
    await tx.$executeRaw`ALTER TABLE public.users ADD CONSTRAINT users_telegram_id_positive CHECK (telegram_id > 0) NOT VALID`;
    return count;
  }, { maxWait: 5_000, timeout: 120_000 });
  console.info(JSON.stringify({ action, syntheticUsers: affected }));
} catch (error) {
  console.error(error instanceof SyntheticGuardError ? error.code : 'SYNTHETIC_OPERATION_FAILED');
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect().catch(() => undefined);
}
