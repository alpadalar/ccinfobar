import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config.js';
import type { StatusValue } from '../../../src/core/job-values.js';
import type { Config, WidgetItem } from '../../../src/core/types.js';
import { JOBS, jobFor, scheduleJobs } from '../../../src/data/jobs/index.js';
import { executeJob, type JobCtx, type JobEnvelope, readEnvelope } from '../../../src/data/jobs/runner.js';
import { parseSummary, STATUS_URL, statusJob } from '../../../src/data/jobs/status.js';
import { fakeFetch, json } from '../../fake-fetch.js';

const NOW = 1_800_000_000_000;

const sandbox = (): NodeJS.ProcessEnv => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-status-'));
  return {
    HOME: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'cfg'),
    CCINFOBAR_NO_UPDATE: '1',
  };
};

const item = (options: WidgetItem['options'] = {}, id = 's1'): WidgetItem => ({
  id,
  type: 'service-status',
  options,
});

const withItems = (...items: WidgetItem[]): Config => ({ ...defaultConfig(), lines: [items] });
const plain = (): Config => ({ ...defaultConfig(), lines: [[{ id: 'm', type: 'model' }]] });

const incident = (name: string, impact: string, updated: string, extra: Record<string, unknown> = {}) => ({
  id: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  status: 'investigating',
  impact,
  created_at: '2026-10-14T10:00:00.000Z',
  updated_at: updated,
  shortlink: 'https://stspg.io/x',
  incident_updates: [{ id: 'u1', status: 'investigating', body: 'SECRET-BODY long update text' }],
  components: [
    { id: 'c1', name: 'Claude API (api.anthropic.com)', status: 'degraded_performance' },
    { id: 'c2', name: 'Claude Code', status: 'operational' },
  ],
  ...extra,
});

const summary = (indicator: string, description: string, incidents: unknown[] = []) => ({
  page: { id: 'tymt9n04zgry', name: 'Claude', url: 'https://status.claude.com' },
  components: [{ id: 'c1', name: 'Claude API (api.anthropic.com)', status: 'operational' }],
  incidents,
  scheduled_maintenances: [],
  status: { indicator, description },
});

describe('parseSummary', () => {
  it('reads an all-clear summary', () => {
    expect(parseSummary(summary('none', 'All Systems Operational'))).toEqual({
      indicator: 'none',
      description: 'All Systems Operational',
      incidents: [],
    });
  });

  it('orders incidents by severity then recency and keeps only names', () => {
    const v = parseSummary(
      summary('major', 'Partial System Outage', [
        incident('Elevated errors on Opus', 'minor', '2026-10-14T12:00:00.000Z'),
        incident('API outage', 'major', '2026-10-14T09:00:00.000Z'),
        incident('Monitoring a fix', 'none', '2026-10-14T13:00:00.000Z'),
      ]),
    )!;
    expect(v.incidents.map((i) => [i.name, i.impact])).toEqual([
      ['API outage', 'major'],
      ['Elevated errors on Opus', 'minor'],
      ['Monitoring a fix', 'none'],
    ]);
    expect(v.incidents[0]).toEqual({
      name: 'API outage',
      impact: 'major',
      components: ['Claude API (api.anthropic.com)', 'Claude Code'],
      updatedAt: '2026-10-14T09:00:00.000Z',
    });
    expect(JSON.stringify(v)).not.toContain('SECRET-BODY');
    expect(JSON.stringify(v)).not.toContain('incident_updates');
  });

  it('puts the newest first within the same impact', () => {
    const v = parseSummary(
      summary('minor', 'Minor', [
        incident('Old', 'minor', '2026-10-14T08:00:00.000Z'),
        incident('New', 'minor', '2026-10-14T11:00:00.000Z'),
        incident('No date', 'minor', 'garbage'),
      ]),
    )!;
    expect(v.incidents.map((i) => i.name)).toEqual(['New', 'Old', 'No date']);
  });

  it('treats unknown indicators and impacts as minor', () => {
    const v = parseSummary(summary('weird', 'Something', [incident('X', 'catastrophic', 'z')]))!;
    expect(v.indicator).toBe('minor');
    expect(v.incidents[0]?.impact).toBe('minor');
    expect(parseSummary({ status: { description: 'no indicator' } })?.indicator).toBe('minor');
    expect(parseSummary(summary('maintenance', 'Under maintenance'))?.indicator).toBe('maintenance');
  });

  it('sanitizes every string and cuts it to 200 characters', () => {
    const evil = 'Bad \u001b]8;;x\u0007link\u001b[31m red\u202e';
    const v = parseSummary(
      summary('minor', `${evil} desc`, [
        incident(evil, 'minor', '2026-10-14T12:00:00.000Z', {
          components: [{ name: `\u001b]0;title\u0007${'c'.repeat(300)}` }],
        }),
      ]),
    )!;
    expect(v.description).toBe('Bad link red desc');
    expect(v.incidents[0]?.name).toBe('Bad link red');
    expect(v.incidents[0]?.components[0]).toBe('c'.repeat(200));
    expect(JSON.stringify(v)).not.toMatch(/\\u001b|\\u0007|\u202e/);
  });

  it('keeps at most 5 incidents and 10 components each', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      incident(`I${i}`, 'minor', `2026-10-14T0${i}:00:00.000Z`, {
        components: Array.from({ length: 12 }, (_, j) => ({ name: `c${j}` })),
      }),
    );
    const v = parseSummary(summary('minor', 'Minor', many))!;
    expect(v.incidents.map((i) => i.name)).toEqual(['I6', 'I5', 'I4', 'I3', 'I2']);
    expect(v.incidents[0]?.components).toHaveLength(10);
  });

  it('skips malformed and resolved incidents', () => {
    const v = parseSummary(
      summary('minor', 'Minor', [
        null,
        'text',
        [],
        { name: 42, impact: 'major' },
        incident('Done', 'critical', '2026-10-14T12:00:00.000Z', { status: 'resolved' }),
        incident('Kept', 'minor', 'x', { components: 'not-an-array', updated_at: 5 }),
      ]),
    )!;
    expect(v.incidents).toEqual([{ name: 'Kept', impact: 'minor', components: [], updatedAt: null }]);
  });

  it('returns null for a body that is not a summary', () => {
    for (const body of [null, undefined, 'x', 3, [], {}, { status: 'none' }])
      expect(parseSummary(body)).toBeNull();
  });

  it('reads incidents only, never the top-level components', () => {
    const body = summary('minor', 'Degraded', []);
    body.components = [{ id: 'c1', name: 'Claude Code', status: 'major_outage' }];
    expect(parseSummary(body)?.incidents).toEqual([]);
  });
});

describe('statusJob.keys', () => {
  const keys = (config: Config, env = sandbox()) =>
    statusJob.keys({ config, payload: {}, env, cwd: '/', now: NOW });

  it('asks for nothing without a service-status item', () => {
    expect(keys(plain())).toEqual([]);
  });

  it('defaults to 180 s and clamps to 120..600', () => {
    expect(keys(withItems(item()))).toEqual([{ key: 'status', ttlMs: 180_000 }]);
    expect(keys(withItems(item({ interval: 30 })))).toEqual([{ key: 'status', ttlMs: 120_000 }]);
    expect(keys(withItems(item({ interval: 900 })))).toEqual([{ key: 'status', ttlMs: 600_000 }]);
    expect(keys(withItems(item({ interval: 'junk' })))).toEqual([{ key: 'status', ttlMs: 180_000 }]);
  });

  it('uses the smallest interval across items', () => {
    const cfg: Config = {
      ...defaultConfig(),
      lines: [[item({ interval: 400 }, 'a')], [item({ interval: '250' }, 'b'), item({}, 'c')]],
    };
    expect(keys(cfg)).toEqual([{ key: 'status', ttlMs: 180_000 }]);
    expect(keys(withItems(item({ interval: 400 }, 'a'), item({ interval: 250 }, 'b')))).toEqual([
      { key: 'status', ttlMs: 250_000 },
    ]);
  });

  it('accepts only the status key while an item exists', () => {
    const input = { config: withItems(item()), env: sandbox(), cwd: '/' };
    expect(statusJob.accepts({ key: 'status' }, input)).toBe(true);
    expect(statusJob.accepts({ key: 'status-x' }, input)).toBe(false);
    expect(statusJob.accepts({ key: 'status' }, { ...input, config: plain() })).toBe(false);
  });

  it('is registered and declared as automatic network', () => {
    expect(JOBS).toContain(statusJob);
    expect(jobFor('status')).toBe(statusJob);
    expect(jobFor('status-1')).not.toBe(statusJob);
    expect(statusJob).toMatchObject({ id: 'status', network: 'auto', lockMs: 60_000, retryMs: 60_000 });
  });
});

describe('statusJob.due', () => {
  const ok = (fetchedAt: number): JobEnvelope<StatusValue> => ({
    v: 1,
    key: 'status',
    fetchedAt,
    ok: true,
    value: { indicator: 'none', description: '', incidents: [] },
  });

  it('follows the requested ttl', () => {
    expect(statusJob.due(null, NOW, { key: 'status' })).toBe(true);
    expect(statusJob.due(ok(NOW - 170_000), NOW, { key: 'status' })).toBe(false);
    expect(statusJob.due(ok(NOW - 180_000), NOW, { key: 'status' })).toBe(true);
    expect(statusJob.due(ok(NOW - 130_000), NOW, { key: 'status', ttlMs: 120_000 })).toBe(true);
    expect(statusJob.due(ok(NOW - 500_000), NOW, { key: 'status', ttlMs: 600_000 })).toBe(false);
  });
});

describe('statusJob.run', () => {
  const ctx = (env: NodeJS.ProcessEnv, f: typeof fetch, now: number): JobCtx<StatusValue> => ({
    env,
    config: withItems(item()),
    cwd: '/',
    prev: readEnvelope<StatusValue>('status', env),
    fetch: f,
    now,
  });
  const run = (env: NodeJS.ProcessEnv, f: typeof fetch, now = NOW) =>
    executeJob(statusJob, { key: 'status' }, ctx(env, f, now));

  it('writes an ok envelope from one request to the fixed URL', async () => {
    const env = sandbox();
    const body = summary('minor', 'Minor Service Outage', [
      incident('Slow', 'minor', '2026-10-14T12:00:00Z'),
    ]);
    const { fetch: f, calls } = fakeFetch([json(body)]);
    const out = await run(env, f);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: STATUS_URL, method: 'GET', redirect: 'manual' });
    expect(calls[0]?.headers['user-agent']).toBe('ccinfobar');
    expect(STATUS_URL).toBe('https://status.claude.com/api/v2/summary.json');
    expect(out).toMatchObject({ key: 'status', ok: true, fetchedAt: NOW, attempts: 0, lastGoodAt: NOW });
    expect(out.value?.indicator).toBe('minor');
    expect(readEnvelope('status', env)).toEqual(out);
    const raw = fs.readFileSync(path.join(env.CCINFOBAR_CACHE_DIR!, 'jobs', 'status.json'), 'utf8');
    expect(raw).not.toContain('SECRET-BODY');
  });

  it('backs off from 60 s on failures and keeps the last good value', async () => {
    const env = sandbox();
    await run(env, fakeFetch([json(summary('none', 'All Systems Operational'))]).fetch, NOW - 300_000);
    const first = await run(env, fakeFetch([json({ err: 'x' }, 500)]).fetch, NOW);
    expect(first).toMatchObject({ ok: false, error: 'http-500', blockedUntil: NOW + 60_000, attempts: 1 });
    expect(first.lastGood?.description).toBe('All Systems Operational');
    expect(first.lastGoodAt).toBe(NOW - 300_000);
    const second = await run(env, fakeFetch([json({}, 500)]).fetch, NOW + 60_000);
    expect(second).toMatchObject({ error: 'http-500', blockedUntil: NOW + 60_000 + 120_000, attempts: 2 });
    expect(second.lastGood?.description).toBe('All Systems Operational');
    expect(second.lastGoodAt).toBe(NOW - 300_000);
  });

  it('caps the backoff at 30 minutes', async () => {
    const env = sandbox();
    let out: JobEnvelope<StatusValue> | null = null;
    for (let i = 0; i < 8; i++) out = await run(env, fakeFetch([json({}, 502)]).fetch, NOW + i);
    expect(out!.blockedUntil).toBe(NOW + 7 + 1_800_000);
  });

  it('honours Retry-After on 429', async () => {
    const env = sandbox();
    const out = await run(env, fakeFetch([json({}, 429, { 'retry-after': '600' })]).fetch);
    expect(out).toMatchObject({ error: 'http-429', blockedUntil: NOW + 600_000 });
  });

  it('stores fixed codes for bad bodies and network errors', async () => {
    const env = sandbox();
    expect((await run(env, fakeFetch([json(['not', 'a', 'summary'])]).fetch)).error).toBe('bad-json');
    const leak = Object.assign(new TypeError('fetch failed for https://x.test/?key=SECRET'), {
      cause: { code: 'ENOTFOUND' },
    });
    const out = await run(env, fakeFetch([leak]).fetch);
    expect(out.error).toBe('dns');
    const raw = fs.readFileSync(path.join(env.CCINFOBAR_CACHE_DIR!, 'jobs', 'status.json'), 'utf8');
    expect(raw).not.toContain('SECRET');
  });

  it('refuses a redirect off the status host', async () => {
    const env = sandbox();
    const { fetch: f, calls } = fakeFetch([
      new Response(null, { status: 302, headers: { location: 'https://evil.test/summary.json' } }),
    ]);
    expect((await run(env, f)).error).toBe('cross-origin-redirect');
    expect(calls).toHaveLength(1);
  });
});

describe('scheduling', () => {
  const schedule = (env: NodeJS.ProcessEnv, config: Config) =>
    scheduleJobs(config, {}, env, '/', null, { now: NOW, spawn: () => true });

  it('schedules status only with a service-status item', () => {
    expect(schedule(sandbox(), withItems(item()))).toContain('status');
    expect(schedule(sandbox(), plain())).not.toContain('status');
  });

  it('never schedules status when nonessential traffic is off', () => {
    const env = { ...sandbox(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    expect(schedule(env, withItems(item()))).not.toContain('status');
    const env0 = { ...sandbox(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' };
    expect(schedule(env0, withItems(item()))).not.toContain('status');
  });
});
