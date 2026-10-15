import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { sourcesFor } from '../../src/core/inspect.js';
import { render } from '../../src/core/renderer.js';
import { samplePayload } from '../../src/core/sample.js';
import { createTrace } from '../../src/core/trace.js';
import type { WidgetDef } from '../../src/core/types.js';
import {
  createJobReader,
  envelopeFile,
  failEnvelope,
  okEnvelope,
  writeEnvelope,
} from '../../src/data/jobs/runner.js';
import { NOW } from '../helpers.js';

const tmpEnv = (): NodeJS.ProcessEnv => ({
  CCINFOBAR_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-jobs-reader-')),
});

const jobReads = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => String(c[0])).filter((p) => p.split(path.sep).includes('jobs'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createJobReader', () => {
  it('reads an envelope once per key', () => {
    const env = tmpEnv();
    writeEnvelope(okEnvelope('status', { indicator: 'none' }, NOW.getTime() - 60_000), env);
    const spy = vi.spyOn(fs, 'readFileSync');
    const reader = createJobReader(env);
    expect(reader.job('status')?.value).toEqual({ indicator: 'none' });
    expect(reader.job('status')?.ok).toBe(true);
    expect(jobReads(spy)).toEqual([envelopeFile('status', env)]);
  });

  it('gives null for a missing or bad key', () => {
    const env = tmpEnv();
    const reader = createJobReader(env);
    expect(reader.job('status')).toBeNull();
    expect(reader.job('../status')).toBeNull();
    expect(reader.job('')).toBeNull();
  });

  it('gives null for a broken file', () => {
    const env = tmpEnv();
    fs.mkdirSync(path.dirname(envelopeFile('status', env)), { recursive: true });
    fs.writeFileSync(envelopeFile('status', env), '{nope');
    expect(createJobReader(env).job('status')).toBeNull();
  });
});

describe('context jobs', () => {
  const ctxFor = (env: NodeJS.ProcessEnv, types: string[]) =>
    createContext({
      payload: samplePayload(NOW.getTime()),
      config: { ...defaultConfig(), colorLevel: 0, lines: [types.map((type) => ({ id: type, type }))] },
      env,
      now: NOW,
      data: { git: () => null, gsd: () => null, transcript: () => null, agents: () => [] },
    });

  it('reads no job file for a layout without job widgets', () => {
    const env = tmpEnv();
    writeEnvelope(okEnvelope('status', { indicator: 'none' }, NOW.getTime()), env);
    const spy = vi.spyOn(fs, 'readFileSync');
    const ctx = ctxFor(env, ['model', 'context-percentage']);
    render(ctx);
    expect(typeof ctx.data.jobs).toBe('function');
    expect(jobReads(spy)).toEqual([]);
  });

  it('reads only the asked key', () => {
    const env = tmpEnv();
    writeEnvelope(okEnvelope('status', { indicator: 'none' }, NOW.getTime()), env);
    writeEnvelope(okEnvelope('gh-0000000000000000', { total: 1 }, NOW.getTime()), env);
    const spy = vi.spyOn(fs, 'readFileSync');
    const ctx = ctxFor(env, ['model']);
    expect(ctx.data.jobs?.().job('status')?.ok).toBe(true);
    expect(jobReads(spy)).toEqual([envelopeFile('status', env)]);
  });

  it('keeps an injected reader', () => {
    const job = vi.fn(() => null);
    const ctx = createContext({
      payload: samplePayload(NOW.getTime()),
      config: defaultConfig(),
      env: tmpEnv(),
      data: {
        git: () => null,
        gsd: () => null,
        transcript: () => null,
        agents: () => [],
        jobs: () => ({ job }),
      },
    });
    ctx.data.jobs?.().job('status');
    expect(job).toHaveBeenCalledWith('status');
  });
});

describe('job trace', () => {
  function traced(env: NodeJS.ProcessEnv) {
    const trace = createTrace();
    const ctx = trace.wrap(
      createContext({
        payload: samplePayload(NOW.getTime()),
        config: { ...defaultConfig(), colorLevel: 0 },
        env,
        now: NOW,
        data: { git: () => null, gsd: () => null, transcript: () => null, agents: () => [] },
      }),
    );
    return (key: string) => {
      trace.begin();
      ctx.data.jobs?.().job(key);
      return trace.end();
    };
  }

  it('records a job source with key, age and ok', () => {
    const env = tmpEnv();
    writeEnvelope(okEnvelope('status', { indicator: 'none' }, NOW.getTime() - 90_000), env);
    expect(traced(env)('status')).toEqual([
      { kind: 'job', path: 'status', age: 90_000, job: { key: 'status', ok: true } },
    ]);
  });

  it('records the error and blockedUntil of a failed job', () => {
    const env = tmpEnv();
    const at = NOW.getTime() - 10_000;
    writeEnvelope(failEnvelope('status', null, 'http-503', at, { blockMs: 60_000 }), env);
    expect(traced(env)('status')).toEqual([
      {
        kind: 'job',
        path: 'status',
        age: 10_000,
        job: { key: 'status', ok: false, error: 'http-503', blockedUntil: at + 60_000 },
      },
    ]);
  });

  it('marks a missing envelope absent', () => {
    expect(traced(tmpEnv())('status')).toEqual([{ kind: 'job', path: 'status', absent: true }]);
  });

  it('carries job fields into sources', () => {
    const def = { type: 'x' } as WidgetDef;
    const read = { kind: 'job', path: 'status', age: 5, job: { key: 'status', ok: true } } as const;
    expect(sourcesFor(def, { id: 'x', type: 'x' }, [read])).toEqual([
      { kind: 'job', path: 'status', age: 5, job: { key: 'status', ok: true } },
    ]);
  });
});
