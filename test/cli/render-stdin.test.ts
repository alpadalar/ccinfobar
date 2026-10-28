import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { readStdin, runRender } from '../../src/cli/render.js';
import { defaultConfig } from '../../src/core/config.js';
import { en } from '../../src/core/i18n/en/index.js';
import { bin, skipDist } from '../dist.js';

function stream() {
  const unref = vi.fn();
  return Object.assign(new PassThrough(), { unref });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readStdin', () => {
  it('resolves null past the cap and releases the stream', async () => {
    const s = stream();
    const p = readStdin(3000, 1024, s);
    for (let i = 0; i < 8; i++) s.write(Buffer.alloc(256, 'a'));
    expect(await p).toBeNull();
    expect(s.listenerCount('data')).toBe(0);
    expect(s.listenerCount('end')).toBe(0);
    expect(s.listenerCount('error')).toBe(1);
    expect(s.isPaused()).toBe(true);
    expect(s.unref).toHaveBeenCalledTimes(1);
  });

  it('swallows a late error after the cap', async () => {
    const s = stream();
    const p = readStdin(3000, 1024, s);
    for (let i = 0; i < 8; i++) s.write(Buffer.alloc(256, 'a'));
    expect(await p).toBeNull();
    expect(() => s.emit('error', new Error('late'))).not.toThrow();
    expect(s.listenerCount('error')).toBe(1);
  });

  it('swallows a late error after the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = stream();
    const p = readStdin(3000, 1024, s);
    s.write('par');
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe('par');
    expect(() => s.emit('error', new Error('late'))).not.toThrow();
    expect(s.listenerCount('error')).toBe(1);
  });

  it('returns the text at end', async () => {
    const s = stream();
    const p = readStdin(3000, 1024, s);
    s.write('{"a":1}');
    s.end();
    expect(await p).toBe('{"a":1}');
  });

  it('keeps multi-byte text split across chunks intact', async () => {
    const s = stream();
    const p = readStdin(3000, 1024, s);
    const bytes = Buffer.from('{"a":"çğı€"}');
    for (let i = 0; i < bytes.length; i += 3) s.write(bytes.subarray(i, i + 3));
    s.end();
    expect(await p).toBe('{"a":"çğı€"}');
  });

  it('resolves what it has at the timeout and releases the stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = stream();
    const p = readStdin(3000, 1024, s);
    s.write('par');
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe('par');
    expect(s.listenerCount('data')).toBe(0);
    expect(s.isPaused()).toBe(true);
    expect(s.unref).toHaveBeenCalledTimes(1);
  });

  it('resolves what it has on an error event', async () => {
    const s = stream();
    const p = readStdin(3000, 1024, s);
    s.write('half');
    await new Promise((r) => setImmediate(r));
    s.emit('error', new Error('boom'));
    expect(await p).toBe('half');
  });
});

describe('runRender stdin cap', () => {
  it('prints the invalid message for a 5 MiB payload and exits 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-stdin-'));
    const cfgFile = path.join(dir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(defaultConfig()));
    vi.stubEnv('CCINFOBAR_CONFIG_DIR', dir);
    vi.stubEnv('CCINFOBAR_CACHE_DIR', dir);
    vi.stubEnv('CCINFOBAR_NO_UPDATE', '1');
    const s = stream();
    const orig = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: s, configurable: true });
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.exitCode = undefined;
      const chunk = Buffer.alloc(65536, 'x');
      for (let i = 0; i < 80; i++) s.write(chunk);
      await runRender(parseArgs([]), cfgFile);
      expect(out.mock.calls.map((c) => String(c[0])).join('')).toBe(`${en['cli.invalidJson']}\n`);
      expect(process.exitCode).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'stdin', orig);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(skipDist)('dist stdin', () => {
  async function run(feed: (child: ChildProcess) => void): Promise<{ code: number | null; out: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-stdin-dist-'));
    const child = spawn(process.execPath, [bin], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CCINFOBAR_CONFIG_DIR: path.join(dir, 'cfg'),
        CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
        CCINFOBAR_NO_UPDATE: '1',
      },
    });
    try {
      let out = '';
      child.stdout!.on('data', (d) => {
        out += d;
      });
      child.stderr!.on('data', () => {});
      child.stdin!.on('error', () => {});
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      feed(child);
      return { code: await exited, out };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits after the timeout when stdin never closes', async () => {
    const r = await run(() => {});
    expect(r.code).toBe(0);
  }, 60_000);

  it('answers a 5 MiB payload with the invalid message and exit 0', async () => {
    const r = await run((child) => {
      const chunk = Buffer.from(`{"a":"${'x'.repeat(65530)}`);
      for (let i = 0; i < 80; i++) child.stdin!.write(chunk);
      child.stdin!.end();
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(en['cli.invalidJson']);
  }, 60_000);
});
