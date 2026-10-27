import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStatus } from '../../src/cli/render.js';
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
