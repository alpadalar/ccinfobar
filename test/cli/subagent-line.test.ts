import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subagentMain } from '../../src/cli/subagent-line.js';
import { configPath } from '../../src/core/paths.js';
import { NORMAL_WIDTH, setWidthMode, visibleWidth } from '../../src/core/width.js';
import { withLangAsync, withoutSideEffectsAsync } from '../helpers.js';

const fixture = fs.readFileSync(path.resolve(__dirname, '../fixtures/subagent-payload.json'), 'utf8');
const START = 1700000000000;

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT ?? os.tmpdir(), 'subagent-line-'));
  env = {
    CCINFOBAR_CONFIG_DIR: path.join(tmp, 'cfg'),
    CCINFOBAR_CACHE_DIR: path.join(tmp, 'cache'),
    NO_COLOR: '1',
  };
  fs.mkdirSync(env.CCINFOBAR_CONFIG_DIR!, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function run(input: string | null, argv: string[] = [], over: Partial<typeof env> = {}) {
  let out = '';
  await subagentMain(argv, {
    read: async () => input,
    write: (s) => {
      out += s;
    },
    env: { ...env, ...over },
    now: () => START + 180_000,
  });
  return out;
}

const lines = (out: string) =>
  out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; content: string });

describe('subagent-line', () => {
  it('prints one NDJSON line per task with an id', async () => {
    const out = await run(fixture);
    expect(out.endsWith('\n')).toBe(true);
    const rows = lines(out);
    expect(rows.map((r) => r.id)).toEqual(['task-run', 'task-done', 'task-fail', 'task-old']);
    for (const r of rows) {
      expect(typeof r.content).toBe('string');
      expect(r.content).not.toContain('\n');
      expect(visibleWidth(r.content)).toBeLessThanOrEqual(80);
    }
    expect(rows[0]!.content).toContain('Explore');
    expect(rows[0]!.content).toContain('3m');
  });

  it('fits columns, falls back to 120 without them', async () => {
    const narrow = JSON.stringify({ ...JSON.parse(fixture), columns: 30 });
    for (const r of lines(await run(narrow))) expect(visibleWidth(r.content)).toBeLessThanOrEqual(30);
    const { columns: _c, ...rest } = JSON.parse(fixture);
    for (const r of lines(await run(JSON.stringify(rest))))
      expect(visibleWidth(r.content)).toBeLessThanOrEqual(120);
  });

  it('writes nothing on bad input', async () => {
    for (const bad of [null, '', 'not json', '[]', '{"tasks":"x"}', '{'.repeat(10)]) {
      const write = vi.fn();
      await subagentMain([], { read: async () => bad, write, env });
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('skips non-string ids and survives garbage fields', async () => {
    const out = await run(
      JSON.stringify({
        columns: 60,
        tasks: [
          { id: 7, status: 'running' },
          { id: 'g', status: 5, tokenCount: 'x', startTime: {}, label: 3 },
        ],
      }),
    );
    const rows = lines(out);
    expect(rows.map((r) => r.id)).toEqual(['g']);
    expect(typeof rows[0]!.content).toBe('string');
  });

  it('emits no line for a task whose row is empty', async () => {
    fs.writeFileSync(configPath(env), JSON.stringify({ subagentLine: { fields: ['label'] } }));
    const out = await run(
      JSON.stringify({
        columns: 60,
        tasks: [
          { id: 'empty', status: 'running' },
          { id: 'full', label: 'Reading' },
        ],
      }),
    );
    expect(lines(out).map((r) => r.id)).toEqual(['full']);
    expect(await run(JSON.stringify({ columns: 60, tasks: [{ id: 'empty' }] }))).toBe('');
  });

  it('measures with the configured ambiguous width and restores the mode', async () => {
    fs.writeFileSync(
      configPath(env),
      JSON.stringify({ ambiguousWidth: 2, subagentLine: { fields: ['label'] } }),
    );
    const out = await run(JSON.stringify({ columns: 30, tasks: [{ id: 'a', label: '\u03a9'.repeat(40) }] }));
    setWidthMode({ emoji: 2, ambiguous: 2 });
    const wide = visibleWidth(lines(out)[0]!.content);
    setWidthMode(NORMAL_WIDTH);
    expect(wide).toBeLessThanOrEqual(30);
    expect(visibleWidth(lines(out)[0]!.content)).toBeLessThan(wide);
  });

  it('strips escape sequences from task text', async () => {
    const out = await run(
      JSON.stringify({
        columns: 80,
        tasks: [{ id: 'a', status: 'running', label: 'x\x1b]8;;http://evil\x07y' }],
      }),
    );
    expect(out).not.toContain('\\u001b');
    expect(lines(out)[0]!.content).not.toContain('\x1b');
  });

  it('honours fields and charset from the config', async () => {
    fs.writeFileSync(
      configPath(env),
      JSON.stringify({ subagentLine: { fields: ['status', 'label'] }, charset: 'text' }),
    );
    const first = lines(await run(fixture))[0]!;
    expect(first.content).toBe('> | Reading src/widgets');
  });

  it('prefers --config over the default path', async () => {
    fs.writeFileSync(configPath(env), JSON.stringify({ subagentLine: { fields: ['type'] } }));
    const other = path.join(tmp, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ subagentLine: { fields: ['label'] } }));
    expect(lines(await run(fixture, ['--config', other]))[0]!.content).toBe('Reading src/widgets');
    expect(lines(await run(fixture))[0]!.content).toBe('Explore');
  });

  it('reads only the config file and does nothing else', async () => {
    const other = path.join(tmp, 'other.json');
    fs.writeFileSync(other, '{}');
    const reads = vi.spyOn(fs, 'readFileSync');
    const spies = [
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'mkdirSync'),
      vi.spyOn(cp, 'spawn'),
      vi.spyOn(cp, 'execFile'),
      vi.spyOn(cp, 'spawnSync'),
    ];
    await withoutSideEffectsAsync(async () => {
      await run(fixture);
      await run(fixture, ['--config', other]);
    });
    const files = reads.mock.calls.map((c) => String(c[0]));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect([configPath(env), other]).toContain(f);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('prints the same under en and tr', async () => {
    const en = await withLangAsync('en', () => run(fixture));
    const tr = await withLangAsync('tr', () => run(fixture));
    expect(en).not.toBe('');
    expect(tr).toBe(en);
  });
});
