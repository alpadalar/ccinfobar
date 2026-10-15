import cp from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runExplain, sourceText } from '../../src/commands/explain.js';
import type { CliIo } from '../../src/commands/io.js';
import { configDir, lastPayloadPath } from '../../src/core/paths.js';
import type { StatusPayload, WidgetDef } from '../../src/core/types.js';
import { failEnvelope, jobsDir, okEnvelope, writeEnvelope } from '../../src/data/jobs/runner.js';
import { usageKey } from '../../src/data/usage.js';
import { withoutSideEffects } from '../helpers.js';

vi.mock('../../src/widgets/index.js', async (orig) => {
  const mod = await orig<typeof import('../../src/widgets/index.js')>();
  const probe: WidgetDef = {
    type: 'job-probe',
    name: 'Job probe',
    category: 'custom',
    description: '',
    color: 'white',
    render(ctx) {
      const e = ctx.data.jobs?.()?.job('status');
      return e?.ok ? 'up' : null;
    },
  };
  return {
    ...mod,
    ALL_WIDGETS: [...mod.ALL_WIDGETS, probe],
    getWidget: (type: string) => (type === 'job-probe' ? probe : mod.getWidget(type)),
  };
});

const PROBE = { lines: [[{ id: 'probe', type: 'job-probe' }]] };
const FIVE = { lines: [[{ id: 'five', type: 'five-hour-usage' }]] };
const PROVIDER = /^(CLAUDE_CODE_USE_|ANTHROPIC_)|^CLAUDE_CODE_OAUTH_TOKEN$|^CCINFOBAR_NO_USAGE_API$/;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of Object.keys(process.env)) {
    if (PROVIDER.test(k)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  fs.rmSync(jobsDir(), { recursive: true, force: true });
});

afterEach(() => {
  Object.assign(process.env, saved);
  process.exitCode = undefined;
  fs.rmSync(lastPayloadPath(), { force: true });
  fs.rmSync(jobsDir(), { recursive: true, force: true });
  vi.restoreAllMocks();
  module.syncBuiltinESMExports();
});

function cfgFile(cfg: object): string {
  fs.mkdirSync(configDir(), { recursive: true });
  const file = path.join(configDir(), 'explain-jobs.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
}

function savePayload(extra: StatusPayload = {}): void {
  const p: StatusPayload = { session_id: 'explain-jobs', version: '2.1.401', model: { id: 'm' }, ...extra };
  fs.mkdirSync(path.dirname(lastPayloadPath()), { recursive: true });
  fs.writeFileSync(lastPayloadPath(), JSON.stringify(p));
}

function run(argv: string[], cfg: object): string[] {
  const out: string[] = [];
  const io: CliIo = { tty: false, log: (l) => out.push(l), error: (l) => out.push(l) };
  runExplain(parseArgs(['explain', ...argv]), cfgFile(cfg), io);
  return out;
}

const rowOf = (out: string[], name: string) => out.find((l) => l.includes(` ${name}: `)) ?? '';

describe('explain job sources', () => {
  it('shows the job key, age and ok', () => {
    savePayload();
    writeEnvelope(okEnvelope('status', { indicator: 'none' }, Date.now() - 2 * 60_000));
    const row = rowOf(run([], PROBE), 'probe (job-probe)');
    expect(row).toMatch(/: up ← job status, 2m old, ok$/);
  });

  it('shows the error code and the retry time of a failed job', () => {
    savePayload();
    const now = Date.now();
    writeEnvelope(failEnvelope('status', null, 'http-503', now - 60_000, { retryMs: 5 * 60_000 }));
    const row = rowOf(run([], PROBE), 'probe (job-probe)');
    expect(row).toMatch(/← job status, 1m old, error http-503, retry in 4m$/);
    const past = { key: 'status', ok: false, blockedUntil: now - 1 };
    expect(sourceText({ kind: 'job', path: 'status', age: 0, job: past }, now)).toBe(
      'job status, 0s old, error',
    );
  });

  it('puts the job fields in --json', () => {
    savePayload();
    const now = Date.now();
    writeEnvelope({
      v: 1,
      key: 'status',
      fetchedAt: now - 60_000,
      ok: false,
      value: null,
      error: 'http-503',
      blockedUntil: now + 240_000,
      attempts: 1,
      lastGood: { indicator: 'none' },
      lastGoodAt: now - 120_000,
    });
    const obj = JSON.parse(run(['--json'], PROBE).join('\n'));
    expect(obj.widgets[0].sources).toEqual([
      {
        kind: 'job',
        path: 'status',
        age: expect.any(Number),
        job: { key: 'status', ok: false, error: 'http-503', blockedUntil: now + 240_000 },
      },
    ]);
  });

  it('names the usage job behind usage-backed limits', () => {
    savePayload();
    const resets = Math.floor(Date.now() / 1000) + 3600;
    writeEnvelope(
      okEnvelope(
        usageKey(),
        { rate_limits: { five_hour: { used_percentage: 40, resets_at: resets } } },
        Date.now() - 4 * 60_000,
      ),
    );
    const row = rowOf(run([], FIVE), 'five (five-hour-usage)');
    expect(row).toMatch(/: 40% ← usage cache \(job usage-[0-9a-f]{16}, age 4m\)$/);
    const obj = JSON.parse(run(['--json'], FIVE).join('\n'));
    expect(obj.widgets[0].sources[0]).toMatchObject({
      kind: 'usage-cache',
      job: { key: usageKey(), ok: true },
    });
  });

  it('uses sampleJobs without a saved payload', () => {
    fs.rmSync(lastPayloadPath(), { force: true });
    const row = rowOf(run([], PROBE), 'probe (job-probe)');
    expect(row).toMatch(/: up ← job status, 30s old, ok$/);
    expect(fs.existsSync(jobsDir())).toBe(false);
  });

  it('reads job files without scheduling or locking', () => {
    savePayload();
    writeEnvelope(okEnvelope('status', { indicator: 'none' }, Date.now() - 10 * 60 * 60_000));
    const before = fs.readdirSync(jobsDir()).sort();
    const spawn = vi.spyOn(cp, 'spawn');
    module.syncBuiltinESMExports();
    const out = withoutSideEffects(() => run([], PROBE));
    expect(rowOf(out, 'probe (job-probe)')).toContain('job status');
    expect(fs.readdirSync(jobsDir()).sort()).toEqual(before);
    expect(spawn).not.toHaveBeenCalled();
  });
});
