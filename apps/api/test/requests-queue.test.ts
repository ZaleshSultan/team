import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { dispatchRequestNotifications, expirePendingRequests } from '../src/requests/queue.js';

const now = new Date('2026-10-13T10:00:00.000Z');
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

describe('request expiry maintenance', () => {
  it('expires only due pending rows, using bounded nonblocking row locks', async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const query = vi.fn(async () => [{ id: id(1) }, { id: id(2) }]);
    const transaction = { $queryRaw: query, teammateRequest: { updateMany } };
    const prisma = { $transaction: vi.fn(async (operation) => operation(transaction)) } as unknown as PrismaClient;
    expect(await expirePendingRequests(prisma, now)).toBe(2);
    const sql = query.mock.calls[0]![0];
    expect(sql.sql).toContain('FOR UPDATE SKIP LOCKED'); expect(sql.sql).toContain("status = 'PENDING'");
    expect(sql.values).toContain(now); expect(sql.values).toContain(500);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: [id(1), id(2)] }, status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED', resolvedAt: now } });
  });
  it('does not write when no request is due', async () => {
    const updateMany = vi.fn();
    const prisma = { $transaction: vi.fn(async (operation) => operation({ $queryRaw: vi.fn(async () => []), teammateRequest: { updateMany } })) } as unknown as PrismaClient;
    expect(await expirePendingRequests(prisma, now)).toBe(0); expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('durable notification dispatch', () => {
  function harness(kinds: Array<'CREATED' | 'ACCEPTED'> = ['CREATED', 'ACCEPTED']) {
    const events = kinds.map((kind, index) => ({ id: id(index + 1), requestId: id(index + 10), kind }));
    const prisma = { requestNotification: { findMany: vi.fn(async () => events), updateMany: vi.fn(async () => ({ count: 1 })) } };
    const queue = { add: vi.fn(async () => undefined), getJob: vi.fn(async () => undefined) };
    return { events, prisma, queue, dispatch: () => dispatchRequestNotifications(prisma as unknown as PrismaClient, queue as never, now) };
  }
  it('enqueues opaque IDs with stable BullMQ-safe IDs after a durable DB event exists', async () => {
    const { dispatch, queue, events } = harness();
    expect(await dispatch()).toBe(2);
    expect(queue.add).toHaveBeenCalledWith('request-notification', { eventId: events[0]!.id }, { jobId: `request-${events[0]!.requestId}-created` });
    expect(queue.add).toHaveBeenCalledWith('request-notification', { eventId: events[1]!.id }, { jobId: `request-${events[1]!.requestId}-accepted` });
    expect(JSON.stringify(queue.add.mock.calls)).not.toMatch(/username|telegramId|message|SECRET/);
  });
  it('isolates an enqueue failure and lets later events through', async () => {
    const { dispatch, queue, prisma } = harness();
    queue.add.mockRejectedValueOnce(new Error('redis://:SECRET@host'));
    expect(await dispatch()).toBe(1); expect(queue.add).toHaveBeenCalledTimes(2);
    expect(prisma.requestNotification.updateMany).toHaveBeenCalledTimes(1);
  });
  it('does not reset the retry budget of an exhausted retained job', async () => {
    const { dispatch, queue, prisma } = harness(['CREATED']);
    queue.getJob.mockResolvedValueOnce({ getState: async () => 'failed' } as never);
    expect(await dispatch()).toBe(0); expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.requestNotification.updateMany).toHaveBeenCalledWith({ where: { id: id(1), deliveredAt: null },
      data: { deliveredAt: now, claimToken: null, claimedUntil: null } });
  });
  it('settles a completed job whose marker write was interrupted', async () => {
    const { dispatch, queue } = harness(['CREATED']);
    queue.getJob.mockResolvedValueOnce({ getState: async () => 'completed' } as never);
    expect(await dispatch()).toBe(0); expect(queue.add).not.toHaveBeenCalled();
  });
  it('re-adds an existing waiting job idempotently and rechecks lost Redis jobs after15min', async () => {
    const { dispatch, queue, prisma } = harness(['CREATED']);
    queue.getJob.mockResolvedValueOnce({ getState: async () => 'waiting' } as never);
    expect(await dispatch()).toBe(1);
    const select = prisma.requestNotification.findMany.mock.calls[0]![0];
    expect(select.take).toBe(100); expect(select.where.deliveredAt).toBeNull();
    expect(select.where.AND[0].OR[1].enqueuedAt.lte).toEqual(new Date(now.getTime() - 15 * 60_000));
  });
});
