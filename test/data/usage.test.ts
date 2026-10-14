import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import {
  fetchUsage,
  mergeUsage,
  needsUsage,
  parseUsageResponse,
  readUsageCache,
  usageDue,
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
    const p = mergeUsage({ rate_limits: { five_hour: { used_percentage: 20 } } }, cache, NOW);
    expect(p.rate_limits).toEqual({ five_hour: { used_percentage: 20 }, seven_day: { used_percentage: 90 } });
    expect(mergeUsage({}, cache, NOW + 3_600_000).rate_limits).toBeUndefined();
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

  it('backs off without a login', async () => {
    const env = sandbox(null);
    const c = await fetchUsage(env, reply(200, {}));
    expect(c.error).toMatch(/no Claude login/);
    expect(usageDue(c)).toBe(false);
  });
});
