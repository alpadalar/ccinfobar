import { describe, expect, it, vi } from 'vitest';
import { retryOnce } from '../../src/cli/retry.js';

describe('retryOnce', () => {
  it('returns the first result without sleeping', async () => {
    const sleep = vi.fn(async () => {});
    await expect(retryOnce(async () => 1, 200, sleep)).resolves.toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries once after the delay', async () => {
    const sleep = vi.fn(async () => {});
    const load = vi.fn().mockRejectedValueOnce(new Error('first')).mockResolvedValueOnce('ok');
    await expect(retryOnce(load, 200, sleep)).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('rejects with the second error', async () => {
    const sleep = vi.fn(async () => {});
    const load = vi.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'));
    await expect(retryOnce(load, 200, sleep)).rejects.toThrow('second');
    expect(load).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('waits 200 ms by default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const load = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(2);
      const p = retryOnce(load);
      await vi.advanceTimersByTimeAsync(199);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toBe(2);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
