import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { limitsOn, readLimitsStore, recordLimits, resolveLimits } from '../../src/data/limits.js';
import {
  effectiveUsage,
  fetchUsage,
  legacyUsageFile,
  needsUsage,
  parseUsageResponse,
  readUsageCache,
  scheduleUsage,
  usageDue,
  usageFile,
} from '../../src/data/usage.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');

const sandbox = (token: string | null) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-usage-'));
  const claude = path.join(dir, 'claude');
  fs.mkdirSync(claude);
  if (token) {
    fs.writeFileSync(
      path.join(claude, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3_600_000 } }),
    );
  }
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
    CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
  };
};

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

describe('usage api', () => {
  it('maps buckets, per-model weekly limits and extra usage', () => {
    const r = parseUsageResponse({
      five_hour: { utilization: 13, resets_at: '2026-10-12T17:59:59Z' },
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: { utilization: 7, resets_at: null },
      limits: [
        { kind: 'weekly_scoped', percent: 1, resets_at: 'x', scope: { model: { display_name: 'Fable' } } },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 15000, used_credits: 250, utilization: 2 },
    });
    expect(r).toEqual({
      five_hour: { used_percentage: 13, resets_at: '2026-10-12T17:59:59Z' },
      seven_day: { used_percentage: 0, resets_at: null },
      seven_day_models: [
        { model: 'Fable', used_percentage: 1, resets_at: 'x' },
        { model: 'Opus', used_percentage: 7, resets_at: null },
      ],
      spend_limit: { used_usd: 2.5, limit_usd: 150, used_percentage: 2 },
    });
    expect(parseUsageResponse({ limits: [{ kind: 'session', percent: 0, resets_at: null }] })).toBeNull();
  });

  it('only fills windows Claude Code did not send', () => {
    const cache = {
      fetchedAt: NOW,
      rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 90 } },
    };
    const p = resolveLimits(
      { rate_limits: { five_hour: { used_percentage: 20 } } },
      null,
      cache,
      NOW,
      null,
    ).payload;
    expect(p.rate_limits).toEqual({ five_hour: { used_percentage: 20 }, seven_day: { used_percentage: 90 } });
    expect(resolveLimits({}, null, cache, NOW + 3_600_000, null).payload.rate_limits).toBeUndefined();
  });

  it('asks only when limit widgets lack data and the cache is stale', () => {
    const config = defaultConfig();
    expect(needsUsage(config, {}, {})).toBe(true);
    expect(
      needsUsage(config, {
        rate_limits: { five_hour: { used_percentage: 1 }, seven_day: { used_percentage: 1 } },
      }),
    ).toBe(false);
    expect(needsUsage({ ...config, lines: [[{ id: 'm', type: 'model' }]] }, {}, {})).toBe(false);
    const full = { five_hour: { used_percentage: 1 }, seven_day: { used_percentage: 1 } };
    const model = { ...config, lines: [[{ id: 'f', type: 'weekly-model-usage' }]] };
    expect(needsUsage(model, { rate_limits: full }, {})).toBe(true);
    expect(usageDue(null, NOW)).toBe(true);
    expect(usageDue({ fetchedAt: NOW - 60_000 }, NOW)).toBe(false);
    expect(usageDue({ fetchedAt: NOW - 200_000 }, NOW)).toBe(true);
    expect(usageDue({ fetchedAt: NOW - 200_000, blockedUntil: NOW + 1 }, NOW)).toBe(false);
  });

  it('caches a successful reply and keeps it through a 429', async () => {
    const env = sandbox('tok');
    const ok = await fetchUsage(
      env,
      reply(200, { five_hour: { utilization: 5 }, seven_day: { utilization: 50 } }),
    );
    expect(ok.rate_limits?.seven_day?.used_percentage).toBe(50);
    const limited = await fetchUsage(env, reply(429, {}, { 'retry-after': '120' }));
    expect(limited.rate_limits?.seven_day?.used_percentage).toBe(50);
    expect(limited.error).toMatch(/rate limited/);
    expect(limited.blockedUntil! - Date.now()).toBeGreaterThan(100_000);
    expect(readUsageCache(env)?.rate_limits?.five_hour?.used_percentage).toBe(5);
  });

  it('sanitizes cached usage text', async () => {
    const env = sandbox(null);
    fs.mkdirSync(env.CCINFOBAR_CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      usageFile(env),
      JSON.stringify({
        fetchedAt: 1,
        error: 'x\u001b]0;t\u0007y',
        rate_limits: { seven_day_models: [{ model: 'Op\u001b[2Jus', used_percentage: 1 }] },
      }),
    );
    const c = readUsageCache(env);
    expect(c?.error).toBe('xy');
    expect(c?.rate_limits?.seven_day_models?.[0]?.model).toBe('Opus');
    fs.writeFileSync(usageFile(env), '[1]');
    expect(readUsageCache(env)).toBeNull();
  });

  it('keeps one usage cache per config dir', async () => {
    const a = sandbox('tok-a');
    const b = { ...sandbox('tok-b'), CCINFOBAR_CACHE_DIR: a.CCINFOBAR_CACHE_DIR };
    await fetchUsage(a, reply(200, { five_hour: { utilization: 11 }, seven_day: { utilization: 1 } }));
    await fetchUsage(b, reply(200, { five_hour: { utilization: 22 }, seven_day: { utilization: 2 } }));
    expect(usageFile(a)).not.toBe(usageFile(b));
    expect(path.basename(usageFile(a))).toMatch(/^usage-[0-9a-f]{16}\.json$/);
    expect(fs.existsSync(usageFile(a)) && fs.existsSync(usageFile(b))).toBe(true);
    expect(readUsageCache(a)?.rate_limits?.five_hour?.used_percentage).toBe(11);
    expect(readUsageCache(b)?.rate_limits?.five_hour?.used_percentage).toBe(22);
  });

  it('reads the legacy cache only without CLAUDE_CONFIG_DIR and never writes it', async () => {
    const env = sandbox('tok');
    const { CLAUDE_CONFIG_DIR: _, ...bare } = env;
    fs.mkdirSync(env.CCINFOBAR_CACHE_DIR, { recursive: true });
    const legacy = legacyUsageFile(env);
    expect(path.basename(legacy)).toBe('usage.json');
    const text = JSON.stringify({ fetchedAt: 5, rate_limits: { five_hour: { used_percentage: 33 } } });
    fs.writeFileSync(legacy, text);
    fs.utimesSync(legacy, 1000, 1000);
    expect(readUsageCache(bare)?.rate_limits?.five_hour?.used_percentage).toBe(33);
    expect(readUsageCache(bare)?.legacy).toBe(true);
    expect(readUsageCache(env)).toBeNull();
    await fetchUsage(env, reply(200, { five_hour: { utilization: 9 }, seven_day: { utilization: 9 } }));
    expect(fs.readFileSync(legacy, 'utf8')).toBe(text);
    expect(fs.statSync(legacy).mtimeMs).toBe(1_000_000);
    expect(readUsageCache(env)?.rate_limits?.five_hour?.used_percentage).toBe(9);
  });

  it('schedules no usage fetch when nonessential traffic is off', () => {
    const env = sandbox(null);
    const lock = `${usageFile(env)}.lock`;
    expect(path.basename(lock)).toMatch(/^usage-[0-9a-f]{16}\.json\.lock$/);
    scheduleUsage({ ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    expect(fs.existsSync(lock)).toBe(false);
    scheduleUsage({ ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' });
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('feeds the shared limits store and starts it over after a login change', async () => {
    const env = sandbox('tok-a');
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const five = { used_percentage: 61, resets_at: Math.floor((now + 7_200_000) / 1000) };
    recordLimits(env, { rate_limits: { five_hour: five } }, now - 60_000, now);
    const ok = await fetchUsage(
      env,
      reply(200, {
        five_hour: { utilization: 60, resets_at: iso(now + 7_200_000) },
        seven_day: { utilization: 30, resets_at: iso(now + 3 * 86_400_000) },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 8,
            resets_at: iso(now + 86_400_000),
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      }),
    );
    const w = readLimitsStore(env)?.windows ?? {};
    expect(w.five_hour).toMatchObject({ pct: 60, at: ok.fetchedAt, src: 'usage-api' });
    expect(w.seven_day?.at).toBe(ok.fetchedAt);
    expect(w['model:fable']).toMatchObject({ pct: 8, model: 'Fable' });
    fs.writeFileSync(
      path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-b', expiresAt: Date.now() + 3_600_000 } }),
    );
    const failed = await fetchUsage(env, reply(500, {}));
    expect(failed.rate_limits).toBeUndefined();
    expect(readLimitsStore(env)?.windows).toEqual({});
    await fetchUsage(
      env,
      reply(200, { five_hour: { utilization: 2, resets_at: iso(now + 3_600_000) }, seven_day: null }),
    );
    expect(Object.keys(readLimitsStore(env)?.windows ?? {})).toEqual(['five_hour']);
    expect(readLimitsStore(env)?.windows.five_hour?.pct).toBe(2);
  });

  describe('account identity', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const login = (env: NodeJS.ProcessEnv, oauth: Record<string, unknown> | null) => {
      const file = path.join(env.CLAUDE_CONFIG_DIR!, '.credentials.json');
      if (oauth)
        fs.writeFileSync(
          file,
          JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000, ...oauth } }),
        );
      else fs.rmSync(file, { force: true });
    };
    const uuid = (env: NodeJS.ProcessEnv, accountUuid: string) =>
      fs.writeFileSync(
        path.join(env.CLAUDE_CONFIG_DIR!, '.claude.json'),
        JSON.stringify({ projects: {}, oauthAccount: { accountUuid, organizationUuid: 'org' } }),
      );
    const ok = () => {
      const now = Date.now();
      return reply(200, {
        five_hour: { utilization: 60, resets_at: iso(now + 7_200_000) },
        seven_day: { utilization: 30, resets_at: iso(now + 3 * 86_400_000) },
      });
    };
    const windows = (env: NodeJS.ProcessEnv) => Object.keys(readLimitsStore(env)?.windows ?? {});

    it('keeps the store through a token refresh', async () => {
      const env = sandbox(null);
      login(env, { accessToken: 'a1', refreshToken: 'r1' });
      await fetchUsage(env, ok());
      login(env, { accessToken: 'a2', refreshToken: 'r1' });
      await fetchUsage(env, reply(500, {}));
      expect(windows(env)).toEqual(['five_hour', 'seven_day']);
      expect(readUsageCache(env)?.rate_limits?.five_hour?.used_percentage).toBe(60);
    });

    it('keys on the account uuid from .claude.json when present', async () => {
      const env = sandbox(null);
      uuid(env, 'u-1');
      login(env, { accessToken: 'a1', refreshToken: 'r1' });
      await fetchUsage(env, ok());
      login(env, { accessToken: 'a2', refreshToken: 'r2' });
      await fetchUsage(env, reply(500, {}));
      expect(windows(env)).toEqual(['five_hour', 'seven_day']);
      uuid(env, 'u-2');
      await fetchUsage(env, reply(500, {}));
      expect(windows(env)).toEqual([]);
    });

    it('sees a switch after a logout', async () => {
      const env = sandbox(null);
      login(env, { accessToken: 'a1', refreshToken: 'r1' });
      await fetchUsage(env, ok());
      login(env, null);
      const out = await fetchUsage(env, reply(200, {}));
      expect(out.error).toMatch(/no Claude login/);
      expect(out.account).toBeDefined();
      expect(windows(env)).toEqual(['five_hour', 'seven_day']);
      login(env, { accessToken: 'b1', refreshToken: 'r9' });
      await fetchUsage(env, reply(500, {}));
      expect(windows(env)).toEqual([]);
    });
  });

  it('backs off without a login', async () => {
    const env = sandbox(null);
    const c = await fetchUsage(env, reply(200, {}));
    expect(c.error).toMatch(/no Claude login/);
    expect(usageDue(c)).toBe(false);
  });
});

describe('effectiveUsage', () => {
  const both = {
    rate_limits: {
      five_hour: { used_percentage: 1, resets_at: null },
      seven_day: { used_percentage: 2, resets_at: null },
    },
  };

  it('skips the cache when Claude Code sent both windows', () => {
    const env = { CCINFOBAR_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-eff-')) };
    try {
      const p = { ...both };
      const r = effectiveUsage(defaultConfig(), p, env);
      expect(r).toMatchObject({ usageOn: false, usage: null, limitsOn: true, payload: p, captureAt: null });
      expect(r.limits?.windows.five_hour?.source).toBe('payload');
    } finally {
      fs.rmSync(env.CCINFOBAR_CACHE_DIR, { recursive: true, force: true });
    }
  });

  it('leaves provider sessions untouched', () => {
    const p = { ...both };
    expect(effectiveUsage(defaultConfig(), p, { ANTHROPIC_API_KEY: 'x' })).toEqual({
      usageOn: false,
      usage: null,
      payload: p,
      limitsOn: false,
      limits: null,
      captureAt: null,
    });
  });

  it('gates the limits store on a limits widget and plan limits only', () => {
    const config = defaultConfig();
    const only = (type: string) => ({ ...config, lines: [[{ id: 'a', type }]] });
    expect(limitsOn(only('five-hour-usage'), {})).toBe(true);
    expect(limitsOn(only('five-hour-usage'), { ANTHROPIC_API_KEY: 'x' })).toBe(false);
    expect(limitsOn(only('model'), {})).toBe(false);
    expect(limitsOn({ ...only('five-hour-usage'), usageApi: false }, {})).toBe(true);
  });

  it('merges a fresh cache when limit widgets lack data', () => {
    const env = { CCINFOBAR_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-eff-')) };
    try {
      const cache = {
        fetchedAt: Date.now(),
        rate_limits: { five_hour: { used_percentage: 44, resets_at: null } },
      };
      fs.writeFileSync(usageFile(env), JSON.stringify(cache));
      const r = effectiveUsage(defaultConfig(), {}, env);
      expect(r.usageOn).toBe(true);
      expect(r.usage?.fetchedAt).toBe(cache.fetchedAt);
      expect(r.payload.rate_limits?.five_hour?.used_percentage).toBe(44);
      const off = effectiveUsage(defaultConfig(), {}, { ...env, CCINFOBAR_NO_USAGE_API: '1' });
      expect(off).toMatchObject({ usageOn: false, usage: null, payload: {}, limitsOn: true });
    } finally {
      fs.rmSync(env.CCINFOBAR_CACHE_DIR, { recursive: true, force: true });
    }
  });
});
