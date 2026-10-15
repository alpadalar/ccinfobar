import cp from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import {
  explainJson,
  formatAge,
  loadInspectInput,
  redactValue,
  runExplain,
  shortAge,
  sourceText,
} from '../../src/commands/explain.js';
import type { CliIo } from '../../src/commands/io.js';
import { manifestFile, readManifest, recordHook, writeManifest } from '../../src/commands/manifest.js';
import { t } from '../../src/core/i18n/index.js';
import type { InspectRow } from '../../src/core/inspect.js';
import { cacheDir, claudeSettingsPath, configDir, lastPayloadPath } from '../../src/core/paths.js';
import { scenarioListLines } from '../../src/core/preview.js';
import type { StatusPayload } from '../../src/core/types.js';
import { VERSION } from '../../src/core/version.js';
import { agentsCacheName, readAgents } from '../../src/data/agents.js';
import { cacheFile } from '../../src/data/cache.js';
import { ghKey, httpKey } from '../../src/data/jobs/keys.js';
import { failEnvelope, jobsDir, okEnvelope, writeEnvelope } from '../../src/data/jobs/runner.js';
import { monthKey } from '../../src/data/ledger.js';
import { accountKey, limitsFile, recordLimits, recordUsageApi } from '../../src/data/limits.js';
import { readTranscript, transcriptCacheName } from '../../src/data/transcript.js';
import { usageFile } from '../../src/data/usage.js';
import { getWidget } from '../../src/widgets/index.js';

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
  const io: CliIo = { tty, log: (l) => out.push(l), error: (l) => err.push(l) };
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

  it('applies the scenario config without saving it', () => {
    const budget = { lines: [[{ id: 'b', type: 'budget' }]] };
    const { out } = run(['--scenario', 'over-budget'], budget);
    const shown = t('explain.row.shown', { name: 'b (budget)', value: '~$4.12/$3' });
    expect(
      out.some((l) => l.startsWith(shown)),
      out.join('\n'),
    ).toBe(true);
    const file = cfgFile(budget);
    const data = loadInspectInput({ cfgFile: file, scenario: 'over-budget', fallback: 'sample' })!;
    try {
      expect(data.config.budget?.daily).toBe(3);
      expect(data.loaded.config.budget).toBeUndefined();
      expect(getWidget('budget')!.render(data.ctx, { id: 'b', type: 'budget' })).toMatchObject({
        color: 'red',
      });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(budget);
    } finally {
      data.cleanup();
    }
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

  it('prefers --payload over the last payload', () => {
    savedPayload();
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ model: { display_name: 'From File' } }));
    const { out } = run(['--payload', file]);
    expect(out[1]).toContain('Input: payload file');
    expect(out.some((l) => l.includes('From File'))).toBe(true);
  });

  it('refuses --scenario with --payload', () => {
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ model: { display_name: 'From File' } }));
    for (const argv of [
      ['--payload', file, '--scenario', 'context-full'],
      ['--scenario', 'context-full', '--payload', file, '--json'],
    ]) {
      process.exitCode = undefined;
      const { out, err } = run(argv);
      expect(out).toEqual([]);
      expect(err).toEqual([t('explain.scenarioWithPayload')]);
      expect(process.exitCode).toBe(1);
    }
  });

  it('refuses a bare --payload and a bad --width', () => {
    const cases: [string[], string][] = [
      [['--payload'], t('explain.payloadMissing')],
      [['--width', 'abc'], t('explain.badWidth')],
      [['--width', '0'], t('explain.badWidth')],
      [['--width'], t('explain.badWidth')],
      [['--width=-5'], t('explain.badWidth')],
    ];
    for (const [argv, msg] of cases) {
      process.exitCode = undefined;
      const { out, err } = run(argv);
      expect(out).toEqual([]);
      expect(err).toEqual([msg]);
      expect(process.exitCode).toBe(1);
    }
    process.exitCode = undefined;
    expect(run(['--width', '90']).out).toContain(t('explain.width', { width: 90 }));
    expect(process.exitCode).toBeUndefined();
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

  it('prints a shown row note on its own line', () => {
    const ec = { lines: [[{ id: 'env', type: 'env-counts', options: { mcpHealth: true } }]] };
    const { out } = run(['--scenario', 'no-git'], ec);
    const i = out.findIndex((l) => l.includes('env (env-counts): CLAUDE.md 2'));
    expect(i).toBeGreaterThan(-1);
    expect(out[i + 1]).toBe(t('explain.row.note', { reason: t('explain.reason.no-mcp-health') }));
    const json = JSON.parse(run(['--scenario', 'no-git', '--json'], ec).out.join('\n'));
    expect(json.widgets[0].note).toEqual({ code: 'no-mcp-health', text: t('explain.reason.no-mcp-health') });
    const detail = run(['env', '--scenario', 'no-git'], ec).out;
    expect(detail).toContain(t('explain.detail.note', { note: t('explain.reason.no-mcp-health') }));
  });

  it('names the rule that hid a widget and an ignored rule', () => {
    savedPayload();
    const cfg = {
      lines: [
        [
          { id: 'hot', type: 'text', options: { text: 'HOT' }, showWhen: 'context.pct >= 70' },
          { id: 'typo', type: 'text', options: { text: 'T' }, showWhen: `contxt${ESC}[31m.pct > 5` },
        ],
      ],
    };
    const { out } = run([], cfg);
    for (const l of out) expect(l).not.toContain(ESC);
    const reason = t('explain.reason.hidden-by-rule', {
      key: 'showWhen',
      rule: 'context.pct >= 70',
      metric: 'context.pct',
      value: '12',
    });
    const hot = out.find((l) => l.includes('hot (text)'))!;
    expect(hot.startsWith(`${t('explain.row.hidden', { name: 'hot (text)', reason })} ← `)).toBe(true);
    expect(hot).toContain('payload: context_window.used_percentage');
    const i = out.findIndex((l) => l.includes('typo (text): T'));
    expect(i).toBeGreaterThan(-1);
    expect(out[i + 1]).toMatch(/^ {6}⚠ showWhen is ignored: /);
    const json = JSON.parse(run(['--json'], cfg).out.join('\n'));
    expect(json.widgets[0]).toMatchObject({
      status: 'hidden',
      empty: { code: 'hidden-by-rule', text: reason },
    });
    expect(json.widgets[1].status).toBe('shown');
    expect(json.widgets[1].warning.code).toBe('invalid-rule');
    expect(json.widgets[1].warning.text).not.toContain(ESC);
    const detail = run(['typo'], cfg).out;
    expect(detail.some((l) => l.startsWith('  warning: showWhen is ignored: '))).toBe(true);
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

  it('tells needs-hooks from no-hook-state by the manifest', () => {
    const layout = { lines: [[{ id: 'pw', type: 'permission-wait' }]] };
    savedPayload();
    expect(rowOf(run([], layout).out, 'pw (permission-wait)')).toContain(t('explain.reason.needs-hooks'));
    const m = recordHook(readManifest(), {
      file: claudeSettingsPath(),
      event: 'Stop',
      value: { hooks: [{ type: 'command', command: 'ccinfobar hook Stop', async: true, timeout: 5 }] },
      claudeCode: '2.1.299',
      writtenHash: null,
    });
    writeManifest(m);
    try {
      expect(rowOf(run([], layout).out, 'pw (permission-wait)')).toContain(t('explain.reason.no-hook-state'));
    } finally {
      fs.rmSync(manifestFile(), { force: true });
    }
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

describe('explain without a temp dir', () => {
  it('still runs command widgets, without their cache', () => {
    savedPayload();
    const cfg = {
      lines: [
        [{ id: 'cmd', type: 'command', options: { command: 'echo hi', cacheSeconds: 60, timeout: 10_000 } }],
      ],
    };
    const file = cfgFile(cfg);
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    module.syncBuiltinESMExports();
    const out: string[] = [];
    expect(() =>
      runExplain(parseArgs(['explain']), file, {
        tty: false,
        log: (l) => out.push(l),
        error: (l) => out.push(l),
      }),
    ).not.toThrow();
    expect(out.some((l) => l.startsWith(t('explain.row.shown', { name: 'cmd (command)', value: '' })))).toBe(
      true,
    );
    const cached = fs.existsSync(cacheDir())
      ? fs.readdirSync(cacheDir()).filter((f) => f.startsWith('cmd-'))
      : [];
    expect(cached).toEqual([]);
    expect(process.exitCode).toBeUndefined();
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
    const b = loadInspectInput({
      cfgFile: cfgFile(),
      fallback: 'sample',
      env: { ...process.env, COLUMNS: '77' },
    })!;
    expect(b.width).toBe(133);
    expect(b.input.kind).toBe('last');
    b.cleanup();
  });

  it('reads the last payload from the cache dir of opts.env', () => {
    savedPayload({ version: '2.1.111' });
    const other = path.join(dir, 'other-cache');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'last-payload.json'), JSON.stringify({ version: '2.1.222' }));
    const env = { ...process.env, CCINFOBAR_CACHE_DIR: other };
    const a = loadInspectInput({ cfgFile: cfgFile(), fallback: 'none', env })!;
    expect(a.input).toMatchObject({ kind: 'last', claudeCode: '2.1.222' });
    expect(typeof a.input.ageMs).toBe('number');
    a.cleanup();
    expect(
      loadInspectInput({
        cfgFile: cfgFile(),
        fallback: 'none',
        env: { ...env, CCINFOBAR_CACHE_DIR: path.join(dir, 'none') },
      }),
    ).toBeNull();
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

describe('explain redacts http values and options', () => {
  const TOKEN = 'tok-SECRET-abc';
  const URL = 'https://api.x.com/v1?key=${API_KEY}';
  const HEADERS = 'Authorization=Bearer $RELAY_TOKEN';
  const PATH = '$.data.balance';
  const key = httpKey(URL, HEADERS);
  const cfg = {
    lines: [
      [{ id: 'bal', type: 'http', options: { url: URL, headers: HEADERS, path: PATH, format: '${value}' } }],
    ],
  };
  const value = (v: unknown) => ({ paths: { [PATH]: { ok: true, v } } });

  beforeEach(() => {
    process.env.RELAY_TOKEN = TOKEN;
    process.env.API_KEY = 'q-SECRET-xyz';
    savedPayload();
  });
  afterEach(() => {
    delete process.env.RELAY_TOKEN;
    delete process.env.API_KEY;
    fs.rmSync(jobsDir(), { recursive: true, force: true });
  });

  it('redacts the value unless --show-values in a terminal', () => {
    writeEnvelope(okEnvelope(key, value(12.5), Date.now()));
    const redacted = t('explain.redacted', { n: '$12.5'.length });
    for (const [argv, tty] of [
      [[], false],
      [['--show-values'], false],
      [[], true],
      [['bal'], false],
    ] as const) {
      const text = run([...argv], cfg, tty).out.join('\n');
      expect(text).toContain(redacted);
      expect(text).not.toContain('$12.5');
    }
    expect(json([], cfg).obj.widgets[0]).toMatchObject({ status: 'shown', value: redacted });
    expect(run(['--show-values'], cfg, true).out.join('\n')).toContain('$12.5');
  });

  it('shows the url with query values hidden and headers as env names', () => {
    writeEnvelope(okEnvelope(key, value(12.5), Date.now()));
    for (const tty of [false, true]) {
      const text = run(['bal'], cfg, tty).out.join('\n');
      expect(text).toContain('"url":"https://api.x.com/v1?key=\u2026"');
      expect(text).toContain('"headers":"Authorization=$RELAY_TOKEN (set)"');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('q-SECRET');
    }
    delete process.env.RELAY_TOKEN;
    expect(run(['bal'], cfg).out.join('\n')).toContain('"headers":"Authorization=$RELAY_TOKEN (unset)"');
  });

  it('never prints the token in text or --json, whatever the state', () => {
    writeEnvelope(failEnvelope(key, null, 'env RELAY_TOKEN not set', Date.now()));
    for (const argv of [[], ['bal'], ['--show-values'], ['bal', '--show-values']]) {
      for (const tty of [false, true]) {
        const text = [...run(argv, cfg, tty).out, ...run(argv, cfg, tty).err].join('\n');
        expect(text).not.toContain(TOKEN);
      }
      expect(json(argv, cfg).text).not.toContain(TOKEN);
    }
    const row = json([], cfg).obj.widgets[0];
    expect(row.empty.code).toBe('job-error');
    expect(row.empty.text).toContain('env RELAY_TOKEN not set');
  });

  it('says job-pending without an envelope, even with nonessential traffic off', () => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
    try {
      expect(json([], cfg).obj.widgets[0].empty.code).toBe('job-pending');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('explain the pr CI part', () => {
  const KEY = ghKey('github.com/acme/api#128');
  const PR = {
    number: 128,
    review_state: 'approved',
    url: 'https://github.com/acme/api/pull/128',
    kind: 'pr',
  };
  const REPO = { host: 'github.com', owner: 'acme', name: 'api' };
  const cfg = (ci = true) => ({ lines: [[{ id: 'pr', type: 'pr', options: { ci } }]] });
  const counts = (pass: number, fail: number, pending: number) => ({
    pass,
    fail,
    pending,
    skipped: 0,
    cancelled: 0,
    total: pass + fail + pending,
    names: [],
  });
  const payload = (pr: object = PR, repo: object | null = REPO) =>
    savedPayload({ pr, workspace: { current_dir: dir, ...(repo ? { repo } : {}) } } as StatusPayload);
  const row = (c = cfg()) => json([], c).obj.widgets[0];

  afterEach(() => {
    fs.rmSync(jobsDir(), { recursive: true, force: true });
  });

  it('says merge-request for a GitLab merge request', () => {
    payload({ ...PR, kind: 'mr' });
    writeEnvelope(okEnvelope(KEY, counts(0, 2, 0), Date.now()));
    expect(row()).toMatchObject({ status: 'shown', value: '#128 approved', ci: { code: 'merge-request' } });
    const reasonText = t('explain.reason.merge-request');
    expect(run([], cfg()).out).toContain(t('explain.row.ci', { reason: reasonText }));
    expect(run(['pr'], cfg()).out).toContain(t('explain.detail.ci', { reason: reasonText }));
  });

  it('says job-pending before the first gh run', () => {
    payload();
    expect(row()).toMatchObject({ value: '#128 approved', ci: { code: 'job-pending' } });
  });

  it('says no-ci-checks for a pr without checks', () => {
    payload();
    writeEnvelope(okEnvelope(KEY, counts(0, 0, 0), Date.now()));
    expect(row()).toMatchObject({ value: '#128 approved', ci: { code: 'no-ci-checks' } });
  });

  it('maps gh-missing, gh-auth, gh-host and gh-old', () => {
    payload();
    for (const code of ['gh-missing', 'gh-auth', 'gh-host', 'gh-old'] as const) {
      writeEnvelope(failEnvelope(KEY, null, code, Date.now(), { blockMs: 3_600_000 }));
      const r = row();
      expect(r.value, code).toBe('#128 approved');
      expect(r.ci, code).toEqual({ code, text: t(`explain.reason.${code}`) });
    }
  });

  it('keeps the last good part and names the gh error', () => {
    payload();
    const good = okEnvelope(KEY, counts(3, 0, 0), Date.now() - 60_000);
    writeEnvelope(failEnvelope(KEY, good, 'gh-auth', Date.now(), { blockMs: 1_800_000 }));
    expect(row()).toMatchObject({ value: '#128 approved \u2713', ci: { code: 'gh-auth' } });
    writeEnvelope(failEnvelope(KEY, good, 'gh-failed', Date.now(), { retryMs: 60_000 }));
    expect(row().ci).toEqual({
      code: 'job-error',
      text: t('explain.reason.ciLastGood', { error: 'gh-failed' }),
    });
  });

  it('says payload-field-absent without the repo owner and name', () => {
    payload(PR, null);
    expect(row().ci.code).toBe('payload-field-absent');
  });

  it('has no CI line when the part shows or ci is off', () => {
    payload();
    writeEnvelope(okEnvelope(KEY, counts(9, 2, 0), Date.now()));
    expect(row()).toMatchObject({ value: '#128 approved \u2717 2' });
    expect(row()).not.toHaveProperty('ci');
    expect(row(cfg(false))).toMatchObject({ value: '#128 approved' });
    expect(row(cfg(false))).not.toHaveProperty('ci');
    expect(run([], cfg(false)).out.join('\n')).not.toContain('CI:');
  });

  it('shows the failing checks in the pr-ci-failing scenario', () => {
    expect(json(['--scenario', 'pr-ci-failing'], cfg()).obj.widgets[0]).toMatchObject({
      value: '#128 approved \u2717 2',
    });
  });
});

describe('redactValue', () => {
  it('redacts tool-activity, whose value can hold command arguments', () => {
    const row = (type: string, value: string): InspectRow => ({
      line: 0,
      index: 0,
      id: type,
      type,
      status: 'shown',
      value,
      sources: [],
      empty: null,
      error: null,
    });
    expect(redactValue(row('tool-activity', 'Bash npm test'))).toBe(t('explain.redacted', { n: 13 }));
    expect(redactValue(row('model', 'Opus'))).toBe('Opus');
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

  it('masks text options unless --show-values in a terminal', () => {
    const token = 'echo Bearer tok-123';
    const url = 'https://example.com/?key=url-secret';
    const cfg = {
      lines: [
        [
          { id: 'cmd', type: 'command', options: { command: token, timeout: 50 } },
          { id: 'docs', type: 'link', options: { url, text: 'docs' } },
        ],
      ],
    };
    const masked = (s: string) => t('explain.maskedOption', { n: s.length });
    for (const [argv, tty] of [
      [['cmd'], false],
      [['cmd', '--show-values'], false],
      [['cmd'], true],
    ] as const) {
      const b = block(run([...argv], cfg, tty).out);
      expect(b.join('\n')).not.toContain('tok-123');
      expect(b).toContain(
        t('explain.detail.options', { options: JSON.stringify({ command: masked(token), timeout: 50 }) }),
      );
    }
    const link = block(run(['docs'], cfg).out).join('\n');
    expect(link).not.toContain('url-secret');
    expect(link).toContain(masked(url));
    const shown = block(run(['cmd', '--show-values'], cfg, true).out);
    expect(shown).toContain(
      t('explain.detail.options', { options: JSON.stringify({ command: token, timeout: 50 }) }),
    );
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

describe('explain limits sources', () => {
  const FIVE = { lines: [[{ id: 'five-hour-usage', type: 'five-hour-usage' }]] };
  const PROVIDER = /^(CLAUDE_CODE_USE_|ANTHROPIC_)|^CLAUDE_CODE_OAUTH_TOKEN$/;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of Object.keys(process.env)) {
      if (PROVIDER.test(k)) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    }
  });

  afterEach(() => {
    fs.rmSync(limitsFile(), { force: true });
    Object.assign(process.env, saved);
  });

  const resetsSec = () => Math.floor(Date.now() / 1000) + 2 * 3600;

  function sessionAt(ago: number, rate_limits: StatusPayload['rate_limits']): void {
    const file = path.join(dir, 'limits-session.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.now() - ago).toISOString(),
        message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } },
      })}\n`,
    );
    savedPayload({ transcript_path: file, rate_limits });
  }

  const five = (pct: number, resets_at = resetsSec()) => ({ five_hour: { used_percentage: pct, resets_at } });

  function otherSession(pct: number, ago: number): void {
    recordLimits(process.env, { rate_limits: five(pct) }, Date.now() - ago, Date.now());
  }

  const detail = (out: string[], key: string) => out.find((l) => l.startsWith(`  ${key}: `)) ?? '';

  it('names the limits cache and another session when its value is newer', () => {
    sessionAt(3 * 3_600_000, five(40));
    otherSession(70, 2 * 60_000);
    const { out } = run(['five-hour-usage'], FIVE);
    expect(detail(out, 'value')).toBe('  value: 70%');
    const src = detail(out, 'sources');
    expect(src).toContain('limits cache');
    expect(src).toContain('2m');
    expect(src).toContain('another session');
  });

  it('says usage API when the store entry came from the worker', () => {
    sessionAt(3 * 3_600_000, five(40));
    recordUsageApi(
      process.env,
      { fetchedAt: Date.now() - 2 * 60_000, rate_limits: five(55) },
      false,
      Date.now(),
    );
    const { out } = run(['five-hour-usage'], FIVE);
    expect(detail(out, 'value')).toBe('  value: 55%');
    const src = detail(out, 'sources');
    expect(src).toContain('limits cache');
    expect(src).toContain('usage API');
  });

  it('names the payload field when this session is the newest and writes nothing', () => {
    sessionAt(10_000, five(40));
    otherSession(70, 2 * 60_000);
    const before = fs.readFileSync(limitsFile(), 'utf8');
    const { out } = run(['five-hour-usage'], FIVE);
    expect(detail(out, 'value')).toBe('  value: 40%');
    expect(detail(out, 'sources')).toContain('payload: rate_limits.five_hour.used_percentage');
    expect(fs.readFileSync(limitsFile(), 'utf8')).toBe(before);
  });

  it('formats the limits cache source and keeps origin in --json', () => {
    expect(sourceText({ kind: 'limits-cache', age: 120_000, origin: 'session' })).toBe(
      'limits cache, 2m old, from another session',
    );
    expect(sourceText({ kind: 'limits-cache', age: 120_000, origin: 'usage-api' })).toBe(
      'limits cache, 2m old, from usage API',
    );
    expect(sourceText({ kind: 'limits-cache' })).toBe('limits cache');
    sessionAt(3 * 3_600_000, five(40));
    otherSession(70, 2 * 60_000);
    const { obj } = json(['five-hour-usage'], FIVE);
    expect(obj.widgets[0].sources).toEqual([
      {
        kind: 'limits-cache',
        path: 'rate_limits.five_hour.used_percentage',
        age: expect.any(Number),
        origin: 'session',
      },
    ]);
  });

  it('never creates the limits file', () => {
    sessionAt(10_000, five(40));
    run([], FIVE);
    expect(fs.existsSync(limitsFile())).toBe(false);
  });

  it('explains limits-expired for a window that just reset', () => {
    const now = Date.now();
    sessionAt(3 * 3_600_000, {
      seven_day: { used_percentage: 10, resets_at: Math.floor(now / 1000) + 86400 },
    });
    fs.mkdirSync(path.dirname(limitsFile()), { recursive: true });
    fs.writeFileSync(
      limitsFile(),
      JSON.stringify({
        v: 1,
        windows: {
          five_hour: { pct: 80, resetsAt: now - 60_000, at: now - 3_600_000, src: 'payload', samples: [] },
        },
      }),
    );
    const { out } = run(['five-hour-usage'], FIVE);
    expect(detail(out, 'reason')).toBe(`  reason: ${t('explain.reason.limits-expired')}`);
    const { obj } = json(['five-hour-usage'], FIVE);
    expect(obj.widgets[0].empty.code).toBe('limits-expired');
  });
});

describe('explain ledger sources', () => {
  const COST = {
    lines: [
      [
        { id: 'cost-today', type: 'cost-today' },
        { id: 'week', type: 'cost-week' },
      ],
    ],
  };
  const ledgerDir = () => path.join(cacheDir(), 'ledger');
  const monthFile = () => path.join(ledgerDir(), `${monthKey(Date.now())}.jsonl`);
  const summary = () => path.join(ledgerDir(), 'summary.json');
  const detail = (out: string[], key: string) => out.find((l) => l.startsWith(`  ${key}: `)) ?? '';

  afterEach(() => {
    fs.rmSync(ledgerDir(), { recursive: true, force: true });
  });

  function seed(): string {
    const at = Date.now() - 2_000;
    const line = (s: string, c: number, t: number) =>
      JSON.stringify({ v: 1, t, a: accountKey(process.env), s, p: dir, tp: '', c });
    const text = `${line('other', 0, at - 1000)}\n${line('other', 1.25, at)}\n`;
    fs.mkdirSync(ledgerDir(), { recursive: true });
    fs.writeFileSync(monthFile(), text);
    return text;
  }

  it('shows the ledger total read-only and names the cost ledger', () => {
    const text = seed();
    savedPayload();
    const { out } = run(['cost-today'], COST);
    expect(detail(out, 'value')).toBe('  value: $1.25');
    expect(detail(out, 'sources')).toMatch(/cost ledger, updated \d+s ago/);
    expect(fs.readFileSync(monthFile(), 'utf8')).toBe(text);
    expect(fs.existsSync(summary())).toBe(false);
  });

  it('says no-ledger when nothing has been recorded and creates nothing', () => {
    savedPayload();
    const { out } = run(['cost-today'], COST);
    expect(detail(out, 'reason')).toBe(`  reason: ${t('explain.reason.no-ledger')}`);
    const { obj } = json([], COST);
    expect(obj.widgets.map((w: { empty: { code: string } | null }) => w.empty?.code)).toEqual([
      'no-ledger',
      'no-ledger',
    ]);
    expect(fs.existsSync(ledgerDir())).toBe(false);
  });

  it('uses the sample ledger without a payload', () => {
    const { obj } = json([], COST);
    expect(obj.input.kind).toBe('sample');
    expect(obj.widgets.map((w: { value: string | null }) => w.value)).toEqual(['$4.12', '$18.40']);
    expect(obj.widgets[0].sources).toEqual([{ kind: 'ledger', age: expect.any(Number) }]);
    expect(fs.existsSync(ledgerDir())).toBe(false);
  });

  it('formats the ledger source', () => {
    expect(sourceText({ kind: 'ledger' })).toBe('cost ledger');
    expect(sourceText({ kind: 'ledger', age: 120_000 })).toBe('cost ledger, updated 2m ago');
  });
});
