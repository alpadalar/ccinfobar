import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../../src/core/config.js';
import type { Config } from '../../../src/core/types.js';
import {
  envelopeFile,
  executeJob,
  type JobCtx,
  type JobEnvelope,
  okEnvelope,
  readEnvelope,
  writeEnvelope,
} from '../../../src/data/jobs/runner.js';
import { usageJob } from '../../../src/data/jobs/usage.js';
import { readLimitsStore } from '../../../src/data/limits.js';
import {
  fetchUsage,
  fetchUsageEnvelope,
  fromUsageCache,
  legacyUsageFile,
  readUsageCache,
  toUsageCache,
  type UsageCache,
  type UsageValue,
  usageDue,
  usageFile,
  usageKey,
} from '../../../src/data/usage.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const LATER = NOW + 200_000;
const ACCT = '5c32ef41ffffd83d';
const ACCT_B = '0198e53e74dd6451';

const creds = (claude: string, token: string) =>
  fs.writeFileSync(
    path.join(claude, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: NOW + 86_400_000 },
    }),
  );

function sandbox(token: string | null): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-usagejob-'));
  const claude = path.join(dir, 'claude');
  fs.mkdirSync(claude);
  if (token) creds(claude, token);
  return {
    CLAUDE_CONFIG_DIR: claude,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
    CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
    HOME: path.join(dir, 'home'),
  };
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
const throws = (async () => {
  throw new Error('boom');
}) as unknown as typeof fetch;

const RATE = {
  five_hour: { used_percentage: 5, resets_at: '2026-10-12T15:00:00Z' },
  seven_day: { used_percentage: 50, resets_at: '2026-10-15T00:00:00Z' },
};
const OK = () =>
  reply(200, {
    five_hour: { utilization: 5, resets_at: '2026-10-12T15:00:00Z' },
    seven_day: { utilization: 50, resets_at: '2026-10-15T00:00:00Z' },
  });

// captured from the pre-runner fetchUsage
const OK_CACHE: UsageCache = { fetchedAt: NOW, rate_limits: RATE, account: ACCT };
const kept = (error: string, blockedUntil: number): UsageCache => ({
  rate_limits: RATE,
  account: ACCT,
  fetchedAt: NOW,
  error,
  blockedUntil,
});
const BRANCHES: [string, () => typeof fetch, UsageCache][] = [
  [
    '429 with retry-after',
    () => reply(429, {}, { 'retry-after': '120' }),
    kept('rate limited by the usage API', 1791806720000),
  ],
  ['429 without retry-after', () => reply(429, {}), kept('rate limited by the usage API', 1791806900000)],
  ['500', () => reply(500, {}), kept('usage API returned 500', 1791806660000)],
  ['ok with no limits', () => reply(200, {}), kept('usage API sent no limits', 1791806900000)],
  ['fetch throws', () => throws, kept('boom', 1791806660000)],
];

const envelope = (env: NodeJS.ProcessEnv) => readEnvelope<UsageValue>(usageKey(env), env);
const adapted = (env: NodeJS.ProcessEnv) => {
  const e = envelope(env);
  return e ? toUsageCache(e) : null;
};
const at = (ms: number) => vi.setSystemTime(ms);

const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
    : [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('usage job equivalence', () => {
  it('backs off without a login exactly as before', async () => {
    const env = sandbox(null);
    const expected = { fetchedAt: NOW, error: 'no Claude login found', blockedUntil: 1791807000000 };
    expect(await fetchUsage(env, OK())).toEqual(expected);
    expect(adapted(env)).toEqual(expected);
    expect(envelope(env)).toMatchObject({ ok: false, value: null, lastGood: null });
  });

  it('stores a successful reply as an ok envelope', async () => {
    const env = sandbox('tok');
    expect(await fetchUsage(env, OK())).toEqual(OK_CACHE);
    expect(adapted(env)).toEqual(OK_CACHE);
    expect(envelope(env)).toMatchObject({
      v: 1,
      key: usageKey(env),
      ok: true,
      fetchedAt: NOW,
      value: { rate_limits: RATE, account: ACCT },
      lastGoodAt: NOW,
      attempts: 0,
    });
  });

  for (const [name, f, expected] of BRANCHES) {
    it(`keeps the last limits through ${name}`, async () => {
      const env = sandbox('tok');
      await fetchUsage(env, OK());
      at(LATER);
      expect(await fetchUsage(env, f())).toEqual(expected);
      expect(adapted(env)).toEqual(expected);
      expect(readUsageCache(env)).toEqual(expected);
    });
  }

  it('maps a failure back to the observation time and the same due rule', async () => {
    const env = sandbox('tok');
    await fetchUsage(env, OK());
    at(LATER);
    const old = await fetchUsage(env, reply(500, {}));
    const e = envelope(env)!;
    expect(e).toMatchObject({ ok: false, fetchedAt: LATER, lastGoodAt: NOW, attempts: 1, value: null });
    const c = toUsageCache(e);
    expect(c).toMatchObject({ fetchedAt: NOW, rate_limits: RATE, error: 'usage API returned 500' });
    expect(c.blockedUntil).toBe(old.blockedUntil);
    for (const t of [LATER, LATER + 59_999, LATER + 60_000, LATER + 600_000]) {
      expect(usageDue(c, t)).toBe(usageDue(old, t));
    }
    expect(usageJob.due(e, LATER + 1, { key: usageKey(env) })).toBe(false);
    expect(usageJob.due(e, LATER + 60_000, { key: usageKey(env) })).toBe(true);
    at(LATER + 60_000);
    await fetchUsage(env, reply(500, {}));
    expect(envelope(env)).toMatchObject({ attempts: 2, lastGoodAt: NOW });
  });

  it('drops the previous account limits on a login change', async () => {
    const env = sandbox('tok-a');
    await fetchUsage(env, OK());
    creds(env.CLAUDE_CONFIG_DIR!, 'tok-b');
    at(LATER);
    const expected = {
      account: ACCT_B,
      fetchedAt: LATER,
      error: 'usage API returned 500',
      blockedUntil: 1791806660000,
    };
    expect(await fetchUsage(env, reply(500, {}))).toEqual(expected);
    const e = envelope(env)!;
    expect(e.lastGood?.rate_limits).toBeUndefined();
    expect(e.lastGoodAt).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('used_percentage');
    expect(toUsageCache(e)).toEqual(expected);
    expect(toUsageCache(e).rate_limits).toBeUndefined();
  });

  it('feeds the limits store on success and resets it on an account change', async () => {
    const env = sandbox('tok-a');
    await fetchUsage(env, OK());
    expect(readLimitsStore(env)?.windows.five_hour).toMatchObject({ pct: 5, at: NOW, src: 'usage-api' });
    creds(env.CLAUDE_CONFIG_DIR!, 'tok-b');
    at(LATER);
    await fetchUsage(env, reply(500, {}));
    expect(readLimitsStore(env)?.windows).toEqual({});
  });
});

describe('usage cache files', () => {
  const put = (file: string, v: object) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(v));
  };

  it('writes only the envelope', async () => {
    const env = sandbox('tok');
    await fetchUsage(env, OK());
    at(LATER);
    await fetchUsage(env, reply(500, {}));
    expect(fs.existsSync(usageFile(env))).toBe(false);
    expect(fs.existsSync(legacyUsageFile(env))).toBe(false);
    expect(fs.existsSync(envelopeFile(usageKey(env), env))).toBe(true);
    expect(path.basename(envelopeFile(usageKey(env), env))).toMatch(/^usage-[0-9a-f]{16}\.json$/);
  });

  it('falls back to the account file, then the legacy file', () => {
    const env = sandbox(null);
    const { CLAUDE_CONFIG_DIR: _, ...bare } = env;
    put(legacyUsageFile(env), { fetchedAt: 5, rate_limits: { five_hour: { used_percentage: 33 } } });
    expect(readUsageCache(bare)).toMatchObject({ fetchedAt: 5, legacy: true });
    expect(readUsageCache(env)).toBeNull();
    put(usageFile(bare), { fetchedAt: 7, rate_limits: { five_hour: { used_percentage: 44 } } });
    expect(readUsageCache(bare)).toEqual({
      fetchedAt: 7,
      rate_limits: { five_hour: { used_percentage: 44 } },
    });
    put(usageFile(env), { fetchedAt: 8, error: 'x' });
    expect(readUsageCache(env)).toEqual({ fetchedAt: 8, error: 'x' });
  });

  it('prefers the envelope over both legacy files', () => {
    const env = sandbox(null);
    const { CLAUDE_CONFIG_DIR: _, ...bare } = env;
    put(legacyUsageFile(env), { fetchedAt: 5 });
    put(usageFile(bare), { fetchedAt: 7 });
    writeEnvelope(okEnvelope(usageKey(bare), { rate_limits: RATE, account: ACCT }, NOW), bare);
    expect(readUsageCache(bare)).toEqual(OK_CACHE);
  });

  it('never stores the token', async () => {
    const env = sandbox('tok-SECRET-123');
    await fetchUsage(env, OK());
    const files = walk(env.CCINFOBAR_CACHE_DIR!);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(fs.readFileSync(f, 'utf8')).not.toContain('tok-SECRET-123');
  });

  it('round-trips a legacy cache through the adapter', () => {
    for (const c of [
      OK_CACHE,
      kept('usage API returned 500', NOW + 60_000),
      { fetchedAt: NOW, error: 'no Claude login found', blockedUntil: NOW + 1 },
      { fetchedAt: NOW, account: ACCT_B, error: 'x', blockedUntil: NOW + 1 },
      { fetchedAt: NOW },
    ]) {
      expect(toUsageCache(fromUsageCache('usage-0123456789abcdef', c, null, NOW + 5))).toEqual(c);
    }
  });
});

describe('usageJob', () => {
  const cfg = (patch: Partial<Config> = {}): Config => ({ ...defaultConfig(), ...patch });
  const ctx = (env: NodeJS.ProcessEnv, f: typeof fetch): JobCtx<UsageValue> => ({
    env,
    config: cfg(),
    cwd: '/',
    prev: usageJob.readPrev!(usageKey(env), env),
    fetch: f,
    now: Date.now(),
  });

  it('asks for the account key only when limits widgets need the API', () => {
    const env = sandbox(null);
    const input = { config: cfg(), payload: {}, env, cwd: '/', now: NOW };
    expect(usageJob.keys(input)).toEqual([{ key: usageKey(env) }]);
    expect(usageJob.keys({ ...input, config: cfg({ usageApi: false }) })).toEqual([]);
    expect(usageJob.keys({ ...input, env: { ...env, CCINFOBAR_NO_USAGE_API: '1' } })).toEqual([]);
    expect(usageJob.keys({ ...input, config: cfg({ lines: [[{ id: 'm', type: 'model' }]] }) })).toEqual([]);
    const both = { rate_limits: RATE };
    expect(usageJob.keys({ ...input, payload: both })).toEqual([]);
    expect(usageJob.keys({ ...input, env: { ...env, ANTHROPIC_API_KEY: 'x' } })).toEqual([]);
    expect(usageJob.keyRe.test(usageKey(env))).toBe(true);
    expect(usageJob).toMatchObject({ id: 'usage', network: 'auto', lockMs: 30_000 });
  });

  it('accepts only its own account key with limits on', () => {
    const env = sandbox(null);
    const a = { config: cfg(), env, cwd: '/' };
    expect(usageJob.accepts({ key: usageKey(env) }, a)).toBe(true);
    expect(usageJob.accepts({ key: 'usage-0123456789abcdef' }, a)).toBe(false);
    expect(usageJob.accepts({ key: usageKey(env) }, { ...a, config: cfg({ usageApi: false }) })).toBe(false);
    const model = cfg({ lines: [[{ id: 'm', type: 'model' }]] });
    expect(usageJob.accepts({ key: usageKey(env) }, { ...a, config: model })).toBe(false);
  });

  it('runs through the runner with the same result as fetchUsage', async () => {
    const env = sandbox('tok');
    const e = await executeJob(usageJob, { key: usageKey(env) }, ctx(env, OK()));
    expect(toUsageCache(e)).toEqual(OK_CACHE);
    expect(adapted(env)).toEqual(OK_CACHE);
    expect(readLimitsStore(env)?.windows.five_hour).toMatchObject({ pct: 5, src: 'usage-api' });
    at(LATER);
    await executeJob(usageJob, { key: usageKey(env) }, ctx(env, reply(500, {})));
    expect(adapted(env)).toEqual(kept('usage API returned 500', 1791806660000));
  });

  it('starts from the legacy account file but ignores the shared usage.json', async () => {
    const env = sandbox('tok');
    fs.mkdirSync(env.CCINFOBAR_CACHE_DIR!, { recursive: true });
    fs.writeFileSync(usageFile(env), JSON.stringify(OK_CACHE));
    const prev = usageJob.readPrev!(usageKey(env), env);
    expect(prev && toUsageCache(prev)).toEqual(OK_CACHE);
    at(LATER);
    const e = await executeJob(usageJob, { key: usageKey(env) }, ctx(env, reply(500, {})));
    expect(toUsageCache(e)).toEqual(kept('usage API returned 500', 1791806660000));
    const { CLAUDE_CONFIG_DIR: _, ...bare } = env;
    const other = { ...bare, CCINFOBAR_CACHE_DIR: path.join(env.CCINFOBAR_CACHE_DIR!, 'b') };
    fs.mkdirSync(other.CCINFOBAR_CACHE_DIR, { recursive: true });
    fs.writeFileSync(legacyUsageFile(other), JSON.stringify(OK_CACHE));
    expect(usageJob.readPrev!(usageKey(other), other)).toBeNull();
  });

  it('fetchUsageEnvelope returns the cache without writing it', async () => {
    const env = sandbox('tok');
    const r = await fetchUsageEnvelope(null, env, OK(), NOW);
    expect(r).toEqual({ cache: OK_CACHE, account: ACCT });
    expect(walk(env.CCINFOBAR_CACHE_DIR!)).toEqual([]);
  });

  it('usage --background runs the job through the runner', async () => {
    const env = process.env;
    creds(env.CLAUDE_CONFIG_DIR!, 'tok');
    vi.stubGlobal('fetch', OK());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runUsage } = await import('../../../src/commands/manage.js');
      const cfgFile = path.join(env.CCINFOBAR_CONFIG_DIR!, 'usage-bg.json');
      await runUsage({ command: 'usage', positional: [], flags: { background: true } }, cfgFile);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
      fs.rmSync(path.join(env.CLAUDE_CONFIG_DIR!, '.credentials.json'), { force: true });
    }
    const e = envelope(env) as JobEnvelope<UsageValue>;
    expect(e).toMatchObject({ ok: true, value: { rate_limits: RATE, account: ACCT } });
    expect(fs.existsSync(usageFile(env))).toBe(false);
    expect(fs.existsSync(path.join(env.CCINFOBAR_CACHE_DIR!, 'jobs', `${usageKey(env)}.lock`))).toBe(false);
  });
});
