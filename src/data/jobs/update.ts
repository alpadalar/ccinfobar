import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../../core/paths.js';
import { sanitizeText } from '../../core/sanitize.js';
import type { Config } from '../../core/types.js';
import {
  failEnvelope,
  type Job,
  type JobEnvelope,
  okEnvelope,
  readEnvelope,
  writeEnvelope,
} from './runner.js';

export interface UpdateValue {
  latest: string | null;
  installed?: string;
  rejected?: string;
  rollback?: 'ok' | 'failed' | 'unverified';
  reason?: string;
}

export interface UpdateState {
  checkedAt: number;
  latest: string | null;
  installed?: string;
  rejected?: string;
  rollback?: 'ok' | 'failed' | 'unverified';
  reason?: string;
  error?: string;
  session?: string;
}

const rollbackOf = (v: unknown): 'ok' | 'failed' | 'unverified' | undefined =>
  v === 'ok' || v === 'failed' || v === 'unverified' ? v : undefined;
const reasonOf = (v: unknown): string | undefined =>
  typeof v === 'string' ? sanitizeText(v).slice(0, 200) : undefined;

function rejectFields(o: {
  rejected?: unknown;
  rollback?: unknown;
  reason?: unknown;
}): Pick<UpdateState, 'rejected' | 'rollback' | 'reason'> {
  const out: Pick<UpdateState, 'rejected' | 'rollback' | 'reason'> = {};
  const rejected = version(o.rejected);
  if (rejected) out.rejected = rejected;
  const rollback = rollbackOf(o.rollback);
  if (rollback) out.rollback = rollback;
  const reason = reasonOf(o.reason);
  if (reason !== undefined) out.reason = reason;
  return out;
}

export const DAY = 86_400_000;
export const SESSION_GAP = 60_000;
export const UPDATE_LOCK_MS = 600_000;
export const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const version = (v: unknown): string | null => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);
const session = (v: unknown): string | undefined =>
  typeof v === 'string' && SESSION_RE.test(v) ? v : undefined;

export function updatesDisabled(
  config: Pick<Config, 'update'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return config.update === 'off' || !!env.CI || !!env.CCINFOBAR_NO_UPDATE;
}

export function legacyUpdateFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'update.json');
}

// a corrupt file reads as missing fields
export function readLegacyUpdate(env: NodeJS.ProcessEnv = process.env): UpdateState | null {
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(fs.readFileSync(legacyUpdateFile(env), 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const checkedAt = typeof o.checkedAt === 'number' && Number.isFinite(o.checkedAt) ? o.checkedAt : 0;
  const state: UpdateState = { checkedAt, latest: version(o.latest) };
  const installed = version(o.installed);
  if (installed) state.installed = installed;
  Object.assign(state, rejectFields(o));
  if (typeof o.error === 'string') state.error = sanitizeText(o.error);
  if (typeof o.session === 'string') state.session = o.session;
  return state;
}

export function toUpdateState(e: JobEnvelope<UpdateValue>): UpdateState {
  const state: UpdateState = { checkedAt: e.fetchedAt, latest: version((e.value ?? e.lastGood)?.latest) };
  const installed = e.ok ? version(e.value?.installed) : null;
  if (installed) state.installed = installed;
  if (e.ok) Object.assign(state, rejectFields(e.value ?? {}));
  if (typeof e.error === 'string') state.error = e.error;
  if (typeof e.param === 'string') state.session = e.param;
  return state;
}

export function fromUpdateState(s: UpdateState): JobEnvelope<UpdateValue> {
  const param = session(s.session);
  const p = param ? { param } : {};
  if (s.error === undefined) {
    const value: UpdateValue = { latest: version(s.latest) };
    const installed = version(s.installed);
    if (installed) value.installed = installed;
    Object.assign(value, rejectFields(s));
    return okEnvelope('update', value, s.checkedAt, param);
  }
  const latest = version(s.latest);
  return {
    v: 1,
    key: 'update',
    fetchedAt: s.checkedAt,
    ok: false,
    value: null,
    error: sanitizeText(s.error).slice(0, 200),
    attempts: 1,
    lastGood: latest ? { latest } : null,
    ...p,
  };
}

export function updateDue(state: UpdateState | null, now: number, session?: string): boolean {
  if (!state) return true;
  const age = now - state.checkedAt;
  return age >= DAY || (!!session && session !== state.session && age >= SESSION_GAP);
}

export const updateJob: Job<UpdateValue> = {
  id: 'update',
  network: 'auto',
  lockMs: UPDATE_LOCK_MS,
  timeoutMs: 540_000,
  retryMs: 0,
  keyRe: /^update$/,
  paramRe: SESSION_RE,
  paramOptional: true,
  keys({ config, payload, env }) {
    if (updatesDisabled(config, env)) return [];
    const param = session(payload?.session_id);
    return [param ? { key: 'update', param } : { key: 'update' }];
  },
  accepts(req, { config, env }) {
    return req.key === 'update' && !updatesDisabled(config, env);
  },
  due(e, now, req) {
    return updateDue(e ? toUpdateState(e) : null, now, req.param);
  },
  readPrev(_key, env, reader) {
    const e = reader ? reader.job<UpdateValue>('update') : readEnvelope<UpdateValue>('update', env);
    if (e) return e;
    const s = readLegacyUpdate(env);
    return s ? fromUpdateState(s) : null;
  },
  // the worker and update --background take over project status lines afterwards
  async run(req, ctx) {
    const m = await import('../self-update.js');
    const p = req.param !== undefined ? { param: req.param } : {};
    const prevValue = ctx.prev?.value ?? ctx.prev?.lastGood ?? null;
    try {
      const value = await m.checkForUpdate(ctx.config, undefined, ctx.env, {
        fetch: ctx.fetch,
        rejected: prevValue?.rejected ?? null,
        recordRejected: (v) => {
          writeEnvelope(okEnvelope('update', v, ctx.now, req.param), ctx.env);
        },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (value.error) return failEnvelope('update', ctx.prev, value.error, ctx.now, p);
      return okEnvelope('update', value, ctx.now, req.param);
    } catch (err) {
      return failEnvelope('update', ctx.prev, (err as Error)?.message ?? 'failed', ctx.now, p);
    }
  },
};
