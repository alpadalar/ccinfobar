import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { renderStatus, runRender } from '../../src/cli/render.js';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { samplePayload } from '../../src/core/sample.js';
import type { Config, StatusPayload } from '../../src/core/types.js';

const probe = vi.hoisted(() => ({ terminalWidth: vi.fn(), cachedTerminalWidth: vi.fn() }));

vi.mock('../../src/data/terminal.js', async (orig) => ({
  ...(await orig<typeof import('../../src/data/terminal.js')>()),
  terminalWidth: probe.terminalWidth,
  cachedTerminalWidth: probe.cachedTerminalWidth,
}));

const cfg = (extra: Partial<Config> = {}): Config => ({
  ...defaultConfig(),
  autoWrap: false,
  lines: [
    [
      { id: 'm', type: 'model' },
      { id: 'c', type: 'cwd' },
    ],
  ],
  ...extra,
});

function payload(extra: Partial<StatusPayload> = {}): StatusPayload {
  const p = samplePayload();
  delete p.terminal_width;
  delete p.columns;
  return { ...p, workspace: { current_dir: `/home/${'long-directory/'.repeat(8)}x` }, ...extra };
}

beforeEach(() => {
  vi.stubEnv('COLUMNS', '');
  delete process.env.COLUMNS;
  probe.terminalWidth.mockReset().mockReturnValue(40);
  probe.cachedTerminalWidth.mockReset().mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('render width probing', () => {
  it('probes once and truncates for an implicit-truncate layout', () => {
    const p = payload();
    const lines = renderStatus(cfg(), p);
    expect(probe.terminalWidth).toHaveBeenCalledTimes(1);
    expect(probe.terminalWidth).toHaveBeenCalledWith(p.session_id, undefined);
    expect(probe.cachedTerminalWidth).not.toHaveBeenCalled();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(visibleWidth(stripAnsi(l))).toBeLessThanOrEqual(40);
  });

  it('never probes with a numeric maxWidth', () => {
    renderStatus(cfg({ maxWidth: 80 }), payload());
    expect(probe.terminalWidth).not.toHaveBeenCalled();
    expect(probe.cachedTerminalWidth).toHaveBeenCalledTimes(1);
  });

  it('passes the payload width as the hint', () => {
    const p = payload({ terminal_width: 50 });
    renderStatus(cfg(), p);
    expect(probe.terminalWidth).toHaveBeenCalledWith(p.session_id, 50);
  });
});

describe('render --width validation', () => {
  it('prints a usage error and no status line for a bad --width', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-rw-'));
    const file = path.join(dir, 'payload.json');
    fs.writeFileSync(file, JSON.stringify(samplePayload()));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.exitCode = undefined;
      await runRender(parseArgs(['--payload', file, '--width', 'abc']), path.join(dir, 'config.json'));
      expect(out).not.toHaveBeenCalled();
      expect(String(err.mock.calls[0]?.[0])).toMatch(/^✗ --width needs a whole number/);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      out.mockRestore();
      err.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
