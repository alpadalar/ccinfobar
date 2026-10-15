import cp from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { syncProgress } from '../../src/cli/progress.js';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { render } from '../../src/core/renderer.js';
import { sampleGit, samplePayload, sampleTranscript } from '../../src/core/sample.js';
import type { Config, StatusPayload, WidgetItem, WidgetOutput } from '../../src/core/types.js';
import { ghParam } from '../../src/data/jobs/gh.js';
import { ghKey, httpKey } from '../../src/data/jobs/keys.js';
import { envelopeFile, okEnvelope } from '../../src/data/jobs/runner.js';
import { reposKey } from '../../src/data/repos.js';
import type { TranscriptInfo } from '../../src/data/transcript.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget, withoutSideEffects } from '../helpers.js';

const fx = vi.hoisted(() => ({ managedDir: '', stopAt: '' }));

vi.mock('../../src/data/environment.js', async (orig) => {
  const m = await orig<typeof import('../../src/data/environment.js')>();
  return {
    ...m,
    readEnvironment: (...a: Parameters<typeof m.readEnvironment>) =>
      m.readEnvironment(a[0], a[1], a[2], { ...a[3], managedDir: fx.managedDir, stopAt: fx.stopAt }),
  };
});

const base = (): StatusPayload => samplePayload(NOW.getTime());
const tr = (o: Record<string, unknown> = {}) =>
  ({
    ...sampleTranscript(NOW.getTime()),
    responseMs: 3200,
    responseCount: 20,
    cacheMisses: 2,
    ...o,
  }) as TranscriptInfo;

function perf(
  o: { payload?: StatusPayload; transcript?: TranscriptInfo | null; options?: WidgetItem['options'] } = {},
): string | null {
  const t = o.transcript === undefined ? tr() : o.transcript;
  const ctx = ctxWith({ payload: o.payload ?? base(), transcript: () => t });
  return renderWidget('performance', ctx, o.options ? { options: o.options } : {});
}

function color(payload: StatusPayload, options: WidgetItem['options'] = {}): string | undefined {
  const ctx = ctxWith({ payload, transcript: () => tr() });
  const out = getWidget('performance')!.render(ctx, {
    id: 'p',
    type: 'performance',
    options: { display: 'badge', ...options },
  }) as WidgetOutput | string | null;
  return out && typeof out === 'object' ? out.color : undefined;
}

const withPc = (pc: Partial<NonNullable<StatusPayload['prompt_cache']>>, apiMs?: number): StatusPayload => {
  const p = base();
  return {
    ...p,
    cost: { ...p.cost, ...(apiMs === undefined ? {} : { total_api_duration_ms: apiMs }) },
    prompt_cache: { ...p.prompt_cache, ...pc },
  };
};

const noPc = (): StatusPayload => {
  const { prompt_cache: _pc, ...rest } = base();
  return rest;
};

describe('performance', () => {
  it('renders hit rate and average API time from the sample payload', () => {
    expect(perf()).toBe('94% · 16.9s');
  });

  it.each([
    ['hit', '94%'],
    ['time', '16.9s'],
    ['both', '94% · 16.9s'],
  ])('show %s', (show, expected) => {
    expect(perf({ options: { show } })).toBe(expected);
  });

  it('uses a plausible payload ratio', () => {
    expect(perf({ payload: withPc({ requests: 21 }, 803_000) })).toBe('94% · 38.2s');
  });

  it('falls back to the transcript when the ratio is implausible after a resume', () => {
    expect(perf({ payload: withPc({ requests: 2 }, 9_000_000) })).toBe('94% · ~3.2s');
  });

  it('falls back to the transcript when requests is zero', () => {
    expect(perf({ payload: withPc({ requests: 0 }) })).toBe('94% · ~3.2s');
  });

  it('formats times of a minute or more as a duration', () => {
    expect(perf({ payload: withPc({ requests: 1 }, 120_000), options: { show: 'time' } })).toBe('2m');
  });

  it('accepts a hit ratio given as a percent', () => {
    expect(perf({ payload: withPc({ hit_ratio: 81 }), options: { show: 'hit' } })).toBe('81%');
  });

  it('uses the transcript without prompt_cache', () => {
    expect(perf({ payload: noPc() })).toBe('86% · ~3.2s');
  });

  it('shows only the hit rate when no time is known', () => {
    expect(perf({ payload: noPc(), transcript: tr({ responseMs: null }) })).toBe('86%');
  });

  it('appends payload misses with showMisses', () => {
    expect(perf({ options: { showMisses: true } })).toBe('94% · 16.9s · 3 miss');
  });

  it('appends transcript misses without prompt_cache', () => {
    expect(perf({ payload: noPc(), options: { showMisses: true } })).toBe('86% · ~3.2s · 2 miss');
  });

  it('ignores transcript misses when the payload has prompt_cache', () => {
    expect(perf({ payload: withPc({ misses: undefined }), options: { showMisses: true } })).toBe(
      '94% · 16.9s',
    );
  });

  it('returns plain text unless display is badge', () => {
    const ctx = ctxWith({ payload: base(), transcript: () => tr() });
    expect(typeof getWidget('performance')!.render(ctx, { id: 'p', type: 'performance' })).toBe('string');
  });

  it.each([
    ['both good', { hit_ratio: 0.9, requests: 100 }, 500_000, {}, 'green'],
    ['slow time in one band', { hit_ratio: 0.9, requests: 10 }, 150_000, {}, 'yellow'],
    ['hit in one band', { hit_ratio: 0.6, requests: 100 }, 500_000, {}, 'yellow'],
    ['hit far below', { hit_ratio: 0.4, requests: 100 }, 500_000, {}, 'red'],
    ['time far above', { hit_ratio: 0.9, requests: 10 }, 250_000, {}, 'red'],
    ['worse of the two wins', { hit_ratio: 0.6, requests: 10 }, 250_000, {}, 'red'],
    ['custom hitWarn', { hit_ratio: 0.9, requests: 100 }, 500_000, { hitWarn: 95 }, 'yellow'],
    ['custom timeWarn', { hit_ratio: 0.9, requests: 10 }, 150_000, { timeWarn: 20 }, 'green'],
    ['show hit ignores time', { hit_ratio: 0.9, requests: 10 }, 250_000, { show: 'hit' }, 'green'],
  ] as const)('badge %s', (_name, pc, apiMs, options, expected) => {
    expect(color(withPc(pc, apiMs), options)).toBe(expected);
  });

  it('shows the loading placeholder before the first reply', () => {
    const fresh: StatusPayload = { context_window: { context_window_size: 200000, current_usage: null } };
    expect(perf({ payload: fresh, transcript: null })).toBe('loading…');
  });

  it('returns null without any data', () => {
    const p: StatusPayload = { context_window: { current_usage: { input_tokens: 10 } } };
    expect(perf({ payload: p, transcript: null })).toBeNull();
  });

  it('is opt-in in the tokens category', () => {
    expect(getWidget('performance')?.category).toBe('tokens');
    expect(JSON.stringify(defaultConfig())).not.toContain('"performance"');
  });
});

const SPAWNS = ['execFileSync', 'execSync', 'spawn', 'spawnSync', 'execFile', 'exec', 'fork'] as const;

describe.skipIf(fs.existsSync(path.join(os.tmpdir(), '.git')))('live widgets through real readers', () => {
  it('render workspace-repos, env-counts, turn-timer, tool-activity and permission-wait without spawning', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-live-perf-')));
    fx.managedDir = path.join(root, 'managed');
    fx.stopAt = root;
    const put = (file: string, text = 'x') => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    const j = (o: object) => JSON.stringify(o);
    const at = (s: number) => NOW.getTime() - s * 1000;
    const env = {
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CCINFOBAR_CACHE_DIR: path.join(root, 'cache'),
    };
    const ws = path.join(root, 'ws');
    for (const [name, branch] of [
      ['api', 'main'],
      ['web', 'dev'],
    ]) {
      put(path.join(ws, name!, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    }
    put(
      envelopeFile(reposKey(ws), env),
      j(okEnvelope(reposKey(ws), { dirty: { api: true, web: false } }, at(10))),
    );
    put(path.join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'));
    put(path.join(env.CLAUDE_CONFIG_DIR, 'rules', 'a.md'));
    put(
      path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
      j({ hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } }),
    );
    const transcript = path.join(root, 'session.jsonl');
    put(
      transcript,
      [
        j({
          type: 'user',
          timestamp: new Date(at(60)).toISOString(),
          promptId: 'p1',
          message: { content: 'go' },
        }),
        j({
          type: 'assistant',
          timestamp: new Date(at(8)).toISOString(),
          message: {
            id: 'm1',
            model: 'claude-sonnet-5-5',
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }),
      ]
        .map((l) => `${l}\n`)
        .join(''),
    );
    put(
      path.join(env.CCINFOBAR_CACHE_DIR, 'hooks', 'live-perf.jsonl'),
      `${[
        j({ v: 1, t: at(60), e: 'UserPromptSubmit', p: 'p1' }),
        j({ v: 1, t: at(52), e: 'Notification', n: 'permission_prompt' }),
        j({ v: 1, t: at(10), e: 'PermissionDenied', tn: 'Bash' }),
      ].join('\n')}\n`,
    );
    const ctx = createContext({
      payload: {
        session_id: 'live-perf',
        transcript_path: transcript,
        cwd: ws,
        workspace: { current_dir: ws, project_dir: ws },
      },
      config: {
        ...defaultConfig(),
        colorLevel: 0,
        lines: [
          [
            { id: 'r', type: 'workspace-repos', options: { dirty: true } },
            { id: 'e', type: 'env-counts' },
            { id: 't', type: 'turn-timer' },
            { id: 'a', type: 'tool-activity' },
            { id: 'w', type: 'permission-wait' },
          ],
        ],
      },
      env,
      now: NOW,
      preview: false,
    });
    const spies = SPAWNS.map((name) => vi.spyOn(cp, name));
    module.syncBuiltinESMExports();
    try {
      const lines = withoutSideEffects(() => render(ctx)).map(stripAnsi);
      expect(spies.map((s) => s.mock.calls.length)).toEqual(SPAWNS.map(() => 0));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('api (main*)');
      expect(lines[0]).toContain('CLAUDE.md 1');
      expect(lines[0]).toContain('Read a.ts');
      expect(lines[0]).toContain('Turn 1m00s');
      expect(lines[0]).toContain('Wait Bash 42s');
    } finally {
      vi.restoreAllMocks();
      module.syncBuiltinESMExports();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('phase 6 widgets through real readers', () => {
  it('render service-status, http, pr ci, provider, model, session-cost and context without side effects', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ext-perf-')));
    const env = {
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CCINFOBAR_CACHE_DIR: path.join(root, 'cache'),
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'perf-token',
    };
    const at = NOW.getTime() - 20_000;
    const put = (key: string, value: unknown) => {
      const file = envelopeFile(key, env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(okEnvelope(key, value, at)));
    };
    const url = 'https://relay.example.com/v1/balance';
    const headers = 'Authorization=Bearer $RELAY_TOKEN';
    put('status', {
      indicator: 'major',
      description: 'Partial System Outage',
      incidents: [
        { name: 'Elevated errors on Opus', impact: 'major', components: ['Claude API'], updatedAt: at },
      ],
    });
    put(httpKey(url, headers), { paths: { '$.data.balance': { ok: true, v: 12.5 } } });
    const payload: StatusPayload = { ...base(), model: { id: 'glm-5.3', display_name: 'glm-5.3' } };
    delete payload.rate_limits;
    put(ghKey(ghParam(payload)!), {
      pass: 9,
      fail: 2,
      pending: 0,
      skipped: 0,
      cancelled: 0,
      total: 11,
      names: [],
    });
    const ctx = createContext({
      payload,
      config: {
        ...defaultConfig(),
        colorLevel: 0,
        lines: [
          [
            { id: 's', type: 'service-status' },
            {
              id: 'h',
              type: 'http',
              options: { url, path: '$.data.balance', format: '${value}', decimals: 2, headers },
            },
            { id: 'p', type: 'pr', options: { ci: true } },
            { id: 'v', type: 'provider' },
            { id: 'm', type: 'model', options: { profileLabel: true } },
            { id: 'c', type: 'session-cost', options: { basis: 'auto' } },
            { id: 'x', type: 'context-percentage' },
          ],
        ],
      },
      env,
      now: NOW,
      preview: false,
    });
    const spies = SPAWNS.map((name) => vi.spyOn(cp, name));
    module.syncBuiltinESMExports();
    try {
      const lines = withoutSideEffects(() => render(ctx)).map(stripAnsi);
      expect(spies.map((s) => s.mock.calls.length)).toEqual(SPAWNS.map(() => 0));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('major: Elevated errors on Opus');
      expect(lines[0]).toContain('$12.50');
      expect(lines[0]).toContain('#128');
      expect(lines[0]).toContain('✗ 2');
      expect(lines[0]).toContain('GLM via api.z.ai');
      expect(lines[0]).toContain('GLM-5.3');
      expect(
        fs.readdirSync(path.join(env.CCINFOBAR_CACHE_DIR, 'jobs')).some((f) => f.endsWith('.lock')),
      ).toBe(false);
    } finally {
      vi.restoreAllMocks();
      module.syncBuiltinESMExports();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(fs.existsSync(path.join(os.tmpdir(), '.git')))('phase 7 render through real readers', () => {
  const files = (dir: string): string[] =>
    fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]) : [];

  function run(config: Config, git: () => ReturnType<typeof sampleGit> | null) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-p7-perf-')));
    const env = {
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CCINFOBAR_CACHE_DIR: path.join(root, 'cache'),
      CCINFOBAR_CONFIG_DIR: root,
    };
    const payload: StatusPayload = {
      ...base(),
      session_id: 'p7-perf',
      cwd: root,
      workspace: { current_dir: root, project_dir: root },
    };
    const ctx = createContext({
      payload,
      config,
      env,
      now: NOW,
      preview: false,
      terminalWidth: 60,
      data: { git },
    });
    const spies = SPAWNS.map((name) => vi.spyOn(cp, name));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    module.syncBuiltinESMExports();
    try {
      const lines = withoutSideEffects(() => {
        const out = render(ctx);
        syncProgress(ctx, env);
        return out;
      }).map(stripAnsi);
      return {
        lines,
        spawns: spies.map((s) => s.mock.calls.length),
        fetches: fetchSpy.mock.calls.length,
        progress: files(env.CCINFOBAR_CACHE_DIR).filter((f) => f.endsWith('.progress.json')),
      };
    } finally {
      vi.restoreAllMocks();
      module.syncBuiltinESMExports();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('the default config spawns nothing and writes no progress file', () => {
    const git = vi.fn(sampleGit);
    const r = run({ ...defaultConfig(), colorLevel: 0 }, git);
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.spawns).toEqual(SPAWNS.map(() => 0));
    expect(r.fetches).toBe(0);
    expect(r.progress).toEqual([]);
    const on = run({ ...defaultConfig(), colorLevel: 0, progress: { enabled: true } }, git);
    expect(on.progress).toEqual([path.join('hooks', 'p7-perf.progress.json')]);
  });

  it('rules, priority overflow, paste-safe and a gradient bar spawn and fetch nothing', () => {
    const git = vi.fn((): ReturnType<typeof sampleGit> | null => {
      throw new Error('spawned');
    });
    const config: Config = {
      ...defaultConfig(),
      colorLevel: 3,
      overflow: 'priority',
      glyphMode: 'paste-safe',
      lines: [
        [
          { id: 'm', type: 'model' },
          { id: 'b', type: 'context-bar', options: { barColor: 'gradient', width: 10 } },
          { id: 'g', type: 'text', options: { text: 'repo' }, showWhen: 'git' },
          { id: 'h', type: 'clock', hideWhen: 'time.hour in 0..23' },
          { id: 'c', type: 'session-cost', priority: 10 },
          { id: 'd', type: 'cwd', options: { style: 'full' }, priority: 5 },
        ],
      ],
      maxWidth: 50,
    };
    const r = run(config, git);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).not.toContain('repo');
    expect(r.lines[0]).not.toContain('ccib-p7-perf-');
    expect(r.lines[0]).toContain('$');
    expect(r.lines[0]).not.toContain('…');
    expect(visibleWidth(r.lines[0]!)).toBeLessThanOrEqual(50);
    expect(git).not.toHaveBeenCalled();
    expect(r.spawns).toEqual(SPAWNS.map(() => 0));
    expect(r.fetches).toBe(0);
    expect(r.progress).toEqual([]);
  });
});
