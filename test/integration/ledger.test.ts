import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/ /g, ' ');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ledger-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'claude'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function useConfig(types: string[]): void {
  const config = { lines: [types.map((type) => ({ type }))] };
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(config));
}

function render(session: string, c: number): string {
  const payload = {
    session_id: session,
    cwd: dir,
    workspace: { current_dir: dir, project_dir: dir },
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    cost: { total_cost_usd: c, total_duration_ms: 60_000 },
  };
  const res = spawnSync(process.execPath, [bin], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      USERPROFILE: dir,
      APPDATA: path.join(dir, 'appdata'),
      LOCALAPPDATA: path.join(dir, 'localappdata'),
      XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
      XDG_CACHE_HOME: path.join(dir, 'xdg-cache'),
      CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
      CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
      CCINFOBAR_NO_USAGE_API: '1',
      CCINFOBAR_NO_JOBS: '1',
      CCINFOBAR_NO_UPDATE: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      NO_COLOR: '',
      FORCE_COLOR: '0',
      COLUMNS: '200',
    },
  });
  expect(res.status).toBe(0);
  return strip(res.stdout ?? '');
}

function month(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function awayFromMidnight(): Promise<void> {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const left = next - now.getTime();
  if (left < 120_000) await new Promise((r) => setTimeout(r, left + 1000));
}

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// resume, /clear, fork, a second terminal and /login
const RENDERS: [string, number][] = [
  ['sess-a', 0],
  ['sess-a', 1.2],
  ['sess-b', 0],
  ['sess-b', 0.5],
  ['sess-a', 1.2],
  ['sess-a', 2.0],
  ['sess-c', 0],
  ['sess-c', 0.3],
  ['sess-d', 2.0],
  ['sess-e', 0],
  ['sess-e', 1.0],
  ['sess-e', 0.6],
  ['sess-e', 1.1],
  ['sess-e', 0.7],
  ['sess-f', 0.8],
  ['sess-f', 0],
  ['sess-f', 0.4],
];

describe.skipIf(!fs.existsSync(bin))('cost ledger', () => {
  it('counts every session today once', { timeout: 240_000 }, async () => {
    await awayFromMidnight();
    useConfig(['cost-today']);
    let out = '';
    for (const [s, c] of RENDERS) out = render(s, c);
    // A 2.00 + B 0.50 + C 0.30 + D 0 + E 1.20 + F 0.40
    expect(out).toContain('Today ~$4.40');
    const file = path.join(dir, 'cache', 'ledger', `${month(Date.now())}.jsonl`);
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    // the unchanged resume adds no line
    expect(lines.length).toBe(RENDERS.length - 1);
    const names = walk(path.join(dir, 'cache', 'ledger')).map((f) => path.basename(f));
    expect(names.sort()).toEqual([`${month(Date.now())}.jsonl`, 'summary.json']);
  });

  it('writes nothing without a ledger widget', () => {
    useConfig(['session-cost']);
    render('sess-a', 0);
    render('sess-a', 1.2);
    expect(fs.existsSync(path.join(dir, 'cache', 'ledger'))).toBe(false);
  });
});
