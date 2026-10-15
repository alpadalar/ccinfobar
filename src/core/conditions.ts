import { type MessageId, t } from './i18n/index.js';

export type MetricKind = 'number' | 'flag' | 'string';

export interface MetricSpec {
  name: string;
  kind: MetricKind;
  min?: number;
  max?: number;
  choices?: readonly string[];
  ordered?: boolean;
  label: MessageId;
  needs?: 'hooks';
}

// keep in sync with ProviderKind
const PROVIDERS = [
  'firstParty',
  'apiKey',
  'bedrock',
  'mantle',
  'anthropicAws',
  'vertex',
  'foundry',
  'gateway',
] as const;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const SPECS: MetricSpec[] = [
  { name: 'context.pct', kind: 'number', min: 0, max: 100, label: 'metric.context.pct' },
  { name: 'context.usable', kind: 'number', min: 0, max: 100, label: 'metric.context.usable' },
  { name: 'usage.5h', kind: 'number', min: 0, max: 100, label: 'metric.usage.5h' },
  { name: 'usage.7d', kind: 'number', min: 0, max: 100, label: 'metric.usage.7d' },
  { name: 'cost.session', kind: 'number', label: 'metric.cost.session' },
  { name: 'cost.today', kind: 'number', label: 'metric.cost.today' },
  { name: 'tokens.total', kind: 'number', label: 'metric.tokens.total' },
  { name: 'agents.running', kind: 'number', label: 'metric.agents.running' },
  { name: 'time.hour', kind: 'number', min: 0, max: 23, ordered: true, label: 'metric.time.hour' },
  { name: 'time.weekday', kind: 'string', choices: WEEKDAYS, ordered: true, label: 'metric.time.weekday' },
  { name: 'provider', kind: 'string', choices: PROVIDERS, label: 'metric.provider' },
  { name: 'git', kind: 'flag', label: 'metric.git' },
  { name: 'gsd', kind: 'flag', label: 'metric.gsd' },
  { name: 'agents', kind: 'flag', label: 'metric.agents' },
  { name: 'limit-risk', kind: 'flag', label: 'metric.limit-risk' },
  { name: 'permission.waiting', kind: 'flag', needs: 'hooks', label: 'metric.permission.waiting' },
];

export const METRIC_SPECS: ReadonlyMap<string, MetricSpec> = new Map(SPECS.map((s) => [s.name, s]));

export type Op = '>' | '>=' | '<' | '<=' | '==' | '!=';
const OPS: ReadonlySet<string> = new Set<Op>(['>', '>=', '<', '<=', '==', '!=']);

export type Term =
  | { kind: 'flag'; metric: string; negate: boolean }
  | { kind: 'cmp'; metric: string; op: Op; value: number; band?: number }
  | { kind: 'str'; metric: string; op: '==' | '!='; value: string }
  | { kind: 'range'; metric: string; from: number | string; to: number | string }
  | { kind: 'list'; metric: string; values: string[] };

export type Clause = Term[];
export type Rule = Clause[];

export type RuleErrorCode =
  | 'unknown-metric'
  | 'bad-operator'
  | 'bad-number'
  | 'bad-value'
  | 'syntax'
  | 'too-long';

export interface RuleError {
  code: RuleErrorCode;
  at: number;
  entry: number;
  text: string;
}

export type RuleParse = { ok: true; rule: Rule } | { ok: false; error: RuleError };

export type MetricValue = number | string | boolean | null;

const MAX_LEN = 256;
const MAX_TERMS = 8;
const MAX_ENTRIES = 8;
const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
const WORD = /^[A-Za-z0-9_-]+$/;
const TOKEN = /(\s+)|(\|\|)|([<>=!]+)|(\.\.)|([~,])|([A-Za-z0-9_.-]+)|([\s\S])/uy;

type TokKind = 'or' | 'op' | 'dots' | 'punct' | 'word' | 'junk';

interface Tok {
  kind: TokKind;
  text: string;
  at: number;
}

class Fail extends Error {
  constructor(readonly error: RuleError) {
    super(error.code);
  }
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) break;
    const text = m[0];
    if (m[6] !== undefined && text.includes('..')) {
      // greedy words swallow ranges like 9..18
      let at = i;
      const parts = text.split('..');
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) {
          out.push({ kind: 'dots', text: '..', at });
          at += 2;
        }
        const p = parts[k]!;
        if (p) out.push({ kind: 'word', text: p, at });
        at += p.length;
      }
    } else if (m[1] === undefined) {
      const kind: TokKind =
        m[2] !== undefined
          ? 'or'
          : m[3] !== undefined
            ? 'op'
            : m[4] !== undefined
              ? 'dots'
              : m[5] !== undefined
                ? 'punct'
                : m[6] !== undefined
                  ? 'word'
                  : 'junk';
      out.push({ kind, text, at: i });
    }
    i += text.length;
  }
  return out;
}

function parseEntry(src: string, entry: number): Clause {
  const fail = (code: RuleErrorCode, tok?: Tok): never => {
    throw new Fail({ code, at: tok?.at ?? src.length, entry, text: tok?.text ?? '' });
  };
  if (src.length > MAX_LEN) fail('too-long', { kind: 'junk', text: '', at: MAX_LEN });
  const toks = tokenize(src);
  let i = 0;

  const word = (): Tok => {
    const w = toks[i++];
    if (w?.kind !== 'word') return fail('syntax', w);
    return w;
  };
  const metric = (tok: Tok): MetricSpec => METRIC_SPECS.get(tok.text) ?? fail('unknown-metric', tok);
  const num = (s: MetricSpec, tok: Tok): number => {
    if (!NUMBER.test(tok.text)) return fail('bad-number', tok);
    const n = Number(tok.text) || 0;
    if ((s.min !== undefined && n < s.min) || (s.max !== undefined && n > s.max)) fail('bad-value', tok);
    return n;
  };
  const choice = (s: MetricSpec, tok: Tok): string => {
    if (!WORD.test(tok.text) || (s.choices && !s.choices.includes(tok.text))) fail('bad-value', tok);
    return tok.text;
  };

  const inTerm = (s: MetricSpec): Term => {
    const a = word();
    const dots = toks[i];
    if (dots?.kind === 'dots') {
      i++;
      if (s.kind !== 'number' && !s.ordered) fail('bad-operator', dots);
      const b = word();
      if (s.kind === 'number') {
        const from = num(s, a);
        const to = num(s, b);
        if (from > to && !s.ordered) fail('bad-value', b);
        return { kind: 'range', metric: s.name, from, to };
      }
      return { kind: 'range', metric: s.name, from: choice(s, a), to: choice(s, b) };
    }
    const item = (w: Tok) => (s.kind === 'number' ? String(num(s, w)) : choice(s, w));
    const values = [item(a)];
    while (toks[i]?.kind === 'punct' && toks[i]!.text === ',') {
      i++;
      values.push(item(word()));
    }
    return { kind: 'list', metric: s.name, values };
  };

  const term = (): Term => {
    const first = toks[i++];
    if (!first) return fail('syntax');
    if (first.kind === 'op') {
      if (first.text !== '!') fail('bad-operator', first);
      const s = metric(word());
      if (s.kind !== 'flag') fail('bad-operator', first);
      return { kind: 'flag', metric: s.name, negate: true };
    }
    if (first.kind !== 'word') return fail('syntax', first);
    const s = metric(first);
    const next = toks[i];
    if (!next || next.kind === 'or') {
      if (s.kind === 'flag') return { kind: 'flag', metric: s.name, negate: false };
      return fail('syntax', next);
    }
    if (next.kind === 'word' && next.text === 'in') {
      i++;
      if (s.kind === 'flag') fail('bad-operator', next);
      return inTerm(s);
    }
    if (next.kind !== 'op') return fail('syntax', next);
    i++;
    if (!OPS.has(next.text) || s.kind === 'flag') fail('bad-operator', next);
    const op = next.text as Op;
    if (s.kind === 'string') {
      if (op !== '==' && op !== '!=') fail('bad-operator', next);
      return { kind: 'str', metric: s.name, op: op as '==' | '!=', value: choice(s, word()) };
    }
    const value = num(s, word());
    const tilde = toks[i];
    if (tilde?.kind !== 'punct' || tilde.text !== '~') return { kind: 'cmp', metric: s.name, op, value };
    if (op === '==' || op === '!=') fail('syntax', tilde);
    i++;
    const b = word();
    if (!NUMBER.test(b.text) || Number(b.text) < 0) fail('bad-number', b);
    return { kind: 'cmp', metric: s.name, op, value, band: Number(b.text) || 0 };
  };

  const clause: Clause = [];
  for (;;) {
    if (clause.length === MAX_TERMS) fail('too-long', toks[i]);
    clause.push(term());
    const sep = toks[i];
    if (!sep) return clause;
    if (sep.kind !== 'or') fail('syntax', sep);
    i++;
  }
}

const syntax = (entry: number): RuleParse => ({
  ok: false,
  error: { code: 'syntax', at: 0, entry, text: '' },
});

export function parseRule(src: unknown): RuleParse {
  const entries: unknown[] | null = typeof src === 'string' ? [src] : Array.isArray(src) ? src : null;
  if (!entries) return syntax(0);
  if (entries.length > MAX_ENTRIES) {
    return { ok: false, error: { code: 'too-long', at: 0, entry: MAX_ENTRIES, text: '' } };
  }
  const rule: Rule = [];
  for (let e = 0; e < entries.length; e++) {
    const x = entries[e];
    if (typeof x !== 'string') return syntax(e);
    try {
      rule.push(parseEntry(x, e));
    } catch (f) {
      return f instanceof Fail ? { ok: false, error: f.error } : syntax(e);
    }
  }
  return { ok: true, rule };
}

export function validateRule(src: unknown): RuleError | null {
  const r = parseRule(src);
  return r.ok ? null : r.error;
}

function formatTerm(x: Term): string {
  switch (x.kind) {
    case 'flag':
      return `${x.negate ? '!' : ''}${x.metric}`;
    case 'cmp':
      return `${x.metric} ${x.op} ${x.value}${x.band !== undefined ? ` ~${x.band}` : ''}`;
    case 'str':
      return `${x.metric} ${x.op} ${x.value}`;
    case 'range':
      return `${x.metric} in ${x.from}..${x.to}`;
    case 'list':
      return `${x.metric} in ${x.values.join(',')}`;
  }
}

export function formatClause(c: Clause): string {
  return c.map(formatTerm).join(' || ');
}

export function formatRule(rule: Rule): string | string[] {
  const out = rule.map(formatClause);
  return out.length === 1 ? out[0]! : out;
}

type Get = (metric: string) => MetricValue;
type Prev = (metric: string) => number | null;

function compare(v: number, op: Op, th: number): boolean {
  switch (op) {
    case '>':
      return v > th;
    case '>=':
      return v >= th;
    case '<':
      return v < th;
    case '<=':
      return v <= th;
    case '==':
      return v === th;
    case '!=':
      return v !== th;
  }
}

function termOn(x: Term, v: MetricValue, prev?: Prev): boolean {
  switch (x.kind) {
    case 'flag':
      return x.negate ? !v : !!v;
    case 'cmp': {
      if (typeof v !== 'number' || Number.isNaN(v)) return false;
      if (compare(v, x.op, x.value)) return true;
      if (x.band === undefined || !prev) return false;
      const p = prev(x.metric);
      if (typeof p !== 'number' || !compare(p, x.op, x.value)) return false;
      return x.op === '>' || x.op === '>=' ? v >= x.value - x.band : v <= x.value + x.band;
    }
    case 'str':
      if (typeof v !== 'string') return false;
      return x.op === '==' ? v === x.value : v !== x.value;
    case 'range': {
      let at: number;
      let a: number;
      let b: number;
      if (typeof x.from === 'number' && typeof x.to === 'number') {
        if (typeof v !== 'number') return false;
        [at, a, b] = [v, x.from, x.to];
      } else {
        const ch = METRIC_SPECS.get(x.metric)?.choices;
        if (typeof v !== 'string' || !ch) return false;
        [at, a, b] = [ch.indexOf(v), ch.indexOf(String(x.from)), ch.indexOf(String(x.to))];
        if (at < 0 || a < 0 || b < 0) return false;
      }
      return a <= b ? at >= a && at <= b : at >= a || at <= b;
    }
    case 'list':
      if (typeof v === 'number') return x.values.some((s) => Number(s) === v);
      return typeof v === 'string' && METRIC_SPECS.get(x.metric)?.kind === 'string' && x.values.includes(v);
  }
}

function hit(c: Clause, get: Get, prev?: Prev): number {
  return c.findIndex((x) => termOn(x, get(x.metric), prev));
}

export function evaluate(rule: Rule, get: Get, prev?: Prev): boolean {
  return rule.every((c) => hit(c, get, prev) >= 0);
}

type RuleSource = { type?: string; showWhen?: unknown; hideWhen?: unknown };

export interface ItemRules {
  show: RuleParse | null;
  hide: RuleParse | null;
}

const memo = new WeakMap<object, { show: unknown; hide: unknown; rules: ItemRules }>();

export function itemRules(item: RuleSource): ItemRules {
  const m = memo.get(item);
  if (m && m.show === item.showWhen && m.hide === item.hideWhen) return m.rules;
  const rules: ItemRules = {
    show: item.showWhen === undefined ? null : parseRule(item.showWhen),
    hide: item.hideWhen === undefined ? null : parseRule(item.hideWhen),
  };
  memo.set(item, { show: item.showWhen, hide: item.hideWhen, rules });
  return rules;
}

export type RuleKey = 'showWhen' | 'hideWhen';

export interface Visibility {
  visible: boolean;
  decided?: { key: RuleKey; clause: string; metric: string; value: MetricValue };
  invalid?: { key: RuleKey; error: RuleError };
}

export function itemVisible(item: RuleSource, get: Get, prev?: Prev): Visibility {
  const { show, hide } = itemRules(item);
  const out: Visibility = { visible: true };
  if (!show && !hide) return out;
  if (show && !show.ok) out.invalid = { key: 'showWhen', error: show.error };
  else if (hide && !hide.ok) out.invalid = { key: 'hideWhen', error: hide.error };
  if (show?.ok) {
    for (const c of show.rule) {
      if (hit(c, get, prev) >= 0) continue;
      const m = c[0]!.metric;
      out.visible = false;
      out.decided = { key: 'showWhen', clause: formatClause(c), metric: m, value: get(m) };
      return out;
    }
  }
  if (hide?.ok && hide.rule.length > 0) {
    let decided: Visibility['decided'];
    for (const c of hide.rule) {
      const k = hit(c, get, prev);
      if (k < 0) return out;
      if (!decided) {
        const m = c[k]!.metric;
        decided = { key: 'hideWhen', clause: formatClause(c), metric: m, value: get(m) };
      }
    }
    out.visible = false;
    out.decided = decided;
  }
  return out;
}

export function ruleMetrics(item: RuleSource): Set<string> {
  const out = new Set<string>();
  const { show, hide } = itemRules(item);
  for (const r of [show, hide]) {
    if (!r?.ok) continue;
    for (const c of r.rule) for (const x of c) out.add(x.metric);
  }
  return out;
}

export function describeRuleError(e: RuleError): string {
  return t(`rule.error.${e.code}`, { at: e.at + 1, text: e.text });
}
