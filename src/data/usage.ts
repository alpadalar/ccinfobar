import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSelf } from '../commands/update.js';
import { cacheDir, claudeDir } from '../core/paths.js';
import type { Config, RateWindow, StatusPayload } from '../core/types.js';
import { getWidget } from '../widgets/index.js';

type RateLimits = NonNullable<StatusPayload['rate_limits']>;

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FRESH_MS = 180_000;
const MAX_AGE_MS = 30 * 60_000;
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
  return path.join(cacheDir(env), 'usage.json');
}

export function readUsageCache(env: NodeJS.ProcessEnv = process.env): UsageCache | null {
  try {
    return JSON.parse(fs.readFileSync(usageFile(env), 'utf8')) as UsageCache;
  } catch {
    return null;
  }
}

function writeUsageCache(cache: UsageCache, env: NodeJS.ProcessEnv): void {
  try {
    fs.mkdirSync(cacheDir(env), { recursive: true });
    const file = usageFile(env);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch {}
}

export function usageApiDisabled(config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  return !config.usageApi || !!env.CCINFOBAR_NO_USAGE_API;
}

export function needsUsage(config: Config, payload: StatusPayload): boolean {
  const r = payload.rate_limits;
  if (r?.five_hour && r.seven_day) return false;
  return config.lines.some((l) => l.some((i) => getWidget(i.type)?.category === 'limits'));
}

// payload wins, the API fills gaps
export function mergeUsage(
  payload: StatusPayload,
  cache: UsageCache | null,
  now = Date.now(),
): StatusPayload {
  if (!cache?.rate_limits || now - cache.fetchedAt > MAX_AGE_MS) return payload;
  return { ...payload, rate_limits: { ...cache.rate_limits, ...payload.rate_limits } };
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
  const scoped = (model: string) =>
    limits.find(
      (l) =>
        l?.kind === 'weekly_scoped' && (l.scope?.model?.display_name ?? '').toLowerCase().includes(model),
    );
  const out: RateLimits = {};
  const set = (key: keyof Omit<RateLimits, 'spend_limit'>, w: RateWindow | undefined) => {
    if (w) out[key] = w;
  };
  set('five_hour', fromBucket(b.five_hour as Bucket) ?? fromLimit(kind('session')));
  set('seven_day', fromBucket(b.seven_day as Bucket) ?? fromLimit(kind('weekly_all')));
  set('seven_day_sonnet', fromLimit(scoped('sonnet')) ?? fromBucket(b.seven_day_sonnet as Bucket));
  set('seven_day_opus', fromLimit(scoped('opus')) ?? fromBucket(b.seven_day_opus as Bucket));
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

function tokenFrom(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } })
      .claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null;
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now()) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
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

export function readToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = () => {
    try {
      return tokenFrom(fs.readFileSync(path.join(claudeDir(env), '.credentials.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  if (process.platform !== 'darwin') return file();
  return tokenFrom(keychain(keychainService(env))) ?? file();
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
  const keep = (extra: Partial<UsageCache>): UsageCache => ({
    ...(prev?.rate_limits ? { rate_limits: prev.rate_limits, account: prev.account } : {}),
    fetchedAt: prev?.rate_limits ? prev.fetchedAt : now,
    ...extra,
  });
  const token = readToken(env);
  let cache: UsageCache;
  if (!token) {
    cache = { fetchedAt: now, error: 'no Claude login found', blockedUntil: now + NO_TOKEN_MS };
  } else {
    const account = createHash('sha256').update(token).digest('hex').slice(0, 16);
    try {
      const res = await fetcher(USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
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
      if (cache.account && cache.account !== account) cache = { fetchedAt: now, error: cache.error };
    } catch (err) {
      cache = keep({ error: (err as Error).message, blockedUntil: now + RETRY_MS });
    }
  }
  writeUsageCache(cache, env);
  return cache;
}

const LOCK_MS = 30_000;

export function scheduleUsage(env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
  const lock = `${usageFile(env)}.lock`;
  try {
    if (now - fs.statSync(lock).mtimeMs < LOCK_MS) return;
  } catch {}
  try {
    fs.mkdirSync(cacheDir(env), { recursive: true });
    fs.writeFileSync(lock, String(now));
    spawnSelf(['usage', '--background'], env);
  } catch {}
}
