import cp from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import {
  type ExplainIo,
  explainJson,
  formatAge,
  loadInspectInput,
  runExplain,
  shortAge,
} from '../../src/commands/explain.js';
import { t } from '../../src/core/i18n/index.js';
import type { InspectRow } from '../../src/core/inspect.js';
import { cacheDir, configDir, lastPayloadPath } from '../../src/core/paths.js';
import { scenarioListLines } from '../../src/core/preview.js';
import type { StatusPayload } from '../../src/core/types.js';
import { VERSION } from '../../src/core/version.js';
import { agentsCacheName, readAgents } from '../../src/data/agents.js';
import { cacheFile } from '../../src/data/cache.js';
import { readTranscript, transcriptCacheName } from '../../src/data/transcript.js';
import { usageFile } from '../../src/data/usage.js';

const ESC = '\u001b';
const root = () => process.env.CCIB_TEST_ROOT!;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root(), 'explain-'));
  fs.rmSync(lastPayloadPath(), { force: true });
});

afterEach(() => {
  process.exitCode = undefined;
  fs.rmSync(lastPayloadPath(), { force: true });
  vi.restoreAllMocks();
  module.syncBuiltinESMExports();
});

function cfgFile(cfg: object = {}): string {
  fs.mkdirSync(configDir(), { recursive: true });
  const file = path.join(configDir(), 'explain-test.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
}

const LAYOUT = {
  lines: [
    [
      { id: 'model', type: 'model' },
      { id: 'ctx', type: 'context-percentage' },
      { id: 'flex', type: 'flex' },
      { id: 'branch', type: 'git-branch' },
    ],
    [
      { id: 'messages', type: 'message-count' },
      { id: 'graph', type: 'context-graph' },
      { id: 'nope', type: 'nope' },
    ],
  ],
};

function run(argv: string[], cfg: object = LAYOUT, tty = false): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: ExplainIo = { tty, log: (l) => out.push(l), error: (l) => err.push(l) };
  runExplain(parseArgs(['explain', ...argv]), cfgFile(cfg), io);
  return { out, err };
}

function transcriptFile(): string {
  const file = path.join(dir, 'session.jsonl');
  const line = (o: object) => JSON.stringify(o);
  fs.writeFileSync(
    file,
    [
      line({ type: 'user', timestamp: '2026-10-12T11:59:00Z', message: { content: 'hi' } }),
      line({
        type: 'assistant',
        timestamp: '2026-10-12T11:59:30Z',
        message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    ].join('\n'),
  );
  return file;
}

function savedPayload(extra: StatusPayload = {}): StatusPayload {
  const p: StatusPayload = {
    session_id: 'explain-test',
    version: '2.1.401',
    cwd: dir,
    workspace: { current_dir: dir },
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    transcript_path: transcriptFile(),
    context_window: {
      context_window_size: 200_000,
      used_percentage: 12,
      total_input_tokens: 10,
      total_output_tokens: 5,
    },
    cost: { total_cost_usd: 0.5 },
    ...extra,
  };
  fs.mkdirSync(path.dirname(lastPayloadPath()), { recursive: true });
  fs.writeFileSync(lastPayloadPath(), JSON.stringify(p));
  return p;
}

describe('runExplain input', () => {
  it('falls back to the sample with one notice', () => {
    const { out, err } = run([]);
    expect(err).toEqual([]);
    expect(out.filter((l) => l === t('explain.sampleNotice'))).toHaveLength(1);
    expect(out).toContain(t('explain.lineHeader', { line: 1 }));
    expect(out.some((l) => l.includes('model') && l.startsWith('  ✓'))).toBe(true);
  });

  it('uses the last payload with its age and Claude Code version', () => {
    savedPayload();
    const { out } = run([]);
    expect(out[1]).toMatch(/^Input: last payload from Claude Code 2\.1\.401, saved \d+s ago$/);
    expect(out.some((l) => l.includes('ctx (context-percentage): 12%'))).toBe(true);
  });

  it('uses a scenario', () => {
    savedPayload();
    const { out } = run(['--scenario', 'context-full']);
    expect(out[1]).toBe(t('explain.input.scenario', { name: 'context-full' }));
    const row = out.find((l) => l.includes('ctx (context-percentage)'))!;
    expect(row).toContain('94');
  });

  it('lists scenarios for a bare flag and rejects unknown names', () => {
    expect(run(['--scenario']).out).toEqual(scenarioListLines());
    expect(process.exitCode).toBeUndefined();
    const { out, err } = run(['--scenario', 'nope']);
    expect(out).toEqual([]);
    expect(err[0]).toBe(t('preview.unknownScenario', { name: 'nope' }));
    expect(err.slice(1)).toEqual(scenarioListLines().slice(1));
    expect(process.exitCode).toBe(1);
  });

  it('prefers --payload over --scenario and the last payload', () => {
    savedPayload();
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ model: { display_name: 'From File' } }));
    const { out } = run(['--payload', file, '--scenario', 'context-full']);
    expect(out[1]).toContain('Input: payload file');
    expect(out.some((l) => l.includes('From File'))).toBe(true);
  });

  it('reports a bad payload file', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '[1]');
    const { err } = run(['--payload', file]);
    expect(err[0]).toContain('is not a JSON object');
    expect(process.exitCode).toBe(1);
    run(['--payload', path.join(dir, 'missing.json')]);
    expect(process.exitCode).toBe(1);
  });
});

describe('runExplain table', () => {
  it('groups rows by line with id, type, value or reason and no escapes', () => {
    const { out } = run(['--scenario', 'no-git']);
    for (const l of out) expect(l).not.toContain(ESC);
    const l2 = out.indexOf(t('explain.lineHeader', { line: 2 }));
    expect(out.indexOf(t('explain.lineHeader', { line: 1 }))).toBeLessThan(l2);
    const branch = out.find((l) => l.includes('branch (git-branch)'))!;
    expect(branch).toContain(t('explain.reason.no-git'));
    expect(out.indexOf(branch)).toBeLessThan(l2);
    expect(out.find((l) => l.includes('nope'))).toContain(t('explain.reason.unknown-type', { type: 'nope' }));
    expect(out).toContain(t('explain.row.skipped', { name: 'flex' }));
  });

  it('notes a cut line', () => {
    const { out } = run(['--scenario', 'context-full', '--width', '20'], { ...LAYOUT, autoWrap: false });
    expect(out.some((l) => l.startsWith('  ⚠ Line 1 needs'))).toBe(true);
  });
});

describe('runExplain sources', () => {
  const rowOf = (out: string[], name: string) => out.find((l) => l.includes(`${name}:`))!;

  it('names the payload field for the sample', () => {
    const { out } = run([], { lines: [[{ id: 'context-percentage', type: 'context-percentage' }]] });
    const row = rowOf(out, 'context-percentage');
    expect(row).toMatch(/^ {2}✓ context-percentage: \d+% ← /);
    expect(row).toContain('payload: context_window.used_percentage');
  });

  it('shows git, system and GSD sources', () => {
    const cfg = {
      lines: [
        [
          { id: 'branch', type: 'git-branch' },
          { id: 'host', type: 'hostname' },
          { id: 'phase', type: 'gsd-phase' },
        ],
      ],
    };
    const { out } = run(['--scenario', 'gsd-project'], cfg);
    expect(rowOf(out, 'branch (git-branch)')).toMatch(/ ← git \(live\)$/);
    expect(rowOf(out, 'host (hostname)')).toMatch(/ ← system$/);
    expect(rowOf(out, 'phase (gsd-phase)')).toMatch(/ ← GSD \.planning\/STATE\.md$/);
  });

  it('shows the usage cache age', () => {
    const prev = process.env.CCINFOBAR_NO_USAGE_API;
    delete process.env.CCINFOBAR_NO_USAGE_API;
    try {
      savedPayload();
      fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
      fs.writeFileSync(
        usageFile(),
        JSON.stringify({
          fetchedAt: Date.now() - 4 * 60_000,
          rate_limits: { five_hour: { used_percentage: 40, resets_at: Date.now() / 1000 + 3600 } },
        }),
      );
      const { out } = run([], { lines: [[{ id: 'five', type: 'five-hour-usage' }]] });
      expect(rowOf(out, 'five (five-hour-usage)')).toMatch(/: 40% ← usage cache \(age 4m\)$/);
    } finally {
      if (prev === undefined) delete process.env.CCINFOBAR_NO_USAGE_API;
      else process.env.CCINFOBAR_NO_USAGE_API = prev;
      fs.rmSync(usageFile(), { force: true });
    }
  });

  it('shows the transcript cache age', () => {
    const p = savedPayload();
    readTranscript(p.transcript_path);
    const cache = cacheFile(transcriptCacheName(p.transcript_path!));
    const t12 = (Date.now() - 12_000) / 1000;
    fs.utimesSync(cache, t12, t12);
    try {
      const { out } = run([], { lines: [[{ id: 'messages', type: 'message-count' }]] });
      expect(rowOf(out, 'messages (message-count)')).toMatch(/ ← transcript \(cache age 1[1-3]s\)$/);
    } finally {
      fs.rmSync(cache, { force: true });
    }
  });

  it('lists sources on empty rows too', () => {
    const { out } = run(['--scenario', 'api-key-user'], {
      lines: [[{ id: 'five', type: 'five-hour-usage' }]],
    });
    const row = rowOf(out, 'five (five-hour-usage)');
    expect(row).toContain('empty');
    expect(row).toContain(' ← env: provider');
    expect(out.join('\n')).not.toContain('sk-ant-scenario');
  });

  it('formats short ages', () => {
    expect(shortAge(12_000)).toBe('12s');
    expect(shortAge(4 * 60_000)).toBe('4m');
    expect(shortAge(3 * 3_600_000)).toBe('3h');
    expect(shortAge(72 * 3_600_000)).toBe('3d');
  });
});

describe('explain is read-only', () => {
  function watch() {
    const writes: string[] = [];
    const rec = (p: unknown) => {
      if (typeof p === 'string') writes.push(path.resolve(p));
    };
    const w = fs.writeFileSync;
    const r = fs.renameSync;
    const m = fs.mkdirSync;
    const o = fs.openSync;
    const tmp = fs.mkdtempSync;
    const made: string[] = [];
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...a: Parameters<typeof w>) => {
      rec(a[0]);
      return w(...a);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((...a: Parameters<typeof r>) => {
      rec(a[1]);
      return r(...a);
    });
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((...a: Parameters<typeof m>) => {
      rec(a[0]);
      return m(...a);
    }) as typeof m);
    vi.spyOn(fs, 'openSync').mockImplementation((...a: Parameters<typeof o>) => {
      const flags = a[1] ?? 'r';
      if (typeof flags === 'number' ? flags !== fs.constants.O_RDONLY : /[wa+]/.test(String(flags)))
        rec(a[0]);
      return o(...a);
    });
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(((...a: Parameters<typeof tmp>) => {
      const d = tmp(...a);
      made.push(String(d));
      return d;
    }) as typeof tmp);
    const spawn = vi.spyOn(cp, 'spawn');
    module.syncBuiltinESMExports();
    const inside = (base: string) => writes.filter((p) => p === base || p.startsWith(base + path.sep));
    return { writes, made, spawn, inside };
  }

  it('writes nothing under the cache or config dir and starts no worker', () => {
    const file = cfgFile(LAYOUT);
    savedPayload();
    const w = watch();
    const out: string[] = [];
    runExplain(parseArgs(['explain']), file, {
      tty: false,
      log: (l) => out.push(l),
      error: (l) => out.push(l),
    });
    expect(out.some((l) => l.includes('messages (message-count)'))).toBe(true);
    expect(w.inside(path.resolve(cacheDir()))).toEqual([]);
    expect(w.inside(path.resolve(configDir()))).toEqual([]);
    expect(w.spawn.mock.calls.filter((c) => (c[2] as { detached?: boolean } | undefined)?.detached)).toEqual(
      [],
    );
  });

  it('runs command widgets against a temp cache dir', () => {
    savedPayload();
    const cfg = {
      lines: [
        [{ id: 'cmd', type: 'command', options: { command: 'echo hi', cacheSeconds: 60, timeout: 10_000 } }],
      ],
    };
    const file = cfgFile(cfg);
    const w = watch();
    const out: string[] = [];
    runExplain(parseArgs(['explain']), file, {
      tty: false,
      log: (l) => out.push(l),
      error: (l) => out.push(l),
    });
    expect(out).toContain(
      t('explain.row.shown', { name: 'cmd (command)', value: t('explain.redacted', { n: 2 }) }) +
        t('explain.sources', { sources: t('explain.source.config', { path: 'options.command' }) }),
    );
    const cached = fs.existsSync(cacheDir())
      ? fs.readdirSync(cacheDir()).filter((f) => f.startsWith('cmd-'))
      : [];
    expect(cached).toEqual([]);
    expect(w.inside(path.resolve(cacheDir()))).toEqual([]);
    expect(w.made).toHaveLength(1);
    expect(fs.existsSync(w.made[0]!)).toBe(false);
  });
});

describe('loadInspectInput', () => {
  it('returns null without a payload when the fallback is none', () => {
    expect(loadInspectInput({ cfgFile: cfgFile(), fallback: 'none' })).toBeNull();
  });

  it('takes the width from the payload, then COLUMNS', () => {
    const file = path.join(dir, 'empty.json');
    fs.writeFileSync(file, '{}');
    const a = loadInspectInput({
      cfgFile: cfgFile(),
      payloadFile: file,
      fallback: 'sample',
      env: { COLUMNS: '77' },
    })!;
    expect(a.width).toBe(77);
    a.cleanup();
    savedPayload({ terminal_width: 133 });
    const b = loadInspectInput({ cfgFile: cfgFile(), fallback: 'sample', env: { COLUMNS: '77' } })!;
    expect(b.width).toBe(133);
    expect(b.input.kind).toBe('last');
    b.cleanup();
  });

  it('formats ages', () => {
    expect(formatAge(5_000)).toBe('5s');
    expect(formatAge(5 * 60_000)).toBe('5 min');
    expect(formatAge(3 * 3_600_000)).toBe('3 h');
    expect(formatAge(72 * 3_600_000)).toBe('3 days');
  });
});

describe('read-only readers', () => {
  it('readTranscript with persist false returns the same data and writes no cache', () => {
    const env = { ...process.env, CCINFOBAR_CACHE_DIR: path.join(dir, 'c1') };
    const file = transcriptFile();
    const ro = readTranscript(file, env, { persist: false });
    expect(fs.existsSync(cacheFile(transcriptCacheName(file), env))).toBe(false);
    const rw = readTranscript(file, env);
    expect(fs.existsSync(cacheFile(transcriptCacheName(file), env))).toBe(true);
    expect(ro).toEqual(rw);
  });

  it('readAgents with persist false returns the same data and writes no cache', () => {
    const env = { ...process.env, CCINFOBAR_CACHE_DIR: path.join(dir, 'c2') };
    const transcript = path.join(dir, 'main.jsonl');
    fs.writeFileSync(transcript, '');
    const sub = path.join(dir, 'main', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore' }));
    const jsonl = path.join(sub, 'agent-a1.jsonl');
    fs.writeFileSync(
      jsonl,
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm', usage: { input_tokens: 3, output_tokens: 4 } },
      }),
    );
    const now = Date.now();
    const ro = readAgents(transcript, null, now, env, { persist: false });
    expect(ro).toHaveLength(1);
    expect(fs.existsSync(cacheFile(agentsCacheName(jsonl), env))).toBe(false);
    const rw = readAgents(transcript, null, now, env);
    expect(fs.existsSync(cacheFile(agentsCacheName(jsonl), env))).toBe(true);
    expect(ro).toEqual(rw);
  });
});

const WIDGET_KEYS = ['empty', 'error', 'id', 'index', 'line', 'sources', 'status', 'type', 'value'];

function json(argv: string[], cfg: object = LAYOUT) {
  const { out, err } = run(['--json', ...argv], cfg);
  expect(out).toHaveLength(1);
  return { obj: JSON.parse(out[0]!), text: out[0]!, err };
}

describe('explain --json', () => {
  it('prints one stable object for the sample', () => {
    const { obj, err } = json([]);
    expect(err).toEqual([]);
    expect(obj.schema).toBe(1);
    expect(obj.version).toBe(VERSION);
    expect(obj.input).toEqual({ kind: 'sample' });
    expect(Object.keys(obj).sort()).toEqual(['input', 'lines', 'schema', 'version', 'widgets', 'width']);
    expect(obj.widgets).toHaveLength(7);
    for (const w of obj.widgets) expect(Object.keys(w).sort()).toEqual(WIDGET_KEYS);
    for (const l of obj.lines) expect(Object.keys(l).sort()).toEqual(['cut', 'line', 'max', 'width']);
    expect(process.exitCode).toBeUndefined();
  });

  it('describes last, scenario and payload inputs', () => {
    savedPayload({ version: '2.1.300' });
    const last = json([]).obj.input;
    expect(last.kind).toBe('last');
    expect(typeof last.ageMs).toBe('number');
    expect(last.claudeCode).toBe('2.1.300');
    expect(json(['--scenario', 'context-full']).obj.input).toEqual({
      kind: 'scenario',
      name: 'context-full',
    });
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ model: { display_name: 'X' } }));
    expect(json(['--payload', file]).obj.input).toEqual({ kind: 'payload' });
  });

  it('never dumps payload values that are not rendered', () => {
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ session_name: 'SECRET-NAME', model: { display_name: 'Opus' } }));
    const { text } = json(['--payload', file]);
    expect(text).not.toContain('SECRET-NAME');
    expect(text).toContain('Opus');
  });

  it('sanitizes every string', () => {
    const row: InspectRow = {
      line: 0,
      index: 0,
      id: `a${ESC}[31mb`,
      type: 'model',
      status: 'empty',
      value: `v${ESC}[31m1`,
      sources: [{ kind: 'payload', path: `x${ESC}[0m` }],
      empty: { code: 'no-data', text: `r${ESC}[31mz` },
      error: null,
    };
    const obj = explainJson({ kind: 'sample' }, [row], [], null);
    const text = JSON.stringify(obj);
    expect(text).not.toContain('\\u001b');
    expect(text).not.toContain(ESC);
    expect(obj.widgets[0]).toMatchObject({ id: 'ab', value: 'v1', empty: { text: 'rz' } });
  });

  it('prints only the matched widgets with an id', () => {
    const { obj } = json(['ctx']);
    expect(obj.widgets.map((w: InspectRow) => w.id)).toEqual(['ctx']);
    expect(obj.lines.length).toBe(2);
  });
});

describe('explain redacts env and command values', () => {
  const SECRET = 'supersecret-env-value';
  const CMD_OUT = 'cmd-output-secret';
  const cfg = {
    lines: [
      [
        { id: 'tok', type: 'env', options: { name: 'CCIB_TEST_SECRET' } },
        { id: 'cmd', type: 'command', options: { command: `echo ${CMD_OUT}`, timeout: 10_000 } },
        { id: 'model', type: 'model' },
      ],
    ],
  };
  const redacted = (s: string) => t('explain.redacted', { n: s.length });

  beforeEach(() => {
    process.env.CCIB_TEST_SECRET = SECRET;
    savedPayload();
  });
  afterEach(() => {
    delete process.env.CCIB_TEST_SECRET;
  });

  it('never puts the values in --json', () => {
    for (const argv of [[], ['tok'], ['--show-values']]) {
      const { obj, text } = json(argv, cfg);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(CMD_OUT);
      const tok = obj.widgets.find((w: InspectRow) => w.id === 'tok');
      expect(tok).toMatchObject({ status: 'shown', value: redacted(SECRET) });
    }
    const cmd = json([], cfg).obj.widgets.find((w: InspectRow) => w.id === 'cmd');
    expect(cmd.value).toBe(redacted(CMD_OUT));
  });

  it('redacts them off a terminal, even with --show-values', () => {
    for (const argv of [[], ['tok'], ['--show-values'], ['tok', '--show-values']]) {
      const { out, err } = run(argv, cfg);
      const text = [...out, ...err].join('\n');
      expect(text).not.toContain(SECRET);
      expect(text).toContain(redacted(SECRET));
      if (argv[0] !== 'tok') {
        expect(text).not.toContain(CMD_OUT);
        expect(text).toContain(redacted(CMD_OUT));
      }
    }
    expect(run(['--show-values'], cfg).err).toEqual([t('explain.showValuesTty')]);
    expect(run([], cfg).out.join('\n')).toContain('Opus');
  });

  it('shows them in a terminal only with --show-values', () => {
    expect(run([], cfg, true).out.join('\n')).not.toContain(SECRET);
    const { out, err } = run(['--show-values'], cfg, true);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain(SECRET);
    expect(out.join('\n')).toContain(CMD_OUT);
  });
});

describe('explain <widget-id>', () => {
  const block = (out: string[]) => out.slice(out.findIndex((l) => l.startsWith('Widget ')));

  it('prints a detail block for an id', () => {
    const cfg = {
      lines: [[{ id: 'context-percentage', type: 'context-percentage', options: { mode: 'remaining' } }]],
    };
    const { out, err } = run(['context-percentage'], cfg);
    expect(err).toEqual([]);
    const b = block(out);
    expect(b[0]).toBe(t('explain.detail.header', { name: 'context-percentage' }));
    expect(b).toContain(t('explain.detail.line', { line: 1 }));
    expect(b).toContain(t('explain.detail.index', { index: 0 }));
    expect(b).toContain(t('explain.detail.id', { id: 'context-percentage' }));
    expect(b).toContain(t('explain.detail.type', { type: 'context-percentage' }));
    expect(b).toContain(t('explain.detail.status', { status: 'shown' }));
    expect(b.some((l) => l.startsWith('  value: '))).toBe(true);
    expect(b.some((l) => l.startsWith('  sources: ') && l.includes('payload: context_window'))).toBe(true);
    expect(b).toContain(t('explain.detail.options', { options: '{"mode":"remaining"}' }));
    expect(process.exitCode).toBeUndefined();
  });

  it('prints the reason and no options for an empty widget', () => {
    const { out } = run(['branch', '--scenario', 'no-git'], LAYOUT);
    const b = block(out);
    expect(b).toContain(t('explain.detail.reason', { reason: t('explain.reason.no-git') }));
    expect(b).toContain(t('explain.detail.options', { options: t('explain.detail.none') }));
  });

  it('matches the id first, then every item of the type', () => {
    const cfg = {
      lines: [
        [
          { id: 'git-branch', type: 'git-branch' },
          { id: 'git-branch-2', type: 'git-branch' },
          { id: 'here', type: 'cwd' },
          { id: 'there', type: 'cwd' },
        ],
      ],
    };
    const headers = (out: string[]) => out.filter((l) => l.startsWith('Widget '));
    expect(headers(run(['git-branch'], cfg).out)).toEqual([
      t('explain.detail.header', { name: 'git-branch' }),
    ]);
    expect(headers(run(['cwd'], cfg).out)).toEqual([
      t('explain.detail.header', { name: 'here (cwd)' }),
      t('explain.detail.header', { name: 'there (cwd)' }),
    ]);
  });

  it('exits 1 and lists the ids when nothing matches', () => {
    const { out, err } = run(['nope-widget']);
    expect(out).toEqual([]);
    expect(err).toEqual([
      t('explain.noMatch', { id: 'nope-widget' }),
      t('explain.idList', { ids: 'model, ctx, flex, branch, messages, graph, nope' }),
    ]);
    expect(process.exitCode).toBe(1);
  });
});

describe('explain with a broken config', () => {
  it('prints the location, points to doctor and exits 1', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    const file = path.join(configDir(), 'broken.json');
    fs.writeFileSync(file, '{\n  "lines": [\n    [}\n');
    for (const argv of [[], ['--json']]) {
      process.exitCode = undefined;
      const out: string[] = [];
      const err: string[] = [];
      runExplain(parseArgs(['explain', ...argv]), file, {
        tty: false,
        log: (l) => out.push(l),
        error: (l) => err.push(l),
      });
      expect(out).toEqual([]);
      expect(err[0]).toMatch(/has an error at line 3, column \d+: /);
      expect(err[1]).toBe(t('explain.runDoctor'));
      expect(process.exitCode).toBe(1);
    }
  });
});
