import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runWorker } from '../../src/commands/worker.js';
import type { HttpPathResult, HttpValue } from '../../src/core/job-values.js';
import { sampleJobs } from '../../src/core/sample.js';
import type { RenderContext, WidgetItem } from '../../src/core/types.js';
import { httpJob } from '../../src/data/jobs/http.js';
import { httpKey } from '../../src/data/jobs/keys.js';
import { createJobReader, type JobEnvelope, type JobReader, jobsDir } from '../../src/data/jobs/runner.js';
import { httpState } from '../../src/widgets/http.js';
import { getWidget } from '../../src/widgets/index.js';
import { fakeFetch, json } from '../fake-fetch.js';
import { ctxWith, NOW, withoutSideEffects } from '../helpers.js';

const now = NOW.getTime();
const MIN = 60_000;
const URL_ = 'https://relay.example.com/balance';
const HEADERS = 'Authorization=Bearer $RELAY_TOKEN';
const KEY = httpKey(URL_, HEADERS);
const PATH = '$.data.balance';

const value = (paths: Record<string, HttpPathResult>): HttpValue => ({ paths });

const ok = (v: HttpValue, at = now - 30_000): JobEnvelope<HttpValue> => ({
  v: 1,
  key: KEY,
  fetchedAt: at,
  ok: true,
  value: v,
  attempts: 0,
  lastGood: v,
  lastGoodAt: at,
});

const failed = (lastGood: HttpValue | null, lastGoodAt?: number): JobEnvelope<HttpValue> => ({
  v: 1,
  key: KEY,
  fetchedAt: now - MIN,
  ok: false,
  value: null,
  error: 'http-503',
  attempts: 2,
  lastGood,
  ...(lastGoodAt !== undefined ? { lastGoodAt } : {}),
});

const reader = (e: JobEnvelope<unknown> | null, keys: string[] = []): JobReader => ({
  job<V>(key: string) {
    keys.push(key);
    return (key === KEY ? e : null) as JobEnvelope<V> | null;
  },
});

const def = getWidget('http')!;
const base = { url: URL_, headers: HEADERS, path: PATH };

function render(
  e: JobEnvelope<unknown> | null,
  options: WidgetItem['options'] = {},
  ctx?: RenderContext,
): { text: string; color?: string } | null {
  const c = ctx ?? ctxWith({ jobs: () => reader(e) });
  const out = withoutSideEffects(() =>
    def.render(c, { id: 'h', type: 'http', options: { ...base, ...options } }),
  );
  if (out === null || out === undefined) return null;
  return typeof out === 'string' ? { text: out } : out;
}

const text = (e: JobEnvelope<unknown> | null, options: WidgetItem['options'] = {}) =>
  render(e, options)?.text ?? null;

const balance = (v: HttpPathResult) => value({ [PATH]: v });

describe('http widget', () => {
  it('is an opt-in, time-based custom widget with documented options', () => {
    expect(def.category).toBe('custom');
    expect(def.timeBased).toBe(true);
    expect(def.sample).toBe('$12.50');
    const opts = def.options ?? [];
    expect(opts.map((o) => o.key)).toEqual([
      'url',
      'path',
      'format',
      'interval',
      'timeout',
      'headers',
      'decimals',
      'maxLength',
    ]);
    const defaults = Object.fromEntries(opts.map((o) => [o.key, o.default]));
    expect(defaults).toEqual({
      url: '',
      path: '$',
      format: '{value}',
      interval: 300,
      timeout: 5000,
      headers: '',
      decimals: -1,
      maxLength: 40,
    });
    for (const o of opts) expect(o.help, o.key).toBeTruthy();
    expect(opts.find((o) => o.key === 'headers')?.help).toContain('Authorization=Bearer $RELAY_TOKEN');
  });

  it('formats a number with decimals or as is', () => {
    const e = ok(balance({ ok: true, v: 12.5 }));
    expect(text(e, { format: '${value}', decimals: 2 })).toBe('$12.50');
    expect(text(e, { format: '${value}', decimals: -1 })).toBe('$12.5');
    expect(text(e, { format: '${value}' })).toBe('$12.5');
    expect(text(e, { decimals: 0 })).toBe('13');
    expect(text(e, { format: '{value} / {value}' })).toBe('12.5 / 12.5');
  });

  it('cuts long strings and strips escape sequences', () => {
    expect(text(ok(balance({ ok: true, v: 'abcdefghijklmnop' })), { maxLength: 10 })).toBe('abcdefghi…');
    const out = text(ok(balance({ ok: true, v: 'bad\u001b[31mred\u0007' })));
    expect(out).toBe('badred');
  });

  it('shows booleans and null as JSON words', () => {
    expect(text(ok(balance({ ok: true, v: true })))).toBe('true');
    expect(text(ok(balance({ ok: true, v: false })))).toBe('false');
    expect(text(ok(balance({ ok: true, v: null })))).toBe('null');
  });

  it('returns null for a miss, an object, no envelope, no url or a bad path', () => {
    expect(text(ok(balance({ ok: false, code: 'not-scalar' })))).toBeNull();
    expect(text(ok(balance({ ok: false, code: 'path-miss' })))).toBeNull();
    expect(text(ok(value({})))).toBeNull();
    expect(text(null)).toBeNull();
    expect(text(ok(balance({ ok: true, v: 1 })), { url: '' })).toBeNull();
    expect(text(ok(value({ '$..x': { ok: true, v: 1 } })), { path: '$..x' })).toBeNull();
    expect(text(ok(balance({ ok: true, v: { a: 1 } as never })))).toBeNull();
  });

  it('hides an item that would send env values over plain http or a denied env var', () => {
    const insecure = { url: 'http://relay.example.com/balance' };
    const e = ok(balance({ ok: true, v: 1 }));
    expect(text(e, insecure)).toBeNull();
    const item: WidgetItem = { id: 'h', type: 'http', options: { ...base, ...insecure } };
    expect(httpState(ctxWith({ jobs: () => reader(e) }), item)).toEqual({
      kind: 'bad-url',
      error: 'secrets need https or localhost',
      field: 'headers',
    });
    const denied: WidgetItem = {
      id: 'h',
      type: 'http',
      options: { ...base, headers: 'X=$ANTHROPIC_API_KEY' },
    };
    expect(text(e, denied.options)).toBeNull();
    expect(httpState(ctxWith({ jobs: () => reader(e) }), denied)).toEqual({
      kind: 'bad-url',
      error: 'env ANTHROPIC_API_KEY is not allowed in http items',
      field: 'headers',
    });
  });

  it('defaults the path to $', () => {
    expect(text(ok(value({ $: { ok: true, v: 7 } })), { path: '' })).toBe('7');
    expect(text(ok(value({ $: { ok: true, v: 7 } })), { path: undefined as never })).toBe('7');
  });

  it('keeps the last good value and marks it after the stale window', () => {
    const v = balance({ ok: true, v: 12.5 });
    const muted = ctxWith().theme?.colors.muted ?? 'brightBlack';
    expect(render(failed(v, now - 10 * MIN))).toEqual({ text: '12.5' });
    expect(render(failed(v, now - 20 * MIN))).toEqual({ text: '12.5 ?', color: muted });
    expect(render(failed(v, now - 25 * MIN), { interval: 600 })).toEqual({ text: '12.5' });
    expect(render(failed(v, now - 31 * MIN), { interval: 600 })?.text).toBe('12.5 ?');
    expect(render(failed(v, now - 25 * 60 * MIN))).toBeNull();
    expect(render(failed(v))).toBeNull();
    expect(render(failed(null))).toBeNull();
  });

  it('floors the stale window at 15 minutes for short intervals', () => {
    const v = balance({ ok: true, v: 1 });
    expect(render(failed(v, now - 14 * MIN), { interval: 30 })?.text).toBe('1');
    expect(render(failed(v, now - 16 * MIN), { interval: 30 })?.text).toBe('1 ?');
  });

  it('treats an old success like a stale one', () => {
    const v = balance({ ok: true, v: 3 });
    expect(render(ok(v, now - 20 * MIN))?.text).toBe('3 ?');
    expect(render(ok(v, now - 25 * 60 * MIN))).toBeNull();
  });

  it('reads only its own envelope key', () => {
    const keys: string[] = [];
    const c = ctxWith({ jobs: () => reader(ok(balance({ ok: true, v: 1 })), keys) });
    render(null, {}, c);
    expect(keys).toEqual([KEY]);
    const other = ctxWith({ jobs: () => reader(ok(balance({ ok: true, v: 1 }))) });
    expect(render(null, { headers: 'X-Key=$OTHER' }, other)).toBeNull();
  });

  it('never fetches or reads env secrets while rendering', () => {
    const reads: string[] = [];
    const env = new Proxy({ RELAY_TOKEN: 'tok-SECRET' } as NodeJS.ProcessEnv, {
      get(t, k) {
        if (typeof k === 'string') reads.push(k);
        return Reflect.get(t, k);
      },
    });
    const c = ctxWith({ env, jobs: () => reader(ok(balance({ ok: true, v: 1 }))) });
    reads.length = 0;
    expect(render(null, {}, c)?.text).toBe('1');
    expect(reads).not.toContain('RELAY_TOKEN');
  });

  it('renders the sample reader value for any path', () => {
    const c = ctxWith({ jobs: () => sampleJobs(now) });
    expect(render(null, { path: '$.anything[0]' }, c)?.text).toBe('42.5');
  });
});

describe('http worker round trip', () => {
  it('fetches in the worker and shows the value, then keeps it on failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-http-rt-'));
    const env: NodeJS.ProcessEnv = {
      CCINFOBAR_CACHE_DIR: path.join(root, 'cache'),
      CCINFOBAR_CONFIG_DIR: path.join(root, 'config'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      HOME: root,
      RELAY_TOKEN: 'tok-SECRET-rt',
    };
    const cfgFile = path.join(root, 'config.json');
    const item = { id: 'h', type: 'http', options: { ...base, format: '${value}', decimals: 2 } };
    fs.writeFileSync(cfgFile, JSON.stringify({ lines: [[item]] }));
    fs.mkdirSync(jobsDir(env), { recursive: true });
    const args = parseArgs(['worker', KEY]);
    const first = fakeFetch([json({ data: { balance: 12.5 } })]);
    await runWorker(args, cfgFile, {
      jobs: [httpJob],
      env,
      silent: false,
      exit: () => {},
      fetch: first.fetch,
      now: () => now,
    });
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]!.headers.authorization).toBe('Bearer tok-SECRET-rt');
    const show = () =>
      withoutSideEffects(() =>
        def.render(ctxWith({ env, jobs: () => createJobReader(env) }), item as WidgetItem),
      );
    expect(show()).toBe('$12.50');
    const second = fakeFetch([json({ error: 'down' }, 503)]);
    await runWorker(args, cfgFile, {
      jobs: [httpJob],
      env,
      silent: false,
      exit: () => {},
      fetch: second.fetch,
      now: () => now,
    });
    expect(second.calls).toHaveLength(1);
    expect(createJobReader(env).job(KEY)?.ok).toBe(false);
    expect(show()).toBe('$12.50');
    for (const name of fs.readdirSync(jobsDir(env))) {
      expect(fs.readFileSync(path.join(jobsDir(env), name), 'utf8')).not.toContain('SECRET');
    }
  });
});
