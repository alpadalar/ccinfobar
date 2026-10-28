import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSavePayloadMemo, savePayload } from '../../src/cli/render.js';
import type { StatusPayload } from '../../src/core/types.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');

beforeEach(() => resetSavePayloadMemo());

describe('savePayload', () => {
  const run = (payload: StatusPayload, mtimeMs: number | null) => {
    const write = vi.fn();
    const stat = vi.fn(() => (mtimeMs === null ? undefined : { mtimeMs }));
    savePayload(payload, { now: () => NOW, stat, write });
    return { write, stat };
  };

  it('writes the first call and skips an equal payload without a stat', () => {
    const write = vi.fn();
    const stat = vi.fn(() => undefined);
    const deps = { now: () => NOW, stat, write };
    savePayload({ session_id: '1' }, deps);
    savePayload({ session_id: '1' }, deps);
    expect(write).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('skips a changed payload when the file is younger than 5 s', () => {
    expect(run({ session_id: '1' }, NOW - 1000).write).not.toHaveBeenCalled();
    expect(run({ session_id: '2' }, NOW - 4999).write).not.toHaveBeenCalled();
  });

  it('writes a changed payload when the file is 5 s or older', () => {
    expect(run({ session_id: '1' }, NOW - 5000).write).toHaveBeenCalledTimes(1);
    expect(run({ session_id: '2' }, NOW - 6000).write).toHaveBeenCalledTimes(1);
  });

  it('always writes when the file is missing', () => {
    expect(run({ session_id: '1' }, null).write).toHaveBeenCalledTimes(1);
  });

  it('does not let a future mtime block the write', () => {
    expect(run({ session_id: '1' }, NOW + 60_000).write).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing write and retries the same payload next time', () => {
    const write = vi.fn(() => {
      throw new Error('disk full');
    });
    const deps = { now: () => NOW, stat: () => undefined, write };
    expect(() => savePayload({ session_id: '1' }, deps)).not.toThrow();
    savePayload({ session_id: '1' }, deps);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
