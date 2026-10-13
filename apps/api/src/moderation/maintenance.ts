import { Prisma, type PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { moderationNotificationJobId, NOTIFICATION_BATCH_SIZE, type ModerationSettings } from '@squad/shared';

const RETENTION_BATCH_SIZE = 500;
const OUTBOX_RECHECK_MS = 15 * 60_000;
export const REQUEST_RETENTION_DAYS = 90;

/** Bounded SKIP LOCKED batches avoid broad locks. OPEN reports, pending and
 * accepted requests are never retention candidates; audit rows are preserved. */
export async function retainModerationData(prisma: PrismaClient,
  config: Pick<ModerationSettings, 'REPORT_RETENTION_DAYS'>, now = new Date()): Promise<{ reports: number; requests: number }> {
  const reports = await prisma.$transaction(async (tx) => {
    const batch = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM reports WHERE status <> 'OPEN'
        AND COALESCE(resolved_at, created_at) < ${new Date(now.getTime() - config.REPORT_RETENTION_DAYS * 86_400_000)}
      ORDER BY COALESCE(resolved_at, created_at), id LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE SKIP LOCKED`);
    return batch.length ? (await tx.report.deleteMany({ where: { id: { in: batch.map(({ id }) => id) }, status: { not: 'OPEN' } } })).count : 0;
  });
  // Release report locks before deleting request parents: their SET NULL FK may
  // update other report rows. Separate phases avoid report/request lock cycles
  // even if two maintenance invocations overlap during an operational retry.
  const requests = await prisma.$transaction(async (tx) => {
    const batch = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM teammate_requests WHERE status IN ('EXPIRED', 'CANCELED', 'DECLINED')
        AND COALESCE(resolved_at, created_at) < ${new Date(now.getTime() - REQUEST_RETENTION_DAYS * 86_400_000)}
      ORDER BY COALESCE(resolved_at, created_at), id LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE SKIP LOCKED`);
    return batch.length ? (await tx.teammateRequest.deleteMany({ where: { id: { in: batch.map(({ id }) => id) },
      status: { in: ['EXPIRED', 'CANCELED', 'DECLINED'] } } })).count : 0;
  });
  await prisma.$transaction(async (tx) => {
    // Confirmation hashes/reasons should not outlive their short operational use.
    const confirmations = await tx.adminActionConfirmation.findMany({ where: { expiresAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } },
      select: { id: true }, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: RETENTION_BATCH_SIZE });
    if (confirmations.length) await tx.adminActionConfirmation.deleteMany({ where: { id: { in: confirmations.map(({ id }) => id) } } });
  });
  return { reports, requests };
}

/** Redis receives only an opaque outbox UUID. A missing job is retried after
 * Redis data loss; an already terminal job never receives a fresh retry budget. */
export async function dispatchModerationNotifications(prisma: PrismaClient, queue: Pick<Queue, 'add' | 'getJob'>,
  now = new Date()): Promise<number> {
  const events = await prisma.moderationNotification.findMany({ where: { deliveredAt: null,
    AND: [{ OR: [{ enqueuedAt: null }, { enqueuedAt: { lte: new Date(now.getTime() - OUTBOX_RECHECK_MS) } }] },
      { OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] }] },
    select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: NOTIFICATION_BATCH_SIZE });
  let enqueued = 0;
  for (const event of events) {
    try {
      const jobId = moderationNotificationJobId(event.id);
      const existing = await queue.getJob(jobId);
      if (existing && ['failed', 'completed'].includes(await existing.getState())) {
        await prisma.moderationNotification.updateMany({ where: { id: event.id, deliveredAt: null },
          data: { deliveredAt: now, claimToken: null, claimedUntil: null } });
        continue;
      }
      await queue.add('moderation-notification', { eventId: event.id }, { jobId });
      await prisma.moderationNotification.updateMany({ where: { id: event.id, deliveredAt: null }, data: { enqueuedAt: now } });
      enqueued += 1;
    } catch { /* A later scan retries; one failed enqueue never blocks another event. */ }
  }
  return enqueued;
}
