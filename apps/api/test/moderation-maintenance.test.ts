import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { dispatchModerationNotifications, retainModerationData } from '../src/moderation/maintenance.js';

const now = new Date('2026-10-15T12:00:00.000Z');
function outbox(ids = [randomUUID(), randomUUID()]) {
  const prisma = { moderationNotification: { findMany: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const queue = { getJob: vi.fn().mockResolvedValue(undefined), add: vi.fn().mockResolvedValue({}) };
  return { prisma, queue, ids, run: () => dispatchModerationNotifications(prisma as unknown as PrismaClient, queue as unknown as Queue, now) };
}
describe('moderation durable outbox dispatch', () => {
  it('enqueues stable IDs-only jobs and records enqueue state', async () => {
    const { prisma, queue, ids, run } = outbox(); expect(await run()).toBe(2);
    for (const id of ids) expect(queue.add).toHaveBeenCalledWith('moderation-notification', { eventId: id }, { jobId: `moderation-${id}` });
    expect(prisma.moderationNotification.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.moderationNotification.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100,
      select: { id: true }, where: expect.objectContaining({ deliveredAt: null }) }));
  });
  it('isolates failed enqueues without logging payloads or preventing later events', async () => {
    const { queue, run } = outbox(); queue.add.mockRejectedValueOnce(new Error('private URL/token'));
    expect(await run()).toBe(1); expect(queue.add).toHaveBeenCalledTimes(2);
  });
  it.each(['failed', 'completed'])('settles retained %s jobs instead of resetting their retry budget', async (state) => {
    const { prisma, queue, ids, run } = outbox([randomUUID()]);
    queue.getJob.mockResolvedValue({ getState: async () => state });
    expect(await run()).toBe(0); expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.moderationNotification.updateMany).toHaveBeenCalledWith({ where: { id: ids[0], deliveredAt: null },
      data: { deliveredAt: now, claimToken: null, claimedUntil: null } });
  });
  it('uses a bounded fifteen-minute Redis-loss recheck and ignores active claims', async () => {
    const { prisma, run } = outbox([]); expect(await run()).toBe(0);
    expect(prisma.moderationNotification.findMany.mock.calls[0]?.[0]).toMatchObject({ where: { AND: [
      { OR: [{ enqueuedAt: null }, { enqueuedAt: { lte: new Date(now.getTime() - 15 * 60_000) } }] },
      { OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] },
    ] } });
  });
});
describe('moderation bounded retention', () => {
  function database(reportIds: string[], requestIds: string[]) {
    const tx = { $queryRaw: vi.fn().mockResolvedValueOnce(reportIds.map((id) => ({ id }))).mockResolvedValueOnce(requestIds.map((id) => ({ id }))),
      report: { deleteMany: vi.fn().mockResolvedValue({ count: reportIds.length }) },
      teammateRequest: { deleteMany: vi.fn().mockResolvedValue({ count: requestIds.length }) },
      adminActionConfirmation: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() } };
    const prisma = { $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)) };
    return { tx, run: () => retainModerationData(prisma as unknown as PrismaClient, { REPORT_RETENTION_DAYS: 180 }, now) };
  }
  it('deletes only selected resolved-report and terminal-request IDs in bounded locked batches', async () => {
    const reports = [randomUUID()]; const requests = [randomUUID(), randomUUID()]; const { tx, run } = database(reports, requests);
    expect(await run()).toEqual({ reports: 1, requests: 2 });
    const reportSql = tx.$queryRaw.mock.calls[0]?.[0]; const requestSql = tx.$queryRaw.mock.calls[1]?.[0];
    expect(reportSql.sql).toContain("status <> 'OPEN'"); expect(reportSql.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(requestSql.sql).toContain("status IN ('EXPIRED', 'CANCELED', 'DECLINED')");
    expect(requestSql.sql).not.toContain('ACCEPTED'); expect(reportSql.values).toContain(500); expect(requestSql.values).toContain(500);
    expect(reportSql.values).toContainEqual(new Date(now.getTime() - 180 * 86_400_000));
    expect(requestSql.values).toContainEqual(new Date(now.getTime() - 90 * 86_400_000));
    expect(tx.report.deleteMany).toHaveBeenCalledWith({ where: { id: { in: reports }, status: { not: 'OPEN' } } });
    expect(tx.teammateRequest.deleteMany).toHaveBeenCalledWith({ where: { id: { in: requests }, status: { in: ['EXPIRED', 'CANCELED', 'DECLINED'] } } });
  });
  it('performs no broad delete when both batches are empty', async () => {
    const { tx, run } = database([], []); expect(await run()).toEqual({ reports: 0, requests: 0 });
    expect(tx.report.deleteMany).not.toHaveBeenCalled(); expect(tx.teammateRequest.deleteMany).not.toHaveBeenCalled();
  });
});
