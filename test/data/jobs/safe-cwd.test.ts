import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeCwd } from '../../../src/data/jobs/runner.js';

afterEach(() => vi.restoreAllMocks());

describe('safeCwd', () => {
  it('prefers home, then temp', () => {
    expect(safeCwd()).toBe(os.homedir());
    vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-ccib-home');
    expect(safeCwd()).toBe(os.tmpdir());
  });

  it('falls back to the binary folder and never to an undefined cwd', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-ccib-home');
    vi.spyOn(os, 'tmpdir').mockReturnValue('/nonexistent-ccib-tmp');
    expect(safeCwd()).toBe(path.dirname(process.execPath));
  });
});
