import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachedTerminalWidth, type TerminalDeps, terminalWidth } from '../../src/data/terminal.js';

let dir = '';
let clock = 1_000_000;
let calls: string[] = [];

function deps(over: Partial<TerminalDeps> = {}): TerminalDeps {
  return {
    run: (cmd) => {
      calls.push(cmd);
      return cmd === 'ps' ? '1 pts/3' : '40 120';
    },
    openTty: () => null,
    platform: 'linux',
    now: () => clock,
    env: { CCINFOBAR_CACHE_DIR: dir },
    stdoutColumns: () => null,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-term-'));
  clock = 1_000_000;
  calls = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('terminalWidth', () => {
  it('probes once and reuses the width for 60 s', () => {
    expect(terminalWidth('s', undefined, deps())).toBe(120);
    expect(calls.length).toBeGreaterThan(0);
    const n = calls.length;
    clock += 30_000;
    expect(terminalWidth('s', undefined, deps())).toBe(120);
    expect(calls.length).toBe(n);
    clock += 31_000;
    terminalWidth('s', undefined, deps());
    expect(calls.length).toBeGreaterThan(n);
  });

  it('remembers a failed probe for 10 minutes', () => {
    const failing = deps({
      run: (cmd) => {
        calls.push(cmd);
        return null;
      },
    });
    expect(terminalWidth('s', undefined, failing)).toBeNull();
    const file = path.join(dir, 'width-s.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).width).toBeNull();
    const n = calls.length;
    clock += 5 * 60_000;
    expect(terminalWidth('s', undefined, failing)).toBeNull();
    expect(calls.length).toBe(n);
    clock += 6 * 60_000;
    terminalWidth('s', undefined, failing);
    expect(calls.length).toBeGreaterThan(n);
  });

  it('prefers the tty fast path without spawning', () => {
    expect(terminalWidth('s', undefined, deps({ openTty: () => 132 }))).toBe(132);
    expect(calls).toEqual([]);
  });

  it('uses the hint without probing or reading the cache', () => {
    expect(terminalWidth('s', 99, deps())).toBe(99);
    expect(calls).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('uses COLUMNS without probing', () => {
    const env = { CCINFOBAR_CACHE_DIR: dir, COLUMNS: '77' };
    expect(terminalWidth('s', undefined, deps({ env }))).toBe(77);
    expect(calls).toEqual([]);
  });

  it('does not probe on win32', () => {
    let tried = 0;
    const d = deps({
      platform: 'win32',
      openTty: () => {
        tried++;
        return 100;
      },
    });
    expect(terminalWidth('s', undefined, d)).toBeNull();
    expect(calls).toEqual([]);
    expect(tried).toBe(0);
  });
});

describe('cachedTerminalWidth', () => {
  it('never spawns and ignores the age', () => {
    expect(cachedTerminalWidth('s', undefined, deps())).toBeNull();
    terminalWidth('s', undefined, deps());
    const n = calls.length;
    clock += 24 * 3_600_000;
    expect(cachedTerminalWidth('s', undefined, deps())).toBe(120);
    expect(calls.length).toBe(n);
  });
});
