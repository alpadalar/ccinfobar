import {
  ghTokenNames,
  httpItemError,
  httpRefusal,
  parseHeaderSpec,
  parseUrlTemplate,
  resolveUrl,
} from '../../core/http-spec.js';
import type { HttpPathResult, HttpValue } from '../../core/job-values.js';
import { sanitizeText } from '../../core/sanitize.js';
import { ghExec, storedHosts } from './gh.js';
import { httpGroups } from './keys.js';
import { defaultDue, failEnvelope, type Job, okEnvelope } from './runner.js';

export { type HttpGroup, httpGroups } from './keys.js';

const RETRY_MS = 60_000;
const GH_HOST_BLOCK = 3_600_000;
const DEFAULT_INTERVAL = 300;
const MAX_TEXT = 256;
const BAD_VALUE = /[\u0000-\u001f\u007f]/;

function scalar(v: unknown): HttpPathResult {
  if (typeof v === 'string') return { ok: true, v: sanitizeText(v).slice(0, MAX_TEXT) };
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, v } : { ok: false, code: 'not-scalar' };
  if (typeof v === 'boolean' || v === null) return { ok: true, v };
  return { ok: false, code: 'not-scalar' };
}

type JsonPath = typeof import('../../core/jsonpath.js');

function extract(body: unknown, paths: string[], jp: JsonPath): Record<string, HttpPathResult> {
  // paths are user text: __proto__ must stay a key
  const out = Object.create(null) as Record<string, HttpPathResult>;
  for (const p of paths) {
    const parsed = jp.parsePath(p);
    if (!parsed.ok) {
      out[p] = { ok: false, code: 'bad-path' };
      continue;
    }
    const hit = jp.evaluatePath(body, parsed.segs);
    out[p] = hit.found ? scalar(hit.value) : { ok: false, code: 'path-miss' };
  }
  return out;
}

export const httpJob: Job<HttpValue> = {
  id: 'http',
  network: 'explicit',
  lockMs: 60_000,
  timeoutMs: 16_000,
  retryMs: RETRY_MS,
  keyRe: /^http-[0-9a-f]{16}$/,
  keys({ config }) {
    return [...httpGroups(config).values()]
      .filter((g) => httpItemError(g.url, g.headers) === null)
      .map((g) => ({ key: g.key, ttlMs: g.intervalS * 1000, paths: g.paths }));
  },
  accepts(req, { config }) {
    return httpGroups(config).has(req.key);
  },
  due(e, now, req) {
    // a new path on a fresh url would wait a whole interval
    const have = e?.ok ? e.value?.paths : null;
    if (have && typeof have === 'object' && req.paths?.some((p) => !Object.hasOwn(have, p))) return true;
    return defaultDue(e, now, req.ttlMs ?? DEFAULT_INTERVAL * 1000);
  },
  async run(req, ctx) {
    const fail = (error: string, retryAfterMs: number | null = null, blockMs?: number) =>
      failEnvelope(req.key, ctx.prev, error, ctx.now, {
        retryMs: RETRY_MS,
        retryAfterMs,
        ...(blockMs ? { blockMs } : {}),
      });
    const group = httpGroups(ctx.config).get(req.key);
    if (!group) return fail('not-configured');
    // checked before any env value is read
    const refused = httpRefusal(group.url, group.headers);
    if (refused) return fail(refused.code);
    const gh = ghTokenNames(group.url, group.headers);
    if (gh.length) {
      const tpl = parseUrlTemplate(group.url);
      const hosts = await storedHosts(await ghExec(ctx), ctx.env, ctx.now);
      if (typeof hosts === 'string' || !tpl.ok || !hosts.includes(tpl.hostname))
        return fail(`env ${gh[0]} denied`, null, GH_HOST_BLOCK);
    }
    const spec = parseHeaderSpec(group.headers);
    if (spec.errors.length) return fail('bad-headers');
    // secrets stay in locals; only fixed codes and env names leave
    const resolved = resolveUrl(group.url, ctx.env);
    if ('missing' in resolved) return fail(`env ${resolved.missing} not set`);
    if (!resolved.ok) return fail('bad-url');
    const url = resolved.url;
    const headers: Record<string, string> = {};
    for (const h of spec.headers) {
      const v = ctx.env[h.env];
      if (typeof v !== 'string' || !v) return fail(`env ${h.env} not set`);
      if (BAD_VALUE.test(v)) return fail(`env ${h.env} invalid`);
      headers[h.name] = h.scheme ? `${h.scheme} ${v}` : v;
    }
    // fetch and path code load only in the worker
    const { errorCode, fetchJson, JobFetchError } = await import('./fetch.js');
    const jp = await import('../../core/jsonpath.js');
    try {
      const body = await fetchJson(url, {
        fetch: ctx.fetch,
        timeoutMs: group.timeoutMs,
        headers,
        now: ctx.now,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return okEnvelope(req.key, { paths: extract(body, group.paths, jp) }, ctx.now);
    } catch (err) {
      return fail(errorCode(err), err instanceof JobFetchError ? err.retryAfterMs : null);
    }
  },
};
