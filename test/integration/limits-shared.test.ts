import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/ /g, ' ');

const CONFIG = {
  lines: [[{ type: 'five-hour-usage' }, { type: 'five-hour-reset' }, { type: 'weekly-usage' }]],
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-limits-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'claude'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(CONFIG));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sec = (ms: number) => Math.floor(ms / 1000);

function transcript(id: string, ageMs: number): string {
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
  return file;
}

type Win = { used_percentage: number; resets_at: number };

function render(id: string, file: string, limits: Record<string, Win>, env: Record<string, string> = {}) {
  const payload = {
    session_id: id,
    transcript_path: file,
    cwd: dir,
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    rate_limits: limits,
  };
  const res = spawnSync(process.execPath, [bin], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      USERPROFILE: dir,
      CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
      CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
      CCINFOBAR_NO_USAGE_API: '1',
      CCINFOBAR_NO_JOBS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      NO_COLOR: '',
      FORCE_COLOR: '0',
      COLUMNS: '200',
      ...env,
    },
  });
  expect(res.status).toBe(0);
  return strip(res.stdout ?? '');
}

describe.skipIf(!fs.existsSync(bin))('shared limits', () => {
  it('shows the active session value in an idle session', () => {
    const now = Date.now();
    const a = transcript('a', 60_000);
    const b = transcript('b', 3 * 3_600_000);
    const week = { used_percentage: 20, resets_at: sec(now + 3 * 86_400_000) };
    render('sess-a', a, {
      five_hour: { used_percentage: 70, resets_at: sec(now + 7_200_000) },
      seven_day: week,
    });
    const idle = { five_hour: { used_percentage: 40, resets_at: sec(now + 7_380_000) }, seven_day: week };
    const out = render('sess-b', b, idle);
    expect(out).toContain('70%');
    expect(out).not.toContain('40%');
    expect(render('sess-b', b, idle)).toContain('70%');
  });

  it('never shows an expired window again and accepts the new one', async () => {
    const a = transcript('a', 1000);
    const resets = sec(Date.now() + 2000) + 1;
    const week = { used_percentage: 30, resets_at: sec(Date.now() + 3 * 86_400_000) };
    expect(
      render('sess-a', a, { five_hour: { used_percentage: 73, resets_at: resets }, seven_day: week }),
    ).toContain('73%');
    while (Date.now() <= resets * 1000 + 100) await new Promise((r) => setTimeout(r, 100));
    const out = render('sess-a', a, {
      five_hour: { used_percentage: 73, resets_at: resets },
      seven_day: week,
    });
    expect(out).not.toContain('73%');
    expect(out).toContain('30%');
    const c = transcript('c', 0);
    const fresh = { five_hour: { used_percentage: 5, resets_at: sec(Date.now() + 5 * 3_600_000 - 60_000) } };
    expect(render('sess-c', c, { ...fresh, seven_day: week })).toContain('5%');
  });

  it('keeps provider sessions out of the store', () => {
    const now = Date.now();
    const a = transcript('a', 1000);
    const limits = {
      five_hour: { used_percentage: 70, resets_at: sec(now + 7_200_000) },
      seven_day: { used_percentage: 20, resets_at: sec(now + 3 * 86_400_000) },
    };
    render('sess-a', a, limits, { ANTHROPIC_API_KEY: 'sk-test' });
    render('sess-a', a, limits, { CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(fs.existsSync(path.join(dir, 'cache', 'limits'))).toBe(false);
  });

  it('keeps two config dirs sharing a cache dir apart', () => {
    const now = Date.now();
    for (const d of ['claude-a', 'claude-b', 'claude-c']) fs.mkdirSync(path.join(dir, d));
    fs.mkdirSync(path.join(dir, 'cache'));
    const legacy = { fetchedAt: now, rate_limits: { five_hour: { used_percentage: 55, resets_at: null } } };
    fs.writeFileSync(path.join(dir, 'cache', 'usage.json'), JSON.stringify(legacy));
    const as = (d: string) => ({
      CLAUDE_CONFIG_DIR: path.join(dir, d),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(dir, d),
      CCINFOBAR_NO_USAGE_API: '',
    });
    const a = transcript('a', 1000);
    const b = transcript('b', 1000);
    const week = { used_percentage: 1, resets_at: sec(now + 3 * 86_400_000) };
    const five = (pct: number) => ({ used_percentage: pct, resets_at: sec(now + 7_200_000) });
    expect(render('sess-a', a, { five_hour: five(71), seven_day: week }, as('claude-a'))).toContain('71%');
    const outB = render('sess-b', b, { five_hour: five(32), seven_day: week }, as('claude-b'));
    expect(outB).toContain('32%');
    expect(outB).not.toContain('71%');
    const idleA = render('sess-a', a, {}, as('claude-a'));
    expect(idleA).toContain('71%');
    expect(idleA).not.toMatch(/32%|55%/);
    const idleB = render('sess-b', b, {}, as('claude-b'));
    expect(idleB).toContain('32%');
    expect(idleB).not.toMatch(/71%|55%/);
    expect(render('sess-c', b, {}, as('claude-c'))).not.toMatch(/71%|32%|55%/);
    expect(fs.readFileSync(path.join(dir, 'cache', 'usage.json'), 'utf8')).toBe(JSON.stringify(legacy));
  });

  it('writes the store for a first-party session', () => {
    const now = Date.now();
    const a = transcript('a', 1000);
    render('sess-a', a, { five_hour: { used_percentage: 70, resets_at: sec(now + 7_200_000) } });
    const files = fs.existsSync(path.join(dir, 'cache', 'limits'))
      ? fs.readdirSync(path.join(dir, 'cache', 'limits'))
      : [];
    expect(files.some((f) => /^[0-9a-f]{16}\.json$/.test(f))).toBe(true);
  });
});
