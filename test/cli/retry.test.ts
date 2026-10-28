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
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as never);
    try {
      const load = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(2);
      await expect(retryOnce(load)).resolves.toBe(2);
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 200);
    } finally {
      spy.mockRestore();
    }
  });
});
