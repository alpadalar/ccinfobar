import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { brokenConfigMessage, runEffect, runTui } from '../../src/tui/index.js';
import { initialState } from '../../src/tui/state.js';

const BROKEN = '{\n  "lines": [,]\n}';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-tui-broken-'));
  file = path.join(dir, 'config.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('brokenConfigMessage', () => {
  it('formats the location', () => {
    const issue = { kind: 'parse' as const, line: 3, column: 5, message: 'Trailing comma' };
    expect(brokenConfigMessage({ issue, path: '/x/config.json' })).toBe(
      t('tui.configBroken', { file: '/x/config.json', line: 3, column: 5, message: 'Trailing comma' }),
    );
  });

  it('is null without an issue', () => {
    expect(brokenConfigMessage({ path: '/x/config.json' })).toBeNull();
  });
});

describe('TUI with a broken config', () => {
  it('save effect fails with the location and keeps the bytes', () => {
    fs.writeFileSync(file, BROKEN);
    const before = fs.readFileSync(file);
    const out = runEffect(initialState(defaultConfig(), file), { kind: 'save' });
    expect(out).toMatchObject({ type: 'effectDone', ok: false });
    const message = (out as { message: string }).message;
    expect(message).toContain(file);
    expect(message).toContain('line 2');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('install effect fails before touching settings', () => {
    fs.writeFileSync(file, BROKEN);
    const before = fs.readFileSync(file);
    const out = runEffect(initialState(defaultConfig(), file), { kind: 'install', confirmed: true });
    expect(out).toMatchObject({ type: 'effectDone', ok: false });
    expect((out as { message: string }).message).toContain('line 2');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR ?? '', 'settings.json'))).toBe(false);
  });

  it('runTui refuses to start, prints the location and exits 1', async () => {
    fs.writeFileSync(file, BROKEN);
    const before = fs.readFileSync(file);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runTui({ configPath: file });
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledTimes(1);
    const printed = String(err.mock.calls[0]?.[0]);
    expect(printed).toContain(file);
    expect(printed).toContain('line 2');
    expect(printed).not.toContain('interactive terminal');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});
