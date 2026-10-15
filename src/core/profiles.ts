import type { Provider } from '../data/provider.js';
import { sanitizeText } from './sanitize.js';
import type { ProfileOverride, ProfilesConfig } from './types.js';

export interface ProfileModel {
  match: string;
  label: string;
  contextWindow: number | null;
  input: number | null;
  output: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}

export interface ProfileVendor {
  id: string;
  label: string;
  hosts: string[];
  currency: string | null;
  priceNote?: string;
  models: ProfileModel[];
}

export interface ProfilePrices {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ResolvedProfile {
  source: 'override' | 'builtIn';
  vendor: string | null;
  label: string | null;
  contextWindow: number | null;
  prices: ProfilePrices | null;
  currency: string | null;
  hostMatch: boolean;
}

export const PROFILES_UPDATED = '2026-10-14';

const m = (
  match: string,
  label: string,
  contextWindow: number | null,
  input: number | null,
  output: number | null,
  cacheRead: number | null = null,
  cacheWrite: number | null = null,
): ProfileModel => ({ match, label, contextWindow, input, output, cacheRead, cacheWrite });

const GLM: ProfileModel[] = [
  m('glm-5.3-flashx*', 'GLM-5.3 FlashX', null, 0.37, 1.25, 0.075),
  m('glm-5.3-flash*', 'GLM-5.3 Flash', 1_000_000, 0.15, 0.5, 0.03),
  m('glm-5.3*', 'GLM-5.3', 1_000_000, 1.4, 4.4, 0.26),
  m('glm-5.2*', 'GLM-5.2', 1_000_000, 1.4, 4.4, 0.26),
  m('glm-5.1*', 'GLM-5.1', 200_000, 1.4, 4.4, 0.26),
  m('glm-5', 'GLM-5', 200_000, 1, 3.2, 0.2),
  m('glm-4.7*', 'GLM-4.7', 200_000, 0.6, 2.2, 0.11),
  m('glm-4.6*', 'GLM-4.6', 200_000, 0.6, 2.2, 0.11),
];

// per 1M tokens, vendor list prices on PROFILES_UPDATED; null = not verified
export const PROFILES: readonly ProfileVendor[] = [
  { id: 'zai', label: 'GLM', hosts: ['api.z.ai'], currency: 'USD', models: GLM },
  {
    id: 'bigmodel',
    label: 'GLM',
    hosts: ['open.bigmodel.cn'],
    currency: 'CNY',
    priceNote: 'CNY prices not verified',
    models: GLM.map((g) => m(g.match, g.label, g.contextWindow, null, null)),
  },
  {
    id: 'moonshot',
    label: 'Kimi',
    hosts: ['api.moonshot.ai'],
    currency: 'USD',
    priceNote: 'cache write is the 5 minute TTL price',
    models: [
      m('kimi-k3*', 'Kimi K3', 1_048_576, 3, 15, 0.3, 3),
      m('kimi-k2.7-code-highspeed*', 'Kimi K2.7 Code HighSpeed', 262_144, 1.9, 8, 0.38),
      m('kimi-k2.7-code*', 'Kimi K2.7 Code', 262_144, 0.95, 4, 0.19),
      m('kimi-k2.6*', 'Kimi K2.6', 262_144, 0.95, 4, 0.16),
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hosts: ['api.deepseek.com'],
    currency: 'USD',
    priceNote: 'peak price; off-peak is half',
    models: [
      m('deepseek-v4-pro*', 'DeepSeek V4 Pro', 1_000_000, 1.32, 3.96, 0.044),
      m('deepseek-flash*', 'DeepSeek V4 Flash', 1_000_000, 0.3, 1.2, 0.006),
      m('deepseek-v4-flash*', 'DeepSeek V4 Flash', 1_000_000, 0.3, 1.2, 0.006),
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    hosts: ['api.minimax.io'],
    currency: 'USD',
    priceNote: 'up to 512K input; above is double',
    models: [
      m('minimax-m3.1-flash-preview*', 'MiniMax M3.1 Flash Preview', 1_000_000, null, null),
      m('minimax-m3*', 'MiniMax M3', 1_000_000, 0.3, 1.2, 0.06),
      m('minimax-m2.7-highspeed*', 'MiniMax M2.7 HighSpeed', 204_800, 0.6, 2.4, 0.06, 0.375),
      m('minimax-m2.7*', 'MiniMax M2.7', 204_800, 0.3, 1.2, 0.06, 0.375),
      m('minimax-m2.5-highspeed*', 'MiniMax M2.5 HighSpeed', 204_800, 0.6, 2.4, 0.03, 0.375),
      m('minimax-m2.1-highspeed*', 'MiniMax M2.1 HighSpeed', 204_800, 0.6, 2.4, 0.03, 0.375),
      m('minimax-m2.5*', 'MiniMax M2.5', 204_800, 0.3, 1.2, 0.03, 0.375),
      m('minimax-m2.1*', 'MiniMax M2.1', 204_800, 0.3, 1.2, 0.03, 0.375),
      m('minimax-m2', 'MiniMax M2', 204_800, 0.3, 1.2, 0.03, 0.375),
    ],
  },
  {
    id: 'qwen-intl',
    label: 'Qwen',
    hosts: ['ap-southeast-1.maas.aliyuncs.com'],
    currency: 'USD',
    priceNote: 'International region list price',
    models: [
      m('qwen3.8-max*', 'Qwen3.8 Max', null, 2, 6),
      m('qwen3.8-flash*', 'Qwen3.8 Flash', null, 0.15, 0.47),
      m('qwen*', 'Qwen', null, null, null),
    ],
  },
  {
    id: 'qwen',
    label: 'Qwen',
    hosts: [
      'cn-beijing.maas.aliyuncs.com',
      'us-east-1.maas.aliyuncs.com',
      'dashscope.aliyuncs.com',
      'coding.dashscope.aliyuncs.com',
      'coding-intl.dashscope.aliyuncs.com',
    ],
    currency: null,
    priceNote: 'regional prices and plans vary',
    models: [m('qwen*', 'Qwen', null, null, null)],
  },
];

const compiled = new Map<string, string[]>();

function parts(glob: string): string[] {
  let p = compiled.get(glob);
  if (!p) {
    if (compiled.size > 500) compiled.clear();
    p = glob.toLowerCase().split('*');
    compiled.set(glob, p);
  }
  return p;
}

// `*` only, anchored, case-insensitive; no regex so no backtracking
export function globMatch(glob: string, text: string): boolean {
  const p = parts(glob);
  const s = text.toLowerCase();
  if (p.length === 1) return s === p[0];
  const first = p[0]!;
  const last = p[p.length - 1]!;
  if (s.length < first.length + last.length || !s.startsWith(first) || !s.endsWith(last)) return false;
  const end = s.length - last.length;
  let at = first.length;
  for (let i = 1; i < p.length - 1; i++) {
    const part = p[i]!;
    if (!part) continue;
    const j = s.indexOf(part, at);
    if (j < 0 || j + part.length > end) return false;
    at = j + part.length;
  }
  return true;
}

export const PROFILE_MATCH_MAX = 200;
export const PROFILE_LABEL_MAX = 60;
export const PROFILE_OVERRIDES_MAX = 100;
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

export function normalizeProfileOverride(raw: unknown): ProfileOverride | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const match = r.match;
  if (typeof match !== 'string' || !match.trim() || match.length > PROFILE_MATCH_MAX) return null;
  const out: ProfileOverride = { match };
  if (typeof r.label === 'string') {
    const label = sanitizeText(r.label).trim().slice(0, PROFILE_LABEL_MAX);
    if (label) out.label = label;
  }
  const win = positive(r.contextWindow);
  if (win !== undefined && Number.isInteger(win)) out.contextWindow = win;
  for (const k of PRICE_KEYS) {
    const v = positive(r[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof r.currency === 'string' && /^[a-z]{3}$/i.test(r.currency))
    out.currency = r.currency.toUpperCase();
  return out;
}

const strip = (s: string | undefined) => (typeof s === 'string' ? s.replace(/\[1m\]$/i, '') : '');

function hostVendor(provider: Provider): ProfileVendor | null {
  const host = provider.host?.toLowerCase();
  if (!host) return null;
  return PROFILES.find((v) => v.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null;
}

function priced(p: {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}): ProfilePrices | null {
  if (typeof p.input !== 'number' || typeof p.output !== 'number') return null;
  const out: ProfilePrices = { input: p.input, output: p.output };
  if (typeof p.cacheRead === 'number') out.cacheRead = p.cacheRead;
  if (typeof p.cacheWrite === 'number') out.cacheWrite = p.cacheWrite;
  return out;
}

export function resolveProfile(
  model: { id?: string; display_name?: string } | undefined,
  provider: Provider,
  config: { profiles?: ProfilesConfig },
): ResolvedProfile | null {
  const names = [strip(model?.id), strip(model?.display_name)].filter(Boolean);
  if (!names.length) return null;
  const hits = (glob: string) => names.some((n) => globMatch(glob, n));
  const vendor = provider.kind === 'firstParty' ? null : hostVendor(provider);
  for (const o of config.profiles?.models ?? []) {
    if (!o || typeof o.match !== 'string' || !hits(o.match)) continue;
    const prices = priced(o);
    return {
      source: 'override',
      vendor: null,
      label: o.label ?? null,
      contextWindow: o.contextWindow ?? null,
      prices,
      currency: o.currency ?? (prices ? 'USD' : null),
      hostMatch: !!vendor,
    };
  }
  if (config.profiles?.builtIn === false || provider.kind === 'firstParty') return null;
  if (vendor) {
    const hit = vendor.models.find((p) => hits(p.match));
    return {
      source: 'builtIn',
      vendor: vendor.label,
      label: hit?.label ?? null,
      contextWindow: hit?.contextWindow ?? null,
      prices: hit ? priced(hit) : null,
      currency: hit ? vendor.currency : null,
      hostMatch: true,
    };
  }
  for (const v of PROFILES) {
    const hit = v.models.find((p) => hits(p.match));
    if (!hit) continue;
    return {
      source: 'builtIn',
      vendor: v.label,
      label: hit.label,
      contextWindow: hit.contextWindow,
      prices: null,
      currency: null,
      hostMatch: false,
    };
  }
  return null;
}
