import type { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { openBrowser } from '../../src/commands/open.js';
import { safeCwd } from '../../src/data/jobs/runner.js';

type Call = { cmd: string; args: string[]; opts: Record<string, unknown> };

function fake(): { calls: Call[]; run: typeof spawn } {
  const calls: Call[] = [];
  const run = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() {} };
  }) as unknown as typeof spawn;
  return { calls, run };
}

describe('openBrowser', () => {
  it('win32 starts cmd from a safe folder and escapes &', () => {
    const f = fake();
    openBrowser('http://x/?a=1&b=2', { platform: 'win32', spawn: f.run });
    const c = f.calls[0]!;
    expect(c.cmd).toBe('cmd');
    expect(c.args[0]).toBe('/c');
    expect(c.args[1]).toBe('start');
    expect(c.args[3]).toContain('^&');
    expect(c.opts.cwd).toBe(safeCwd());
    expect(c.opts.windowsHide).toBe(true);
    expect(c.opts.windowsVerbatimArguments).toBe(true);
  });

  it('darwin and linux carry no cwd', () => {
    for (const [platform, cmd] of [
      ['darwin', 'open'],
      ['linux', 'xdg-open'],
    ] as const) {
      const f = fake();
      openBrowser('http://x/', { platform, spawn: f.run });
      expect(f.calls[0]!.cmd).toBe(cmd);
      expect('cwd' in f.calls[0]!.opts).toBe(false);
    }
  });

  it('does not propagate a throwing spawn', () => {
    const run = (() => {
      throw new Error('boom');
    }) as unknown as typeof spawn;
    expect(() => openBrowser('http://x/', { platform: 'linux', spawn: run })).not.toThrow();
  });
});
