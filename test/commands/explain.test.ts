import cp from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { type ExplainIo, formatAge, loadInspectInput, runExplain } from '../../src/commands/explain.js';
import { t } from '../../src/core/i18n/index.js';
import { cacheDir, configDir, lastPayloadPath } from '../../src/core/paths.js';
import { scenarioListLines } from '../../src/core/preview.js';
import type { StatusPayload } from '../../src/core/types.js';
import { agentsCacheName, readAgents } from '../../src/data/agents.js';
import { cacheFile } from '../../src/data/cache.js';
import { readTranscript, transcriptCacheName } from '../../src/data/transcript.js';

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

function run(argv: string[], cfg: object = LAYOUT): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: ExplainIo = { tty: false, log: (l) => out.push(l), error: (l) => err.push(l) };
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
      lines: [[{ id: 'cmd', type: 'command', options: { command: 'echo hi', cacheSeconds: 60 } }]],
    };
    const file = cfgFile(cfg);
    const w = watch();
    const out: string[] = [];
    runExplain(parseArgs(['explain']), file, {
      tty: false,
      log: (l) => out.push(l),
      error: (l) => out.push(l),
    });
    expect(out).toContain(t('explain.row.shown', { name: 'cmd (command)', value: 'hi' }));
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
