import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setup = vi.fn(() => ({ command: 'ccinfobar', onPath: true }));

vi.mock('../../src/data/update-state.js', async (orig) => ({
  ...(await orig<typeof import('../../src/data/update-state.js')>()),
  installKind: () => 'npx',
}));
vi.mock('../../src/commands/install.js', async (orig) => ({
  ...(await orig<typeof import('../../src/commands/install.js')>()),
  globalBinary: () => null,
  setupCommand: () => setup(),
}));

const { defaultConfig } = await import('../../src/core/config.js');
const { runEffect } = await import('../../src/tui/index.js');
const { initialState } = await import('../../src/tui/state.js');

let dir: string;
let prevConfig: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-tui-npx-'));
  prevConfig = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'cfg');
  setup.mockClear();
});

afterEach(() => {
  if (prevConfig === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prevConfig;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('TUI install under npx', () => {
  it('plans without running npm setup', () => {
    const settings = path.join(dir, 'settings.json');
    const state = initialState(defaultConfig(), path.join(dir, 'config.json'));
    const action = runEffect(state, { kind: 'planInstall' }, { settingsFile: settings });
    expect(action.type).toBe('installPlanned');
    expect(setup).not.toHaveBeenCalled();
    expect(fs.existsSync(settings)).toBe(false);
  });

  it('runs setup only after confirm and writes the real command', () => {
    const settings = path.join(dir, 'settings.json');
    const state = initialState(defaultConfig(), path.join(dir, 'config.json'));
    const planned = runEffect(state, { kind: 'planInstall' }, { settingsFile: settings });
    if (planned.type !== 'installPlanned') throw new Error('no plan');
    const done = runEffect(
      state,
      { kind: 'install', plan: planned.plan, confirmed: true },
      { settingsFile: settings },
    );
    expect(done).toMatchObject({ type: 'effectDone', ok: true });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command).toBe('ccinfobar');
  });
});
