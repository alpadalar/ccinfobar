import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipDist } from '../dist.js';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const payload = fs.readFileSync(path.join(root, 'test/fixtures/payload.json'), 'utf8');
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/ /g, ' ');

function run(args: string[], env: Record<string, string> = {}, input = payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-int-'));
  const res = spawnSync(process.execPath, [bin, ...args], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      CCINFOBAR_CONFIG_DIR: dir,
      CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
      NO_COLOR: '',
      FORCE_COLOR: '2',
      COLUMNS: '200',
      TERM_PROGRAM: '',
      CCINFOBAR_NO_JOBS: '1',
      ...env,
    },
  });
  return { ...res, dir, out: strip(res.stdout ?? '') };
}

describe.skipIf(skipDist)('built cli', () => {
  it('renders context, token and usage widgets from the payload', () => {
    const init = run(['init', 'cockpit']);
    expect(init.status).toBe(0);
    const res = spawnSync(process.execPath, [bin], {
      input: payload,
      encoding: 'utf8',
      env: {
        ...process.env,
        CCINFOBAR_CONFIG_DIR: init.dir,
        CCINFOBAR_CACHE_DIR: path.join(init.dir, 'c'),
        CCINFOBAR_NO_JOBS: '1',
        COLUMNS: '200',
      },
    });
    const out = strip(res.stdout);
    expect(res.status).toBe(0);
    for (const s of [
      'Opus 5.5',
      'Ctx ',
      '34%',
      'Tokens 450',
      '5h Limit: 42%',
      'Weekly Limit: 61%',
      'Hit 94%',
    ]) {
      expect(out).toContain(s);
    }
  });

  it('prints no Nerd Font glyphs in Apple Terminal by default', () => {
    for (const theme of ['powerline', 'nord', 'catppuccin', 'rose-pine']) {
      const init = run(['init', 'powerline']);
      fs.writeFileSync(
        path.join(init.dir, 'config.json'),
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(path.join(init.dir, 'config.json'), 'utf8')),
          theme,
          icons: 'nerd',
        }),
      );
      const res = spawnSync(process.execPath, [bin], {
        input: payload,
        encoding: 'utf8',
        env: {
          ...process.env,
          CCINFOBAR_CONFIG_DIR: init.dir,
          CCINFOBAR_CACHE_DIR: path.join(init.dir, 'c'),
          TERM_PROGRAM: 'Apple_Terminal',
          COLUMNS: '200',
        },
      });
      expect(res.stdout.length).toBeGreaterThan(0);
      expect(res.stdout).not.toMatch(/[-]/);
    }
  });

  it('prints nothing for empty input and survives bad JSON', () => {
    expect(run([], {}, '\n').status).toBe(0);
    const bad = run([], {}, 'nope');
    expect(bad.status).toBe(0);
    expect(bad.out).toContain('invalid JSON');
  });

  it('prints explain --json as one object', () => {
    const res = run(['explain', '--json']);
    expect(res.status).toBe(0);
    const obj = JSON.parse(res.stdout);
    expect(obj.schema).toBe(1);
    expect(Array.isArray(obj.widgets)).toBe(true);
  });

  it('explains hidden widgets in doctor', () => {
    const res = run(['doctor']);
    expect(res.status).toBe(0);
    expect(res.out).toContain('Node.js');
    expect(res.out).toContain('Widgets');
  });
});
