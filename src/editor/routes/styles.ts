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

const MAX_IDS = 500;
const MAX_SNAPSHOTS = 3;

type Part<T> = T | 'bad' | 'drop';

// a wrong type is bad; a value that is only too long is dropped
function optionState(v: unknown): 'ok' | 'bad' | 'drop' {
  if (typeof v === 'string') return v.length <= 200 ? 'ok' : 'drop';
  if (typeof v === 'number') return Number.isFinite(v) ? 'ok' : 'bad';
  return typeof v === 'boolean' ? 'ok' : 'bad';
}

function optionsOf(raw: unknown, strict: boolean): Part<Record<string, unknown>> {
  if (!isPlain(raw) || hasForbidden(raw)) return 'bad';
  const out: Record<string, unknown> = {};
  let drop = false;
  for (const [k, v] of Object.entries(raw)) {
    const state = OPTION_KEYS.has(k) ? optionState(v) : 'bad';
    if (state === 'ok') out[k] = v;
    else if (strict) {
      if (state === 'bad') return 'bad';
      drop = true;
    }
  }
  return drop ? 'drop' : out;
}

function snapshotOf(raw: unknown, strict: boolean): Part<StyleSnapshot> {
  if (!isPlain(raw) || hasForbidden(raw)) return 'bad';
  const out: Record<string, unknown> = {};
  let drop = false;
  for (const [k, v] of Object.entries(raw)) {
    if (!SNAPSHOT_KEYS.has(k)) return 'bad';
    if (TEXT_KEYS.includes(k)) {
      if (typeof v !== 'string') return 'bad';
      if (v.length > 64) drop = true;
      out[k] = v;
    } else if (FLAG_KEYS.includes(k)) {
      if (typeof v !== 'boolean') return 'bad';
      out[k] = v;
    } else {
      const options = optionsOf(v, strict);
      if (options === 'bad') return 'bad';
      if (options === 'drop') drop = true;
      else out[k] = options;
    }
  }
  return drop ? 'drop' : (out as StyleSnapshot);
}

export function styleHistoryOf(raw: unknown, mode: 'strict' | 'lenient'): StyleHistory | null {
  const strict = mode === 'strict';
  if (!isPlain(raw) || hasForbidden(raw)) return strict ? null : {};
  const out: StyleHistory = {};
  for (const [id, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) {
      if (strict) return null;
      continue;
    }
    if (!strict && !idOk(id)) continue;
    const snaps: StyleSnapshot[] = [];
    for (const item of list) {
      const snap = snapshotOf(item, strict);
      if (snap === 'bad') {
        if (strict) return null;
      } else if (snap !== 'drop') snaps.push(snap);
    }
    if (!idOk(id) || !snaps.length || Object.keys(out).length >= MAX_IDS) continue;
    out[id] = snaps.slice(0, MAX_SNAPSHOTS);
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
