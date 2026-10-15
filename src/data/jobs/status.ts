import type { StatusIncident, StatusIndicator, StatusValue } from '../../core/job-values.js';
import { sanitizeText } from '../../core/sanitize.js';
import type { Config } from '../../core/types.js';
import { defaultDue, failEnvelope, type Job, okEnvelope } from './runner.js';

export const STATUS_URL = 'https://status.claude.com/api/v2/summary.json';
export const STATUS_KEY = 'status';

const RETRY_MS = 60_000;
const DEFAULT_INTERVAL = 180;
const MIN_INTERVAL = 120;
const MAX_INTERVAL = 600;
const MAX_INCIDENTS = 5;
const MAX_COMPONENTS = 10;
const MAX_TEXT = 200;

const RANK: Record<StatusIndicator, number> = { critical: 4, major: 3, minor: 2, maintenance: 1, none: 0 };
const DONE = new Set(['resolved', 'postmortem', 'completed']);

const level = (v: unknown): StatusIndicator =>
  typeof v === 'string' && Object.hasOwn(RANK, v) ? (v as StatusIndicator) : 'minor';

const text = (v: unknown): string => (typeof v === 'string' ? sanitizeText(v).slice(0, MAX_TEXT) : '');

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseIncident(v: unknown): StatusIncident | null {
  if (!isObj(v) || typeof v.name !== 'string') return null;
  if (typeof v.status === 'string' && DONE.has(v.status)) return null;
  const components = Array.isArray(v.components)
    ? v.components
        .filter((c): c is Record<string, unknown> => isObj(c) && typeof c.name === 'string')
        .slice(0, MAX_COMPONENTS)
        .map((c) => text(c.name))
    : [];
  return {
    name: text(v.name),
    impact: level(v.impact),
    components,
    updatedAt: typeof v.updated_at === 'string' ? text(v.updated_at) : null,
  };
}

const time = (i: StatusIncident): number => {
  const t = i.updatedAt ? Date.parse(i.updatedAt) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

// components are read from incidents only; degraded-without-incident is deferred
export function parseSummary(body: unknown): StatusValue | null {
  if (!isObj(body) || !isObj(body.status)) return null;
  const incidents = (Array.isArray(body.incidents) ? body.incidents : [])
    .map(parseIncident)
    .filter((i): i is StatusIncident => i !== null)
    .sort((a, b) => RANK[b.impact] - RANK[a.impact] || time(b) - time(a) || 0)
    .slice(0, MAX_INCIDENTS);
  return { indicator: level(body.status.indicator), description: text(body.status.description), incidents };
}

function intervals(config: Config): number[] {
  const out: number[] = [];
  for (const line of config.lines ?? []) {
    for (const item of line ?? []) {
      if (item?.type !== 'service-status') continue;
      const raw = item.options?.interval;
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
      out.push(Number.isFinite(n) ? n : DEFAULT_INTERVAL);
    }
  }
  return out;
}

export function statusTtlMs(config: Config): number | null {
  const all = intervals(config);
  if (!all.length) return null;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.min(...all))) * 1000;
}

export const statusJob: Job<StatusValue> = {
  id: 'status',
  network: 'auto',
  lockMs: 60_000,
  timeoutMs: 8_000,
  retryMs: RETRY_MS,
  keyRe: /^status$/,
  keys({ config }) {
    const ttlMs = statusTtlMs(config);
    return ttlMs === null ? [] : [{ key: STATUS_KEY, ttlMs }];
  },
  accepts(req, { config }) {
    return req.key === STATUS_KEY && statusTtlMs(config) !== null;
  },
  due(e, now, req) {
    return defaultDue(e, now, req.ttlMs ?? DEFAULT_INTERVAL * 1000);
  },
  async run(req, ctx) {
    // fetch code loads only in the worker
    const { errorCode, fetchJson, JobFetchError } = await import('./fetch.js');
    try {
      const body = await fetchJson(new URL(STATUS_URL), {
        fetch: ctx.fetch,
        timeoutMs: 5000,
        now: ctx.now,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const value = parseSummary(body);
      if (value) return okEnvelope(req.key, value, ctx.now);
      return failEnvelope(req.key, ctx.prev, 'bad-json', ctx.now, { retryMs: RETRY_MS });
    } catch (err) {
      return failEnvelope(req.key, ctx.prev, errorCode(err), ctx.now, {
        retryMs: RETRY_MS,
        retryAfterMs: err instanceof JobFetchError ? err.retryAfterMs : null,
      });
    }
  },
};
