import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { pollSteamLink, type SteamLinkSnapshot } from './steam-polling.js';

const start = Date.parse('2026-10-07T12:00:00.000Z');
const attempt = { id: 'b3a0b6dd-662e-44a5-9581-c2a3cf075e58', expiresAt: new Date(start + 10_000).toISOString() };
const snapshot = (status: SteamLinkSnapshot['status']): SteamLinkSnapshot => ({ ...attempt, status, failureCode: null });

describe('external Steam handoff polling', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
  afterEach(() => { vi.useRealTimers(); });

  it('polls every two seconds and stops immediately after completion', async () => {
    const getStatus = vi.fn().mockResolvedValueOnce(snapshot('PENDING')).mockResolvedValueOnce(snapshot('COMPLETED'));
    const onStatus = vi.fn();
    const job = pollSteamLink(attempt, { signal: new AbortController().signal, getStatus, onStatus, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(getStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(getStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await job;
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith(snapshot('COMPLETED'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('bounds polling by the one-time link expiry, including suspended WebViews', async () => {
    const expiring = { ...attempt, expiresAt: new Date(start + 2500).toISOString() };
    const getStatus = vi.fn().mockResolvedValue({ ...expiring, status: 'STARTED', failureCode: null });
    const onStatus = vi.fn();
    const job = pollSteamLink(expiring, { signal: new AbortController().signal, getStatus, onStatus, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(2500);
    await job;
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith({ ...expiring, status: 'EXPIRED', failureCode: null });
  });

  it('does not send a request when resumed after expiry', async () => {
    vi.setSystemTime(start + 10_001);
    const getStatus = vi.fn();
    const onStatus = vi.fn();
    await pollSteamLink(attempt, { signal: new AbortController().signal, getStatus, onStatus, onError: vi.fn() });
    expect(getStatus).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(snapshot('EXPIRED'));
  });

  it('aborts a stalled status request when its link expires', async () => {
    const expiring = { ...attempt, expiresAt: new Date(start + 500).toISOString() };
    const getStatus = vi.fn((_id: string, signal: AbortSignal) => new Promise<SteamLinkSnapshot>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const onStatus = vi.fn();
    const onError = vi.fn();
    const job = pollSteamLink(expiring, { signal: new AbortController().signal, getStatus, onStatus, onError });
    await vi.advanceTimersByTimeAsync(500);
    await job;
    expect(onStatus).toHaveBeenCalledWith({ ...expiring, status: 'EXPIRED', failureCode: null });
    expect(onError).not.toHaveBeenCalled();
  });

  it('retries a transient network failure but stops when its session is rejected', async () => {
    const getStatus = vi.fn().mockRejectedValueOnce(new ApiError('NETWORK_ERROR')).mockRejectedValueOnce(new ApiError('SESSION_INVALID'));
    const onError = vi.fn();
    const job = pollSteamLink(attempt, { signal: new AbortController().signal, getStatus, onStatus: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(2000);
    await job;
    expect(onError).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('cancels immediately on unmount without another request', async () => {
    const controller = new AbortController();
    const getStatus = vi.fn().mockResolvedValue(snapshot('PENDING'));
    const job = pollSteamLink(attempt, { signal: controller.signal, getStatus, onStatus: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await job;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});
