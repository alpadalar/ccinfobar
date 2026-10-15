import { limitsOn } from '../limits.js';
import {
  fetchUsageEnvelope,
  fromUsageCache,
  needsUsage,
  recordUsage,
  toUsageCache,
  type UsageValue,
  usageApiDisabled,
  usageDue,
  usageKey,
  usagePrev,
} from '../usage.js';
import type { Job } from './runner.js';

export const usageJob: Job<UsageValue> = {
  id: 'usage',
  network: 'auto',
  lockMs: 30_000,
  timeoutMs: 10_000,
  retryMs: 60_000,
  keyRe: /^usage-[0-9a-f]{16}$/,
  keys({ config, payload, env }) {
    if (!limitsOn(config, env) || usageApiDisabled(config, env)) return [];
    return needsUsage(config, payload ?? {}, env) ? [{ key: usageKey(env) }] : [];
  },
  accepts(req, { config, env }) {
    return req.key === usageKey(env) && limitsOn(config, env) && !usageApiDisabled(config, env);
  },
  due(e, now) {
    return usageDue(e ? toUsageCache(e) : null, now);
  },
  readPrev(key, env) {
    if (key !== usageKey(env)) return null;
    const prev = usagePrev(env);
    return prev.envelope ?? (prev.cache ? fromUsageCache(key, prev.cache, null) : null);
  },
  async run(req, ctx) {
    const prev = ctx.prev ? toUsageCache(ctx.prev) : null;
    const r = await fetchUsageEnvelope(prev, ctx.env, ctx.fetch, ctx.now);
    recordUsage(ctx.env, prev, r, ctx.now);
    return fromUsageCache(req.key, r.cache, ctx.prev, ctx.now);
  },
};
