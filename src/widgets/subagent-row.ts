import { type Level, style } from '../core/ansi.js';
import { truncate, visibleWidth } from '../core/width.js';
import { formatTokens, SUBAGENT_FIELDS, type SubagentField, shortModel, span, sparkline } from './shared.js';

export interface RowOpts {
  columns: number;
  now: number;
  fields: readonly SubagentField[];
  text: boolean;
  level: Level;
}

type Obj = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const GROUPS: SubagentField[][] = [
  ['status', 'type'],
  ['spark', 'tokens', 'context'],
  ['model', 'effort'],
];
const sameGroup = (a: SubagentField, b: SubagentField) => GROUPS.some((g) => g.includes(a) && g.includes(b));

const DROP: SubagentField[] = ['spark', 'effort', 'context', 'model', 'elapsed', 'tokens'];

function mark(status: unknown, o: RowOpts): string {
  const t = o.text;
  switch (status) {
    case 'running':
      return style(t ? '>' : '▸', { fg: 'green' }, o.level);
    case 'completed':
      return style(t ? '+' : '✓', { dim: true }, o.level);
    case 'failed':
      return style(t ? 'x' : '✗', { fg: 'red' }, o.level);
    case 'killed':
      return style(t ? '-' : '■', { dim: true }, o.level);
    default:
      return style(t ? '.' : '·', { dim: true }, o.level);
  }
}

function part(f: SubagentField, k: Obj, o: RowOpts): string | null {
  switch (f) {
    case 'status':
      return mark(k.status, o);
    case 'type':
      return str(k.agentType) ?? str(k.name) ?? str(k.type);
    case 'label':
      return str(k.label) ?? str(k.description);
    case 'spark': {
      const s = Array.isArray(k.tokenSamples) ? k.tokenSamples.filter((v) => num(v) !== null) : [];
      if (s.length < 2) return null;
      const deltas: number[] = [];
      for (let i = 1; i < s.length; i++) {
        const d = (s[i] as number) - (s[i - 1] as number);
        if (d > 0) deltas.push(d);
      }
      return sparkline(deltas, 8, { ascii: o.text }) || null;
    }
    case 'tokens': {
      const n = num(k.tokenCount);
      return n !== null && n >= 0 ? formatTokens(n) : null;
    }
    case 'context': {
      const n = num(k.tokenCount);
      const w = num(k.contextWindowSize);
      return n !== null && w !== null && n > 0 && w > 0 ? `${Math.round((n / w) * 100)}%` : null;
    }
    case 'model':
      return shortModel(str(k.model)) || null;
    case 'effort': {
      const e = k.effort;
      if (typeof e === 'string') return str(e);
      const n = num(e);
      return n === null ? null : formatTokens(n);
    }
    case 'elapsed': {
      const s = num(k.startTime);
      return s === null ? null : span(Math.max(0, o.now - s));
    }
  }
}

function build(fields: readonly SubagentField[], k: Obj, o: RowOpts, skip: Set<SubagentField>): string {
  const sep = o.text ? ' | ' : ' · ';
  let out = '';
  let prev: SubagentField | null = null;
  for (const f of fields) {
    if (skip.has(f)) continue;
    const p = part(f, k, o);
    if (!p) continue;
    if (prev) out += sameGroup(prev, f) ? ' ' : sep;
    out += p;
    prev = f;
  }
  return out;
}

export function subagentRow(task: unknown, o: RowOpts): string {
  try {
    if (typeof task !== 'object' || task === null || Array.isArray(task)) return '';
    const k = task as Obj;
    const fields = Array.isArray(o.fields) && o.fields.length ? o.fields : SUBAGENT_FIELDS;
    const cols =
      typeof o.columns === 'number' && Number.isFinite(o.columns) && o.columns >= 10
        ? Math.floor(o.columns)
        : 120;
    const skip = new Set<SubagentField>();
    let row = build(fields, k, o, skip);
    for (const d of DROP) {
      if (visibleWidth(row) <= cols) break;
      skip.add(d);
      row = build(fields, k, o, skip);
    }
    return visibleWidth(row) > cols ? truncate(row, cols) : row;
  } catch {
    return '';
  }
}
