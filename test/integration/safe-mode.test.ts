import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const payload = fs.readFileSync(path.join(root, 'test/fixtures/payload.json'), 'utf8');
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');

function run(args: string[], config?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-safe-'));
  const file = path.join(dir, 'config.json');
  if (config !== undefined) fs.writeFileSync(file, config);
  const res = spawnSync(process.execPath, [bin, ...args, '--config', file], {
    input: payload,
    encoding: 'utf8',
    env: {
      ...process.env,
      CCINFOBAR_CONFIG_DIR: dir,
      CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
      CCINFOBAR_NO_UPDATE: '1',
      CCINFOBAR_NO_USAGE_API: '1',
      NO_COLOR: '',
      FORCE_COLOR: '2',
      COLUMNS: '200',
    },
  });
  const bytes = config === undefined ? null : fs.readFileSync(file, 'utf8');
  return { ...res, dir, file, bytes, out: strip(res.stdout ?? '') };
}

const BROKEN = '{\n  "lines": [\n    [{"type":"model"}],\n  ]\n}';

describe.skipIf(!fs.existsSync(bin))('safe mode', () => {
  it('prints one config error line with exit 0', () => {
    const res = run([], BROKEN);
    expect(res.out).toBe('ccinfobar: config error at line 4, run ccinfobar doctor\n');
    expect(res.status).toBe(0);
  });

  it('dims the line when colour is on', () => {
    expect(run([], BROKEN).stdout).toContain('\u001b[');
  });

  it('flags lines that is not an array', () => {
    const res = run([], '{"lines":{}}');
    expect(res.out).toBe('ccinfobar: config error at line 1, run ccinfobar doctor\n');
    expect(res.status).toBe(0);
  });

  it('renders normally with a BOM', () => {
    const res = run([], '﻿{"version":1,"lines":[[{"id":"m","type":"model"}]]}');
    expect(res.status).toBe(0);
    expect(res.out).toContain('Opus');
    expect(res.out).not.toContain('config error');
  });

  it('never rewrites the broken file during render', () => {
    expect(run([], BROKEN).bytes).toBe(BROKEN);
  });

  it('theme refuses a broken config', () => {
    const res = run(['theme', 'powerline'], BROKEN);
    expect(res.status).toBe(1);
    expect(res.bytes).toBe(BROKEN);
    expect(res.stderr).toContain('line 4, column 3');
  });

  it('prints a render error line instead of failing', () => {
    const res = run(['--payload', os.tmpdir()], '{"version":1,"lines":[[{"type":"model"}]]}');
    expect(res.out).toBe('ccinfobar: render error, run ccinfobar doctor\n');
    expect(res.status).toBe(0);
  });
});
