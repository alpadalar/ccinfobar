import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[] }[],
  current: null as string | null,
}));

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: (file: string, args: string[]) => {
    h.calls.push({ file, args });
    return 'fatal';
  },
  execFile: (file: string, args: string[], _o: unknown, cb: (e: null, out: string) => void) => {
    h.calls.push({ file, args });
    setImmediate(() => cb(null, ''));
    return { stdin: { end() {} } };
  },
}));

vi.mock('../../src/data/which.js', () => ({
  binary: () => h.current,
  whichDeps: () => ({}),
}));

const { readGit, hardenedGit } = await import('../../src/data/git.js');
const { readJj } = await import('../../src/data/jj.js');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-which-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  h.calls.length = 0;
  h.current = null;
});

describe('git and jj spawn through binary()', () => {
  const abs = 'C:\\Git\\cmd\\git.exe';

  it('spawns the resolved absolute path for every git call', async () => {
    h.current = abs;
    readGit(tmp);
    await hardenedGit(tmp, ['status'], { harden: true, timeout: 1000 });
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((c) => c.file === abs)).toBe(true);
  });

  it('spawns nothing when git is not found', async () => {
    expect(readGit(tmp)).toBeNull();
    expect(await hardenedGit(tmp, ['status'], { harden: true, timeout: 1000 })).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('spawns nothing when jj is not found', () => {
    const d = path.join(tmp, 'jjrepo');
    fs.mkdirSync(path.join(d, '.jj'), { recursive: true });
    expect(readJj(d)!.change()).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('spawns the resolved jj path', () => {
    h.current = 'C:\\jj\\jj.exe';
    const d = path.join(tmp, 'jjrepo');
    readJj(d)!.change();
    expect(h.calls.map((c) => c.file)).toEqual(['C:\\jj\\jj.exe']);
  });
});
