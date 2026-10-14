import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir, claudeDir, claudeJsonPath } from '../core/paths.js';
import { deepSanitize } from '../core/sanitize.js';
import type { Config, ModelWindow, RateWindow, StatusPayload } from '../core/types.js';
import { getWidget } from '../widgets/index.js';
import {
  accountKey,
  captureTime,
  type LimitsView,
  limitsOn,
  readLimitsStore,
  recordUsageApi,
  resolveLimits,
} from './limits.js';
import { detectProvider } from './provider.js';
import { acquireLock, writeAtomic } from './store.js';
import type { TranscriptInfo } from './transcript.js';
import { nonessentialTrafficOff, spawnSelf } from './update-state.js';

type RateLimits = NonNullable<StatusPayload['rate_limits']>;

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FRESH_MS = 180_000;
const RETRY_MS = 60_000;
const BACKOFF_MS = 300_000;
const NO_TOKEN_MS = 10 * 60_000;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface UsageCache {
  fetchedAt: number;
  rate_limits?: RateLimits;
  account?: string;
  error?: string;
  blockedUntil?: number;
}

export function usageFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), `usage-${accountKey(env)}.json`);
}

// read-only fallback, shared by every config dir
export function legacyUsageFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'usage.json');
}

function readUsageText(env: NodeJS.ProcessEnv): string | null {
  try {
    return fs.readFileSync(usageFile(env), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || env.CLAUDE_CONFIG_DIR) return null;
  }
  try {
    return fs.readFileSync(legacyUsageFile(env), 'utf8');
  } catch {
    return null;
  }
}

// cached API text reaches widgets after payload ingest
export function readUsageCache(env: NodeJS.ProcessEnv = process.env): UsageCache | null {
  try {
    const text = readUsageText(env);
    if (text === null) return null;
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? deepSanitize(v as UsageCache) : null;
  } catch {
    return null;
  }
}

function writeUsageCache(cache: UsageCache, env: NodeJS.ProcessEnv): void {
  writeAtomic(usageFile(env), JSON.stringify(cache), { mode: 0o600 });
}

export function usageApiDisabled(config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  return !config.usageApi || !!env.CCINFOBAR_NO_USAGE_API;
}

export function needsUsage(
  config: Config,
  payload: StatusPayload,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!detectProvider(env).planLimits) return false;
  const r = payload.rate_limits;
  const types = config.lines.flat().map((i) => i.type);
  if (types.some((t) => /^weekly-(model|sonnet|opus)-/.test(t)) && !r?.seven_day_models) return true;
  if (r?.five_hour && r.seven_day) return false;
  return types.some((t) => getWidget(t)?.category === 'limits');
}

export interface EffectiveUsage {
  usageOn: boolean;
  usage: UsageCache | null;
  payload: StatusPayload;
  limitsOn: boolean;
  limits: LimitsView | null;
  captureAt: number | null;
}

// render, explain and doctor share this rule
export function effectiveUsage(
  config: Config,
  payload: StatusPayload,
  env: NodeJS.ProcessEnv = process.env,
  opts: { transcript?: () => TranscriptInfo | null; now?: number } = {},
): EffectiveUsage {
  if (!limitsOn(config, env)) {
    return { usageOn: false, usage: null, payload, limitsOn: false, limits: null, captureAt: null };
  }
  const usageOn = !usageApiDisabled(config, env) && needsUsage(config, payload, env);
  const usage = usageOn ? readUsageCache(env) : null;
  const captureAt = captureTime(payload, opts.transcript);
  const r = resolveLimits(payload, readLimitsStore(env), usage, opts.now ?? Date.now(), captureAt);
  return { usageOn, usage, payload: r.payload, limitsOn: true, limits: r.view, captureAt };
}

type Bucket = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type Limit = {
  kind?: string | null;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
};

function fromBucket(b: Bucket): RateWindow | undefined {
  if (b === null) return { used_percentage: 0, resets_at: null };
  if (typeof b?.utilization !== 'number') return undefined;
  return { used_percentage: b.utilization, resets_at: b.resets_at ?? null };
}

function fromLimit(l: Limit | undefined): RateWindow | undefined {
  if (!l || typeof l.percent !== 'number') return undefined;
  if (!l.scope?.model?.display_name && l.percent === 0 && !l.resets_at) return undefined;
  return { used_percentage: l.percent, resets_at: l.resets_at ?? null };
}

export function parseUsageResponse(body: unknown): RateLimits | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const limits = Array.isArray(b.limits) ? (b.limits as Limit[]) : [];
  const kind = (k: string) => limits.find((l) => l?.kind === k);
  const out: RateLimits = {};
  const five = fromBucket(b.five_hour as Bucket) ?? fromLimit(kind('session'));
  const week = fromBucket(b.seven_day as Bucket) ?? fromLimit(kind('weekly_all'));
  if (five) out.five_hour = five;
  if (week) out.seven_day = week;
  const models: ModelWindow[] = [];
  for (const l of limits) {
    const model = l?.kind === 'weekly_scoped' ? l.scope?.model?.display_name : null;
    const w = model ? fromLimit(l) : undefined;
    if (model && w) models.push({ model, ...w });
  }
  for (const [model, key] of [
    ['Sonnet', 'seven_day_sonnet'],
    ['Opus', 'seven_day_opus'],
  ] as const) {
    const bucket = b[key] as Bucket;
    if (bucket && typeof bucket.utilization === 'number' && !models.some((m) => m.model === model)) {
      models.push({ model, used_percentage: bucket.utilization, resets_at: bucket.resets_at ?? null });
    }
  }
  if (models.length) out.seven_day_models = models;
  const x = b.extra_usage as Record<string, unknown> | null | undefined;
  if (x?.is_enabled === true && typeof x.used_credits === 'number') {
    out.spend_limit = {
      used_usd: x.used_credits / 100,
      limit_usd: typeof x.monthly_limit === 'number' ? x.monthly_limit / 100 : null,
      used_percentage: typeof x.utilization === 'number' ? x.utilization : null,
    };
  }
  return out.five_hour || out.seven_day ? out : null;
}

interface Login {
  token: string;
  refresh: string | null;
  uuid: string | null;
}

const MAX_CLAUDE_JSON = 32 * 1024 * 1024;

function uuidOf(v: unknown): string | null {
  const a = (v as { oauthAccount?: { accountUuid?: unknown; organizationUuid?: unknown } } | null)
    ?.oauthAccount;
  if (typeof a?.accountUuid !== 'string' || !a.accountUuid) return null;
  return `${a.accountUuid}\u0000${typeof a.organizationUuid === 'string' ? a.organizationUuid : ''}`;
}

function loginFrom(raw: string | null): Login | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
    };
    const oauth = v.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null;
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now()) return null;
    const refresh = typeof oauth.refreshToken === 'string' && oauth.refreshToken ? oauth.refreshToken : null;
    return { token: oauth.accessToken, refresh, uuid: uuidOf(v) };
  } catch {
    return null;
  }
}

// oauthAccount only; the file can be large
function claudeJsonUuid(env: NodeJS.ProcessEnv): string | null {
  try {
    const file = claudeJsonPath(env);
    if (fs.statSync(file).size > MAX_CLAUDE_JSON) return null;
    return uuidOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

const hash16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// stable across token refreshes: account uuid, else refresh token, else access token
export function loginAccount(login: Login, env: NodeJS.ProcessEnv = process.env): string {
  const uuid = login.uuid ?? claudeJsonUuid(env);
  if (uuid) return hash16(`uuid\u0000${uuid}`);
  if (login.refresh) return hash16(`refresh\u0000${login.refresh}`);
  return hash16(login.token);
}

function keychain(service: string): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

export function keychainService(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR;
  if (!dir) return KEYCHAIN_SERVICE;
  const suffix = createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${suffix}`;
}

export function readLogin(env: NodeJS.ProcessEnv = process.env): Login | null {
  const file = () => {
    try {
      return loginFrom(fs.readFileSync(path.join(claudeDir(env), '.credentials.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  if (process.platform !== 'darwin') return file();
  return loginFrom(keychain(keychainService(env))) ?? file();
}

export function usageDue(cache: UsageCache | null, now = Date.now()): boolean {
  if (!cache) return true;
  if (cache.blockedUntil && now < cache.blockedUntil) return false;
  return now - cache.fetchedAt >= (cache.error ? RETRY_MS : FRESH_MS);
}

export async function fetchUsage(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<UsageCache> {
  const now = Date.now();
  const prev = readUsageCache(env);
  const known = prev?.account ? { account: prev.account } : {};
  const keep = (extra: Partial<UsageCache>): UsageCache => ({
    ...(prev?.rate_limits ? { rate_limits: prev.rate_limits } : {}),
    ...known,
    fetchedAt: prev?.rate_limits ? prev.fetchedAt : now,
    ...extra,
  });
  const login = readLogin(env);
  let account: string | undefined;
  let cache: UsageCache;
  if (!login) {
    cache = { fetchedAt: now, error: 'no Claude login found', blockedUntil: now + NO_TOKEN_MS, ...known };
  } else {
    account = loginAccount(login, env);
    try {
      const res = await fetcher(USAGE_URL, {
        headers: {
          authorization: `Bearer ${login.token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'user-agent': 'ccinfobar',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(after) && after > 0 ? after * 1000 : BACKOFF_MS;
        cache = keep({ error: 'rate limited by the usage API', blockedUntil: now + wait });
      } else if (!res.ok) {
        cache = keep({ error: `usage API returned ${res.status}`, blockedUntil: now + RETRY_MS });
      } else {
        const limits = parseUsageResponse(await res.json());
        cache = limits
          ? { fetchedAt: now, rate_limits: limits, account }
          : keep({ error: 'usage API sent no limits', blockedUntil: now + BACKOFF_MS });
      }
    } catch (err) {
      cache = keep({ error: (err as Error).message, blockedUntil: now + RETRY_MS });
    }
    if (cache.account !== account) {
      const { rate_limits: _, ...rest } = cache;
      cache = { ...rest, fetchedAt: now, account };
    }
  }
  cache = deepSanitize(cache);
  writeUsageCache(cache, env);
  const changed = !!account && !!prev?.account && prev.account !== account;
  if (account && (cache.rate_limits || changed)) recordUsageApi(env, cache, changed, now);
  return cache;
}

const LOCK_MS = 30_000;

export function scheduleUsage(env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
  if (nonessentialTrafficOff(env)) return;
  if (!acquireLock(`${usageFile(env)}.lock`, LOCK_MS, now)) return;
  try {
    spawnSelf(['usage', '--background'], env);
  } catch {}
}
