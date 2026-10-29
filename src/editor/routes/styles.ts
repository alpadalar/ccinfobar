import { LOOK_OPTIONS, lookKeys, type StyleHistory, type StyleSnapshot } from '../../core/edit.js';
import { OPTION_ALIASES } from '../../core/option-aliases.js';
import { writeAtomic } from '../../data/store.js';
import type { ExactRoute } from '../router.js';
import type { EditorCtx } from './ctx.js';
import { httpError, readBody, send } from './util.js';

const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
const TEXT_KEYS = ['color', 'background'];
const FLAG_KEYS = ['bold', 'dim', 'italic', 'raw', 'merge', 'hideEmpty'];
const SNAPSHOT_KEYS = new Set([...TEXT_KEYS, ...FLAG_KEYS, 'options']);
const OPTION_KEYS = new Set([...LOOK_OPTIONS, ...Object.keys(OPTION_ALIASES).flatMap(lookKeys)]);

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const hasForbidden = (o: Record<string, unknown>) => FORBIDDEN.some((k) => Object.hasOwn(o, k));

function optionOk(v: unknown): boolean {
  if (typeof v === 'string') return v.length <= 200;
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'boolean';
}

function optionsOf(raw: unknown, strict: boolean): Record<string, unknown> | null {
  if (!isPlain(raw) || hasForbidden(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (OPTION_KEYS.has(k) && optionOk(v)) out[k] = v;
    else if (strict) return null;
  }
  return out;
}

function snapshotOf(raw: unknown, strict: boolean): StyleSnapshot | null {
  if (!isPlain(raw) || hasForbidden(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!SNAPSHOT_KEYS.has(k)) return null;
    if (TEXT_KEYS.includes(k)) {
      if (typeof v !== 'string' || v.length > 64) return null;
      out[k] = v;
    } else if (FLAG_KEYS.includes(k)) {
      if (typeof v !== 'boolean') return null;
      out[k] = v;
    } else {
      const options = optionsOf(v, strict);
      if (!options) return null;
      out[k] = options;
    }
  }
  return out as StyleSnapshot;
}

export function styleHistoryOf(raw: unknown, mode: 'strict' | 'lenient'): StyleHistory | null {
  const strict = mode === 'strict';
  if (!isPlain(raw) || hasForbidden(raw)) return strict ? null : {};
  const entries = Object.entries(raw);
  if (strict && entries.length > 500) return null;
  const out: StyleHistory = {};
  for (const [id, list] of entries) {
    if (!idOk(id) || !Array.isArray(list) || (strict && list.length > 3)) {
      if (strict) return null;
      continue;
    }
    const snaps: StyleSnapshot[] = [];
    for (const item of list) {
      const snap = snapshotOf(item, strict);
      if (snap) snaps.push(snap);
      else if (strict) return null;
    }
    if (!strict && (!snaps.length || Object.keys(out).length >= 500)) continue;
    out[id] = strict ? snaps : snaps.slice(0, 3);
  }
  return out;
}

const idOk = (id: string) => id.length >= 1 && id.length <= 80;

export const exact: ExactRoute<EditorCtx>[] = [
  {
    method: 'PUT',
    path: '/api/styles',
    handler: async (ctx, req, res) => {
      const body = await readBody(req);
      const keys = isPlain(body) ? Object.keys(body) : [];
      const history =
        isPlain(body) && !hasForbidden(body) && keys.length === 1 && keys[0] === 'history'
          ? styleHistoryOf(body.history, 'strict')
          : null;
      if (!history) throw httpError(400, 'err.server.badStyles');
      writeAtomic(ctx.stylesFile, `${JSON.stringify(history, null, 2)}\n`, { class: 'settings' });
      send(res, 200, { ok: true });
      return;
    },
  },
];
