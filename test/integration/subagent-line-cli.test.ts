import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { visibleWidth } from '../../src/core/width.js';
import { skipDist } from '../dist.js';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const fixture = fs.readFileSync(path.join(root, 'test/fixtures/subagent-payload.json'), 'utf8');

const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT ?? os.tmpdir(), 'ccib-subagent-'));
const cache = path.join(dir, 'cache');
fs.mkdirSync(cache, { recursive: true });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function env(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.join(dir, 'home'),
    USERPROFILE: path.join(dir, 'home'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
    CCINFOBAR_CACHE_DIR: cache,
    CCINFOBAR_NO_UPDATE: '1',
    CCINFOBAR_NO_USAGE_API: '1',
    NO_COLOR: '1',
    ...over,
  };
}

const run = (input: string, args = ['subagent-line'], over: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [bin, ...args], { input, env: env(over), encoding: 'utf8' });

describe.skipIf(skipDist)('ccinfobar subagent-line (dist)', () => {
  it('prints NDJSON rows fitted to columns', () => {
    const r = run(fixture);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const rows = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: string; content: string });
    expect(rows.map((x) => x.id)).toEqual(['task-run', 'task-done', 'task-fail', 'task-old']);
    for (const x of rows) expect(visibleWidth(x.content)).toBeLessThanOrEqual(80);
    expect(fs.readdirSync(cache)).toEqual([]);
  });

  it('is identical under tr', () => {
    const en = run(fixture, ['subagent-line'], { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });
    const tr = run(fixture, ['subagent-line'], { LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' });
    expect(tr.stdout).toBe(en.stdout);
    expect(en.stdout).not.toBe('');
  });

  it('prints nothing on garbage and empty input', () => {
    for (const input of ['garbage', '']) {
      const r = run(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('caps oversized stdin', () => {
    const t = Date.now();
    const r = run(`{"tasks":[${' '.repeat(2 * 1024 * 1024)}`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('takes --config before the command', () => {
    const cfg = path.join(dir, 'fields.json');
    fs.writeFileSync(cfg, JSON.stringify({ subagentLine: { fields: ['label'] }, charset: 'text' }));
    const r = run(fixture, ['--config', cfg, 'subagent-line']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.split('\n')[0]!).content).toBe('Reading src/widgets');
    expect(fs.readdirSync(cache)).toEqual([]);
  });
});
