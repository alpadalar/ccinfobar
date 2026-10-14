import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountKey,
  addSample,
  captureTime,
  type LimitObs,
  type LimitsStore,
  limitsFile,
  mergeObservation,
  parseLimitsStore,
  pick,
  plausible,
  readLimitsStore,
  recordLimits,
  recordUsageApi,
  resolveLimits,
} from '../../src/data/limits.js';
import type { TranscriptInfo } from '../../src/data/transcript.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const MIN = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const FIVE = 5 * H;
const sec = (ms: number) => Math.floor(ms / 1000);
const obs = (pct: number, resetsAt: number | null, at: number | null, src: LimitObs['src'] = 'payload') => ({
  pct,
  resetsAt,
  at,
  src,
});
const store = (windows: LimitsStore['windows']): LimitsStore => ({ v: 1, windows });
const win = (
  pct: number,
  resetsAt: number,
  at: number | null,
  samples: { t: number; pct: number }[] = [],
) => ({
  pct,
  resetsAt,
  at,
  src: 'payload' as const,
  samples,
});
const five = (pct: number, resetsAt: number) => ({
  rate_limits: { five_hour: { used_percentage: pct, resets_at: sec(resetsAt) } },
});

describe('account key', () => {
  it('is 16 hex chars and separates config dirs, providers and secure storage', () => {
    const a = accountKey({ CLAUDE_CONFIG_DIR: '/x' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(accountKey({ CLAUDE_CONFIG_DIR: '/x/' })).toBe(a);
    expect(accountKey({ CLAUDE_CONFIG_DIR: '/y' })).not.toBe(a);
    expect(accountKey({ CLAUDE_CONFIG_DIR: '/x', CLAUDE_CODE_USE_BEDROCK: '1' })).not.toBe(a);
    expect(accountKey({ CLAUDE_CONFIG_DIR: '/x', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/s' })).not.toBe(a);
  });

  it('names the file after the key only', () => {
    const env = { CCINFOBAR_CACHE_DIR: '/c', CLAUDE_CONFIG_DIR: '/x' };
    expect(limitsFile(env)).toBe(path.join('/c', 'limits', `${accountKey(env)}.json`));
  });
});

describe('plausible and pick', () => {
  it.each([
    ['resets now', obs(10, NOW, NOW), false],
    ['already reset', obs(10, NOW - 1, NOW), false],
    ['inside the window', obs(10, NOW + 2 * H, NOW), true],
    ['at window length plus tolerance', obs(10, NOW + FIVE + 10 * MIN, NOW), true],
    ['too far ahead', obs(10, NOW + FIVE + 11 * MIN, NOW), false],
    ['no reset time', obs(10, null, NOW), false],
    ['not a number', obs(Number.NaN, NOW + H, NOW), false],
    ['over 1000', obs(1001, NOW + H, NOW), false],
  ])('%s', (_name, o, ok) => {
    expect(plausible(o, FIVE, NOW)).toBe(ok);
  });

  it.each([
    ['newest capture wins', [obs(70, NOW + H, NOW - MIN), obs(40, NOW + H, NOW - 3 * H)], 70],
    ['a lower newer value wins inside the window', [obs(70, NOW + H, NOW - H), obs(60, NOW + H, NOW)], 60],
    ['ties go to the payload', [obs(30, NOW + H, NOW, 'usage-api'), obs(20, NOW + H, NOW)], 20],
    [
      'the API wins only when strictly newer',
      [obs(20, NOW + H, NOW - MIN), obs(30, NOW + H, NOW, 'usage-api')],
      30,
    ],
    [
      'a newer API value within 1 point keeps the payload tenths',
      [obs(42.3, NOW + H, NOW - 5 * MIN), obs(42, NOW + H, NOW, 'usage-api')],
      42.3,
    ],
    [
      'a newer API value 1 point away wins',
      [obs(42.3, NOW + H, NOW - 5 * MIN), obs(43.3, NOW + H, NOW, 'usage-api')],
      43.3,
    ],
    ['then the higher value', [obs(20, NOW + H, NOW), obs(25, NOW + H, NOW)], 25],
    ['a later window wins over a newer capture', [obs(90, NOW + H, NOW), obs(5, NOW + 4 * H, NOW - H)], 5],
    [
      'resets within 10 minutes are one window',
      [obs(70, NOW + H, NOW), obs(40, NOW + H + 9 * MIN, NOW - H)],
      70,
    ],
    ['unknown capture loses to a known one', [obs(90, NOW + H, null), obs(10, NOW + H, NOW - 3 * H)], 10],
    ['unknown capture is used when alone', [obs(90, NOW + H, null)], 90],
  ])('%s', (_name, list, pct) => {
    expect(pick(list, FIVE, NOW)?.pct).toBe(pct);
  });
});

describe('resolveLimits', () => {
  const stored = store(
    Object.assign(Object.create(null), {
      five_hour: win(70, NOW + 2 * H, NOW - MIN, [{ t: NOW - MIN, pct: 70 }]),
    }),
  );

  it('uses the payload when its capture is newer', () => {
    const r = resolveLimits(five(80, NOW + 2 * H), stored, null, NOW, NOW);
    expect(r.payload.rate_limits?.five_hour?.used_percentage).toBe(80);
    expect(r.view.windows.five_hour).toMatchObject({ source: 'payload', at: NOW });
    expect(r.view.windows.five_hour?.samples).toEqual([{ t: NOW - MIN, pct: 70 }]);
  });

  it('uses the store when the payload capture is older', () => {
    const r = resolveLimits(five(40, NOW + 2 * H + 3 * MIN), stored, null, NOW, NOW - 3 * H);
    expect(r.payload.rate_limits?.five_hour).toEqual({ used_percentage: 70, resets_at: sec(NOW + 2 * H) });
    expect(r.view.windows.five_hour?.source).toBe('limits-cache');
  });

  it('fills a session with no limits yet from the store', () => {
    const r = resolveLimits({}, stored, null, NOW, null);
    expect(r.payload.rate_limits?.five_hour?.used_percentage).toBe(70);
  });

  it('drops expired windows and never brings them back', () => {
    const r = resolveLimits(five(73, NOW - MIN), stored, null, NOW + 3 * H, NOW);
    expect(r.payload.rate_limits?.five_hour).toBeUndefined();
    expect(r.view.expired).toEqual(['five_hour']);
    expect(r.view.windows.five_hour).toBeUndefined();
  });

  it('accepts the lower first value of the next window', () => {
    const r = resolveLimits(five(3, NOW + 4 * H), stored, null, NOW, NOW - 2 * H);
    expect(r.payload.rate_limits?.five_hour?.used_percentage).toBe(3);
    expect(r.view.windows.five_hour?.samples).toEqual([]);
  });

  it('never lets a legacy usage capture beat a known one', () => {
    const resets = NOW + 2 * H;
    const api = { fetchedAt: NOW, rate_limits: five(90, resets).rate_limits };
    const own = resolveLimits(five(45, resets), null, { ...api, legacy: true }, NOW, NOW - 5 * MIN);
    expect(own.view.windows.five_hour).toMatchObject({ pct: 45, source: 'payload' });
    const fresh = resolveLimits(five(45, resets), null, api, NOW, NOW - 5 * MIN);
    expect(fresh.view.windows.five_hour).toMatchObject({ pct: 90, source: 'usage-api' });
    expect(resolveLimits({}, null, { ...api, legacy: true }, NOW, null).view.windows.five_hour?.pct).toBe(90);
  });

  it('groups epoch seconds and ISO resets with microseconds as one window', () => {
    const resets = Date.parse('2026-10-12T14:50:00Z');
    const api = {
      fetchedAt: NOW,
      rate_limits: { five_hour: { used_percentage: 50, resets_at: '2026-10-12T14:50:00.321782+00:00' } },
    };
    const r = resolveLimits(five(45, resets), null, api, NOW, NOW - MIN);
    expect(r.view.windows.five_hour).toMatchObject({ pct: 50, source: 'usage-api' });
    const older = resolveLimits(five(45, resets), null, { ...api, fetchedAt: NOW - 2 * MIN }, NOW, NOW - MIN);
    expect(older.view.windows.five_hour).toMatchObject({ pct: 45, source: 'payload' });
  });

  it('shows an API "no active window" as 0% only when nothing else exists', () => {
    const api = { fetchedAt: NOW, rate_limits: { five_hour: { used_percentage: 0, resets_at: null } } };
    const r = resolveLimits({}, null, api, NOW, null);
    expect(r.payload.rate_limits?.five_hour).toEqual({ used_percentage: 0, resets_at: null });
    expect(resolveLimits({}, stored, api, NOW, null).payload.rate_limits?.five_hour?.used_percentage).toBe(
      70,
    );
  });

  it('ignores a stale usage cache and keeps the old fill rule for other keys', () => {
    const api = {
      fetchedAt: NOW,
      rate_limits: {
        seven_day_models: [{ model: 'Opus', used_percentage: 7, resets_at: null }],
        spend_limit: { used_usd: 2, limit_usd: 10 },
      },
    };
    const r = resolveLimits({ rate_limits: { spend_limit: { used_usd: 3 } } }, null, api, NOW, null);
    expect(r.payload.rate_limits?.spend_limit).toEqual({ used_usd: 3 });
    expect(r.payload.rate_limits?.seven_day_models?.[0]?.model).toBe('Opus');
    expect(resolveLimits({}, null, api, NOW + H, null).payload).toEqual({});
  });
});

describe('mergeObservation', () => {
  const base = mergeObservation(null, 'five_hour', obs(70, NOW + 2 * H, NOW - MIN), NOW);

  it('stores the first observation with a sample', () => {
    expect(base.windows.five_hour).toEqual(win(70, NOW + 2 * H, NOW - MIN, [{ t: NOW - MIN, pct: 70 }]));
  });

  it('returns an equal store when the winner does not change', () => {
    const next = mergeObservation(base, 'five_hour', obs(40, NOW + 2 * H, NOW - 3 * H), NOW);
    expect(JSON.stringify(next)).toBe(JSON.stringify(base));
    const same = mergeObservation(base, 'five_hour', obs(70, NOW + 2 * H, NOW - MIN), NOW);
    expect(JSON.stringify(same)).toBe(JSON.stringify(base));
  });

  it('never stores windows without a plausible reset', () => {
    expect(mergeObservation(null, 'five_hour', obs(70, null, NOW), NOW).windows.five_hour).toBeUndefined();
    expect(
      mergeObservation(null, 'five_hour', obs(70, NOW + 400 * D, NOW), NOW).windows.five_hour,
    ).toBeUndefined();
    expect(mergeObservation(null, '__proto__', obs(70, NOW + H, NOW), NOW).windows).toEqual({});
  });

  it('drops expired windows', () => {
    const later = mergeObservation(base, 'seven_day', obs(30, NOW + 3 * D, NOW + 3 * H), NOW + 3 * H);
    expect(later.windows.five_hour).toBeUndefined();
    expect(later.windows.seven_day?.pct).toBe(30);
  });

  it('thins the sample ring and clears it on rollover', () => {
    let s = base;
    s = mergeObservation(s, 'five_hour', obs(71, NOW + 2 * H, NOW - 30_000), NOW);
    expect(s.windows.five_hour?.samples).toEqual([
      { t: NOW - MIN, pct: 70 },
      { t: NOW - 30_000, pct: 71 },
    ]);
    s = mergeObservation(s, 'five_hour', obs(72, NOW + 2 * H, NOW), NOW);
    expect(s.windows.five_hour?.samples).toEqual([
      { t: NOW - MIN, pct: 70 },
      { t: NOW, pct: 72 },
    ]);
    s = mergeObservation(s, 'five_hour', obs(72, NOW + 2 * H, NOW + 5 * MIN), NOW);
    expect(s.windows.five_hour?.samples).toHaveLength(3);
    s = mergeObservation(s, 'five_hour', obs(2, NOW + 4 * H, NOW + 6 * MIN), NOW);
    expect(s.windows.five_hour?.samples).toEqual([{ t: NOW + 6 * MIN, pct: 2 }]);
  });

  it('keeps at most 32 samples with a 20 minute spacing for the week', () => {
    let ring: { t: number; pct: number }[] = [];
    for (let i = 0; i < 40; i++) ring = addSample(ring, { t: NOW + i * 20 * MIN, pct: i }, 20 * MIN);
    expect(ring).toHaveLength(32);
    expect(ring[0]?.pct).toBe(8);
    const next = addSample(ring, { t: NOW + 39 * 20 * MIN + MIN, pct: 99 }, 20 * MIN);
    expect(next).toHaveLength(32);
    expect(next.at(-1)).toEqual({ t: NOW + 39 * 20 * MIN + MIN, pct: 99 });
    expect(addSample(ring, { t: NOW, pct: 100 }, 20 * MIN)).toBe(ring);
  });

  it('keeps time moving for an unchanged pct and the newer time on merge', () => {
    const ring = [{ t: NOW, pct: 10 }];
    expect(addSample(ring, { t: NOW + 30_000, pct: 10 }, MIN)).toBe(ring);
    expect(addSample(ring, { t: NOW + MIN, pct: 10 }, MIN)).toEqual([...ring, { t: NOW + MIN, pct: 10 }]);
    const two = [...ring, { t: NOW + 20_000, pct: 11 }];
    expect(addSample(two, { t: NOW + 45_000, pct: 12 }, MIN)).toEqual([
      ...ring,
      { t: NOW + 45_000, pct: 12 },
    ]);
    expect(addSample(two, { t: NOW + 20_000, pct: 13 }, MIN).at(-1)).toEqual({ t: NOW + 20_000, pct: 13 });
  });
});

describe('parseLimitsStore', () => {
  const good = { pct: 10, resetsAt: NOW + H, at: NOW, src: 'payload', samples: [{ t: NOW, pct: 10 }] };

  it('reads a valid store', () => {
    expect(
      parseLimitsStore(JSON.stringify({ v: 1, windows: { five_hour: good } }))?.windows.five_hour,
    ).toEqual(good);
  });

  it.each([
    ['__proto__ key', '{"v":1,"windows":{"__proto__":{"pct":1,"resetsAt":1,"at":1,"src":"payload"}}}'],
    ['constructor key', JSON.stringify({ v: 1, windows: { constructor: good } })],
    [
      'infinite pct',
      `{"v":1,"windows":{"five_hour":{"pct":1e999,"resetsAt":${NOW + H},"at":null,"src":"payload"}}}`,
    ],
    ['text pct', JSON.stringify({ v: 1, windows: { five_hour: { ...good, pct: '10' } } })],
    ['pct above 1000', JSON.stringify({ v: 1, windows: { five_hour: { ...good, pct: 1001 } } })],
    ['bad source', JSON.stringify({ v: 1, windows: { five_hour: { ...good, src: 'x' } } })],
    ['bad capture time', JSON.stringify({ v: 1, windows: { five_hour: { ...good, at: 'now' } } })],
  ])('ignores a window with %s', (_name, text) => {
    const s = parseLimitsStore(text);
    expect(s?.windows.five_hour).toBeUndefined();
    expect(Object.getPrototypeOf(s?.windows)).toBeNull();
    expect(({} as Record<string, unknown>).pct).toBeUndefined();
  });

  it('rejects other versions and broken text', () => {
    expect(parseLimitsStore(JSON.stringify({ v: 2, windows: {} }))).toBeNull();
    expect(parseLimitsStore('{')).toBeNull();
    expect(parseLimitsStore(null)).toBeNull();
  });
});

describe('captureTime', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-lim-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('prefers the last assistant message, then the transcript mtime, then unknown', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, '');
    fs.utimesSync(file, sec(NOW) - 60, sec(NOW) - 60);
    const p = { ...five(10, NOW + H), transcript_path: file };
    const t = () => ({ lastAssistantAt: NOW - 5000 }) as TranscriptInfo;
    expect(captureTime(p, t)).toBe(NOW - 5000);
    expect(captureTime(p, () => null)).toBe((sec(NOW) - 60) * 1000);
    expect(captureTime({ ...p, transcript_path: path.join(dir, 'gone') }, () => null)).toBeNull();
    expect(captureTime({ transcript_path: file }, t)).toBeNull();
  });
});

describe('limits file', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-lim-'));
    env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'), CLAUDE_CONFIG_DIR: path.join(dir, 'a') };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const p = { rate_limits: { five_hour: { used_percentage: 70, resets_at: sec(Date.now() + 2 * H) } } };

  it('merges a store another writer replaced after the first read', () => {
    const now = Date.now();
    const file = limitsFile(env);
    const week = { rate_limits: { seven_day: { used_percentage: 20, resets_at: sec(now + 3 * D) } } };
    const orig = fs.readFileSync;
    let reads = 0;
    const fsMod = fs as unknown as { readFileSync: typeof orig };
    // another session writes between this read and the rename
    fsMod.readFileSync = ((f: fs.PathOrFileDescriptor, o?: unknown) => {
      if (f !== file || reads++ > 0) return orig(f, o as BufferEncoding);
      fsMod.readFileSync = orig;
      try {
        return orig(f, o as BufferEncoding);
      } finally {
        recordLimits(env, week, now - MIN, now);
      }
    }) as typeof orig;
    try {
      recordLimits(env, p, now - MIN, now);
    } finally {
      fsMod.readFileSync = orig;
    }
    const w = readLimitsStore(env)?.windows;
    expect(w?.five_hour?.pct).toBe(70);
    expect(w?.seven_day?.pct).toBe(20);
  });

  it('writes only when the merged result changes', () => {
    const now = Date.now();
    recordLimits(env, p, now - MIN, now);
    const file = limitsFile(env);
    expect(readLimitsStore(env)?.windows.five_hour?.pct).toBe(70);
    fs.utimesSync(file, 1000, 1000);
    recordLimits(env, p, now - MIN, now);
    recordLimits(
      env,
      { rate_limits: { five_hour: { used_percentage: 40, resets_at: p.rate_limits.five_hour.resets_at } } },
      now - H,
      now,
    );
    expect(fs.statSync(file).mtimeMs).toBe(1_000_000);
    recordLimits(
      env,
      { rate_limits: { five_hour: { used_percentage: 75, resets_at: p.rate_limits.five_hour.resets_at } } },
      now,
      now,
    );
    expect(fs.statSync(file).mtimeMs).not.toBe(1_000_000);
    expect(readLimitsStore(env)?.windows.five_hour?.pct).toBe(75);
  });

  it.skipIf(process.platform === 'win32')('is private to the user', () => {
    recordLimits(env, p, Date.now(), Date.now());
    expect(fs.statSync(limitsFile(env)).mode & 0o777).toBe(0o600);
  });

  it('keeps accounts and providers apart', () => {
    recordLimits(env, p, Date.now(), Date.now());
    const other = { ...env, CLAUDE_CONFIG_DIR: path.join(dir, 'b') };
    expect(limitsFile(other)).not.toBe(limitsFile(env));
    expect(readLimitsStore(other)).toBeNull();
    recordLimits({ ...env, ANTHROPIC_API_KEY: 'x' }, p, Date.now(), Date.now());
    expect(fs.readdirSync(path.join(dir, 'cache', 'limits'))).toHaveLength(1);
  });

  it('writes nothing when no window is plausible', () => {
    recordLimits(
      env,
      { rate_limits: { five_hour: { used_percentage: 42, resets_at: 4102444800 } } },
      null,
      Date.now(),
    );
    expect(fs.existsSync(limitsFile(env))).toBe(false);
  });
});

describe('usage API in the store', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-api-'));
    env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'), CLAUDE_CONFIG_DIR: path.join(dir, 'a') };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const iso = (ms: number) => new Date(ms).toISOString();
  const api = (at: number, rate_limits: Record<string, unknown>) =>
    ({ fetchedAt: at, rate_limits }) as Parameters<typeof recordUsageApi>[1];

  it('stores 5h, 7d and model windows with the fetch time', () => {
    const now = Date.now();
    recordUsageApi(
      env,
      api(now - MIN, {
        five_hour: { used_percentage: 12, resets_at: iso(now + 2 * H) },
        seven_day: { used_percentage: 34, resets_at: iso(now + 3 * D) },
        seven_day_models: [
          { model: 'Fable', used_percentage: 5, resets_at: iso(now + 3 * D) },
          { model: 'Idle', used_percentage: 0, resets_at: null },
        ],
        seven_day_opus: { used_percentage: 7, resets_at: iso(now + 2 * D) },
        spend_limit: { used_usd: 1, limit_usd: 2 },
      }),
      false,
      now,
    );
    const w = readLimitsStore(env)?.windows ?? {};
    expect(Object.keys(w).sort()).toEqual(['five_hour', 'model:fable', 'model:opus', 'seven_day']);
    expect(w.five_hour).toMatchObject({ pct: 12, at: now - MIN, src: 'usage-api' });
    expect(w['model:fable']).toMatchObject({ pct: 5, model: 'Fable', src: 'usage-api' });
    expect(w['model:opus']).toMatchObject({ pct: 7, model: 'Opus' });
    expect(fs.readFileSync(limitsFile(env), 'utf8')).not.toMatch(/spend|account/);
  });

  it('lets an API value win only when it is strictly newer than the payload capture', () => {
    const now = Date.now();
    const resets = now + 2 * H;
    const t = now - 10 * MIN;
    recordLimits(env, five(40, resets), t, now);
    const at = (fetched: number, pct: number) =>
      recordUsageApi(
        env,
        api(fetched, { five_hour: { used_percentage: pct, resets_at: iso(resets) } }),
        false,
        now,
      );
    at(t - MIN, 50);
    expect(readLimitsStore(env)?.windows.five_hour).toMatchObject({ pct: 40, src: 'payload' });
    at(t, 50);
    expect(readLimitsStore(env)?.windows.five_hour).toMatchObject({ pct: 40, src: 'payload' });
    at(t + MIN, 55);
    expect(readLimitsStore(env)?.windows.five_hour).toMatchObject({ pct: 55, src: 'usage-api' });
    const r = resolveLimits({}, readLimitsStore(env), null, now, null);
    expect(r.view.windows.five_hour).toMatchObject({ pct: 55, source: 'limits-cache' });
  });

  it('starts the file over on an account change', () => {
    const now = Date.now();
    recordLimits(env, five(40, now + 2 * H), now - MIN, now);
    const week = { seven_day: { used_percentage: 3, resets_at: iso(now + 3 * D) } };
    recordUsageApi(env, api(now - 2 * MIN, week), true, now);
    expect(Object.keys(readLimitsStore(env)?.windows ?? {})).toEqual(['seven_day']);
    recordUsageApi(env, { fetchedAt: now }, true, now);
    expect(Object.keys(readLimitsStore(env)?.windows ?? {})).toEqual([]);
  });

  it('writes only on change and never for provider sessions', () => {
    const now = Date.now();
    const c = api(now, { five_hour: { used_percentage: 9, resets_at: iso(now + H) } });
    recordUsageApi({ ...env, ANTHROPIC_API_KEY: 'x' }, c, true, now);
    expect(fs.existsSync(path.join(dir, 'cache', 'limits'))).toBe(false);
    recordUsageApi(env, c, false, now);
    fs.utimesSync(limitsFile(env), 1000, 1000);
    recordUsageApi(env, c, false, now);
    expect(fs.statSync(limitsFile(env)).mtimeMs).toBe(1_000_000);
    recordUsageApi(env, api(now, { five_hour: { used_percentage: 9, resets_at: null } }), false, now);
    expect(fs.statSync(limitsFile(env)).mtimeMs).toBe(1_000_000);
  });

  it('groups API ISO with microseconds and payload seconds as one window', () => {
    const now = Date.parse('2026-10-14T13:00:00Z');
    const c = api(now - 2 * MIN, {
      five_hour: { used_percentage: 20, resets_at: '2026-10-14T16:50:00.321782+00:00' },
    });
    recordUsageApi(env, c, false, now);
    recordLimits(
      env,
      { rate_limits: { five_hour: { used_percentage: 21, resets_at: 1791996600 } } },
      now,
      now,
    );
    const w = readLimitsStore(env)?.windows.five_hour;
    expect(w?.pct).toBe(21);
    expect(w?.samples.map((x) => x.pct)).toEqual([21]);
  });

  it('feeds samples from payload observations only', () => {
    const now = Date.parse('2026-10-14T13:00:00Z');
    const resets = 1791996600;
    recordLimits(
      env,
      { rate_limits: { five_hour: { used_percentage: 42.3, resets_at: resets } } },
      now - 5 * MIN,
      now,
    );
    recordUsageApi(env, api(now, { five_hour: { used_percentage: 42, resets_at: resets } }), false, now);
    expect(readLimitsStore(env)?.windows.five_hour).toMatchObject({ pct: 42.3, src: 'payload' });
    recordUsageApi(
      env,
      api(now + MIN, { five_hour: { used_percentage: 45, resets_at: resets } }),
      false,
      now,
    );
    const w = readLimitsStore(env)?.windows.five_hour;
    expect(w).toMatchObject({ pct: 45, src: 'usage-api' });
    expect(w?.samples).toEqual([{ t: now - 5 * MIN, pct: 42.3 }]);
  });

  it('resolves model windows from the store with display names', () => {
    const now = Date.now();
    recordUsageApi(
      env,
      api(now - H, {
        seven_day_models: [{ model: 'Fable', used_percentage: 23, resets_at: iso(now + 3 * D) }],
      }),
      false,
      now,
    );
    const r = resolveLimits({}, readLimitsStore(env), null, now, null);
    expect(r.payload.rate_limits?.seven_day_models).toEqual([
      { model: 'Fable', used_percentage: 23, resets_at: sec(now + 3 * D) },
    ]);
    expect(r.view.windows['model:fable']).toMatchObject({ source: 'limits-cache', model: 'Fable' });
    const legacy = resolveLimits(
      { rate_limits: { seven_day_opus: { used_percentage: 4, resets_at: sec(now + 2 * D) } } },
      readLimitsStore(env),
      null,
      now,
      now,
    ).payload.rate_limits;
    expect(legacy?.seven_day_opus).toBeUndefined();
    expect(legacy?.seven_day_models?.map((m) => `${m.model} ${m.used_percentage}`)).toEqual([
      'Opus 4',
      'Fable 23',
    ]);
  });

  it('sanitizes model names and ignores hostile keys', () => {
    const now = Date.now();
    const resets = iso(now + 3 * D);
    recordUsageApi(
      env,
      api(now, {
        seven_day_models: [
          { model: 'Fa\u001b[2Jble', used_percentage: 5, resets_at: resets },
          { model: '__proto__', used_percentage: 6, resets_at: resets },
          { model: 'x'.repeat(100), used_percentage: 7, resets_at: resets },
        ],
      }),
      false,
      now,
    );
    const w = readLimitsStore(env)?.windows ?? {};
    expect(w['model:fable']?.model).toBe('Fable');
    expect(Object.keys(w)).toHaveLength(2);
    expect(Object.values(w).every((x) => (x.model?.length ?? 0) <= 64)).toBe(true);
    const ok = { pct: 1, resetsAt: now + D, at: now, src: 'usage-api', samples: [] };
    const text = `{"v":1,"windows":{"__proto__":${JSON.stringify(ok)},"model:x":${JSON.stringify({ ...ok, model: 'Y' })},"model:constructor":${JSON.stringify({ ...ok, model: 'constructor' })},"model:y":${JSON.stringify({ ...ok, model: 'Y' })}}}`;
    const parsed = parseLimitsStore(text);
    expect(Object.keys(parsed?.windows ?? {})).toEqual(['model:y']);
    expect(({} as Record<string, unknown>).pct).toBeUndefined();
  });
});
