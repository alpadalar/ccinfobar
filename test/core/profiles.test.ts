import { describe, expect, it } from 'vitest';
import {
  globMatch,
  normalizeProfileOverride,
  PROFILES,
  PROFILES_UPDATED,
  resolveProfile,
} from '../../src/core/profiles.js';
import type { Provider } from '../../src/data/provider.js';

const gw = (host: string): Provider => ({ kind: 'gateway', host, planLimits: false });
const first: Provider = { kind: 'firstParty', planLimits: true };
const none = {};

describe('globMatch', () => {
  it('matches case-insensitively and anchored', () => {
    expect(globMatch('glm-5.3*', 'GLM-5.3')).toBe(true);
    expect(globMatch('glm-5', 'glm-5.1')).toBe(false);
    expect(globMatch('glm-5', 'GLM-5')).toBe(true);
    expect(globMatch('*-pro', 'deepseek-v4-pro')).toBe(true);
    expect(globMatch('*-pro', 'deepseek-v4-pro-x')).toBe(false);
  });

  it('treats regex characters literally', () => {
    expect(globMatch('a.b*', 'a.bc')).toBe(true);
    expect(globMatch('a.b*', 'axbc')).toBe(false);
    expect(globMatch('(a)+[b]', '(a)+[b]')).toBe(true);
    expect(globMatch('(a)+[b]', 'aab')).toBe(false);
  });

  it('handles several stars in order', () => {
    expect(globMatch('a*b*c', 'axxbyyc')).toBe(true);
    expect(globMatch('a*b*c', 'acb')).toBe(false);
    expect(globMatch('ab*ba', 'aba')).toBe(false);
    expect(globMatch('**', '')).toBe(true);
  });

  it('stays fast on long star-heavy globs', () => {
    const glob = `${'a*'.repeat(99)}b`;
    const start = Date.now();
    expect(globMatch(glob, 'a'.repeat(5000))).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('PROFILES table', () => {
  it('has the research date and the covered vendors', () => {
    expect(PROFILES_UPDATED).toBe('2026-10-14');
    expect(new Set(PROFILES.map((v) => v.label))).toEqual(
      new Set(['GLM', 'Kimi', 'DeepSeek', 'MiniMax', 'Qwen']),
    );
  });

  it('notes price tiers', () => {
    const note = (id: string) => PROFILES.find((v) => v.id === id)?.priceNote;
    expect(note('deepseek')).toBe('peak price; off-peak is half');
    expect(note('minimax')).toBe('up to 512K input; above is double');
    expect(note('qwen-intl')).toBe('International region list price');
  });

  it('orders specific globs before the general ones', () => {
    for (const v of PROFILES) {
      v.models.forEach((a, i) => {
        for (const b of v.models.slice(0, i)) {
          const probe = a.match.replace(/\*/g, '');
          expect(globMatch(b.match, probe), `${v.id}: ${b.match} hides ${a.match}`).toBe(false);
        }
      });
    }
  });
});

describe('resolveProfile', () => {
  it('prices a vendor model on its own host and strips [1m]', () => {
    expect(resolveProfile({ id: 'glm-5.3[1m]' }, gw('api.z.ai'), none)).toEqual({
      source: 'builtIn',
      vendor: 'GLM',
      label: 'GLM-5.3',
      contextWindow: 1_000_000,
      prices: { input: 1.4, output: 4.4, cacheRead: 0.26 },
      currency: 'USD',
      hostMatch: true,
    });
    expect(
      resolveProfile({ id: 'MiniMax-M3.1-Flash-Preview[1M]' }, gw('api.minimax.io'), none),
    ).toMatchObject({ label: 'MiniMax M3.1 Flash Preview', contextWindow: 1_000_000, prices: null });
  });

  it('prefers the most specific glob', () => {
    const label = (id: string, host = 'api.z.ai') => resolveProfile({ id }, gw(host), none)?.label;
    expect(label('glm-5.3-flashx')).toBe('GLM-5.3 FlashX');
    expect(label('glm-5.3-flash')).toBe('GLM-5.3 Flash');
    expect(label('glm-5.1')).toBe('GLM-5.1');
    expect(label('glm-5')).toBe('GLM-5');
    expect(label('kimi-k2.7-code-highspeed', 'api.moonshot.ai')).toBe('Kimi K2.7 Code HighSpeed');
    expect(label('minimax-m2.7-highspeed', 'api.minimax.io')).toBe('MiniMax M2.7 HighSpeed');
    expect(label('minimax-m2', 'api.minimax.io')).toBe('MiniMax M2');
  });

  it('gives label and window but no prices through another gateway', () => {
    expect(resolveProfile({ id: 'deepseek-v4-pro' }, gw('openrouter.ai'), none)).toEqual({
      source: 'builtIn',
      vendor: 'DeepSeek',
      label: 'DeepSeek V4 Pro',
      contextWindow: 1_000_000,
      prices: null,
      currency: null,
      hostMatch: false,
    });
    const bedrock: Provider = { kind: 'bedrock', planLimits: false };
    expect(resolveProfile({ id: 'kimi-k3' }, bedrock, none)?.prices).toBeNull();
  });

  it('knows the vendor host even for an unknown model', () => {
    expect(resolveProfile({ id: 'claude-opus-4' }, gw('api.deepseek.com'), none)).toEqual({
      source: 'builtIn',
      vendor: 'DeepSeek',
      label: null,
      contextWindow: null,
      prices: null,
      currency: null,
      hostMatch: true,
    });
  });

  it('uses no built-ins for first party', () => {
    expect(resolveProfile({ id: 'glm-5.3' }, first, none)).toBeNull();
    expect(resolveProfile({ id: 'claude-opus-4' }, gw('openrouter.ai'), none)).toBeNull();
    expect(resolveProfile(undefined, gw('api.z.ai'), none)).toBeNull();
  });

  it('lets the first matching override win for any provider', () => {
    const config = {
      profiles: {
        models: [
          { match: 'glm-5.3*', contextWindow: 500000, input: 1, output: 2, currency: 'CNY' },
          { match: 'glm-*', label: 'later' },
        ],
      },
    };
    const want = {
      source: 'override',
      vendor: null,
      label: null,
      contextWindow: 500000,
      prices: { input: 1, output: 2 },
      currency: 'CNY',
    };
    expect(resolveProfile({ id: 'glm-5.3' }, first, config)).toEqual({ ...want, hostMatch: false });
    expect(resolveProfile({ id: 'glm-5.3' }, gw('api.z.ai'), config)).toEqual({ ...want, hostMatch: true });
    expect(resolveProfile({ id: 'glm-4.6' }, first, config)?.label).toBe('later');
  });

  it('matches overrides on the display name too', () => {
    const config = { profiles: { models: [{ match: 'My Model', input: 1, output: 3 }] } };
    expect(resolveProfile({ id: 'x-1', display_name: 'my model' }, first, config)).toMatchObject({
      prices: { input: 1, output: 3 },
      currency: 'USD',
    });
  });

  it('turns built-ins off but keeps overrides', () => {
    const off = { profiles: { builtIn: false } };
    expect(resolveProfile({ id: 'glm-5.3' }, gw('api.z.ai'), off)).toBeNull();
    const withOverride = { profiles: { builtIn: false, models: [{ match: 'glm-5.3', label: 'Mine' }] } };
    expect(resolveProfile({ id: 'glm-5.3' }, gw('api.z.ai'), withOverride)?.label).toBe('Mine');
  });

  it('matches host suffixes on a dot boundary', () => {
    expect(resolveProfile({ id: 'glm-5.3' }, gw('eu.api.z.ai'), none)?.hostMatch).toBe(true);
    expect(resolveProfile({ id: 'glm-5.3' }, gw('notapi.z.ai'), none)).toMatchObject({
      hostMatch: false,
      prices: null,
    });
  });

  it('carries CNY without prices for BigModel and Qwen International prices', () => {
    expect(resolveProfile({ id: 'glm-5.3' }, gw('open.bigmodel.cn'), none)).toMatchObject({
      vendor: 'GLM',
      contextWindow: 1_000_000,
      prices: null,
      currency: 'CNY',
    });
    expect(
      resolveProfile({ id: 'qwen3.8-max' }, gw('ap-southeast-1.maas.aliyuncs.com'), none)?.prices,
    ).toEqual({ input: 2, output: 6 });
    expect(resolveProfile({ id: 'qwen3.8-max' }, gw('dashscope.aliyuncs.com'), none)).toMatchObject({
      label: 'Qwen',
      prices: null,
      currency: null,
    });
  });
});

describe('normalizeProfileOverride', () => {
  it('keeps valid fields and drops bad ones', () => {
    expect(
      normalizeProfileOverride({
        match: 'glm-*',
        label: 'GLM\u001b[31m',
        contextWindow: 500000,
        input: 1,
        output: -2,
        cacheRead: Number.POSITIVE_INFINITY,
        cacheWrite: '3',
        currency: 'cny',
        extra: true,
      }),
    ).toEqual({ match: 'glm-*', label: 'GLM', contextWindow: 500000, input: 1, currency: 'CNY' });
  });

  it('refuses entries without a usable match', () => {
    for (const raw of [
      null,
      [],
      'x',
      { match: '' },
      { match: '  ' },
      { match: 'a'.repeat(201) },
      { match: 3 },
    ]) {
      expect(normalizeProfileOverride(raw)).toBeNull();
    }
    expect(normalizeProfileOverride({ match: 'a'.repeat(200) })).toEqual({ match: 'a'.repeat(200) });
  });

  it('drops fractional windows and bad currencies', () => {
    expect(normalizeProfileOverride({ match: 'x', contextWindow: 1.5, currency: 'US' })).toEqual({
      match: 'x',
    });
    expect(normalizeProfileOverride({ match: 'x', currency: 'EURO' })).toEqual({ match: 'x' });
  });
});
