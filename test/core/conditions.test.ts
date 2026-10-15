import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeRuleError,
  evaluate,
  formatRule,
  itemRules,
  itemVisible,
  METRIC_SPECS,
  type MetricValue,
  parseRule,
  type Rule,
  ruleMetrics,
  validateRule,
} from '../../src/core/conditions.js';

const rule = (src: unknown): Rule => {
  const r = parseRule(src);
  if (!r.ok) throw new Error(`${r.error.code} at ${r.error.at}: ${r.error.text}`);
  return r.rule;
};

const getter =
  (values: Record<string, MetricValue>) =>
  (m: string): MetricValue =>
    Object.hasOwn(values, m) ? values[m]! : null;

const VALID: [unknown, string | string[]][] = [
  ['context.pct >= 70', 'context.pct >= 70'],
  [['!git'], '!git'],
  [
    ['provider != firstParty', 'time.hour in 9..18'],
    ['provider != firstParty', 'time.hour in 9..18'],
  ],
  ['usage.5h >= 80 || usage.7d >= 90', 'usage.5h >= 80 || usage.7d >= 90'],
  ['context.pct>=70', 'context.pct >= 70'],
  ['usage.5h >= 80 ~5', 'usage.5h >= 80 ~5'],
  ['usage.5h>=80~5', 'usage.5h >= 80 ~5'],
  ['time.hour in 22..6', 'time.hour in 22..6'],
  ['time.weekday in mon..fri', 'time.weekday in mon..fri'],
  ['time.weekday in sat,sun', 'time.weekday in sat,sun'],
  ['time.weekday in sat , sun', 'time.weekday in sat,sun'],
  ['provider in bedrock,vertex', 'provider in bedrock,vertex'],
  ['limit-risk', 'limit-risk'],
  ['!agents', '!agents'],
  ['agents.running > 0', 'agents.running > 0'],
  ['  git  ||   gsd ', 'git || gsd'],
  ['git||gsd', 'git || gsd'],
  ['cost.session > 1.50', 'cost.session > 1.5'],
  ['cost.today < -0', 'cost.today < 0'],
  ['time.weekday == sat', 'time.weekday == sat'],
  ['time.hour in 9 .. 18', 'time.hour in 9..18'],
  ['time.hour in 9,12,18', 'time.hour in 9,12,18'],
  ['permission.waiting', 'permission.waiting'],
  [['git'], 'git'],
  [
    ['git', 'gsd || !agents'],
    ['git', 'gsd || !agents'],
  ],
];

const INVALID: [string, unknown, string, string?][] = [
  ['unknown metric', 'contxt.pct > 5', 'unknown-metric', 'contxt.pct'],
  ['unknown negated metric', '!gti', 'unknown-metric', 'gti'],
  ['prototype key', '__proto__', 'unknown-metric', '__proto__'],
  ['constructor key', 'constructor', 'unknown-metric', 'constructor'],
  ['reversed operator', 'context.pct => 5', 'bad-operator', '=>'],
  ['single equals', 'context.pct = 5', 'bad-operator', '='],
  ['flag with operator', 'git >= 3', 'bad-operator', '>='],
  ['negated number metric', '!context.pct', 'bad-operator', '!'],
  ['string metric ordering', 'provider > bedrock', 'bad-operator', '>'],
  ['range on unordered string', 'provider in bedrock..vertex', 'bad-operator', '..'],
  ['flag with in', 'git in a,b', 'bad-operator', 'in'],
  ['not a number', 'context.pct > abc', 'bad-number', 'abc'],
  ['trailing dot', 'context.pct > 5.', 'bad-number', '5.'],
  ['bad band', 'usage.5h >= 80 ~x', 'bad-number', 'x'],
  ['negative band', 'usage.5h >= 80 ~-5', 'bad-number', '-5'],
  ['bad range number', 'time.hour in a..6', 'bad-number', 'a'],
  ['unknown provider', 'provider == mars', 'bad-value', 'mars'],
  ['unknown weekday', 'time.weekday in sat,funday', 'bad-value', 'funday'],
  ['out of range', 'context.pct > 150', 'bad-value', '150'],
  ['hour out of range', 'time.hour in 9..24', 'bad-value', '24'],
  ['empty range', 'context.pct in 80..20', 'bad-value', '20'],
  ['open range', 'time.hour in 9..', 'syntax'],
  ['missing value', 'context.pct >', 'syntax'],
  ['missing operator', 'context.pct', 'syntax'],
  ['dangling or', 'git ||', 'syntax'],
  ['leading or', '|| git', 'syntax'],
  ['single pipe', 'git | gsd', 'syntax', '|'],
  ['trailing word', 'git gsd', 'syntax', 'gsd'],
  ['band on equality', 'context.pct == 5 ~2', 'syntax', '~'],
  ['parentheses', '(git)', 'syntax', '('],
  ['empty', '', 'syntax'],
  ['blank', '   ', 'syntax'],
  ['number instead of rule', 5, 'syntax'],
  ['number in array', ['git', 5], 'syntax'],
  ['object', { a: 1 }, 'syntax'],
  ['too long', `context.pct >= 70 ${'x'.repeat(300)}`, 'too-long'],
  ['nine terms', Array(9).fill('git').join(' || '), 'too-long'],
  ['nine entries', Array(9).fill('git'), 'too-long'],
];

describe('parseRule', () => {
  it.each(VALID)('parses %j', (src, canonical) => {
    expect(formatRule(rule(src))).toEqual(canonical);
  });

  it.each(VALID)('formats %j idempotently', (src) => {
    const once = formatRule(rule(src));
    expect(formatRule(rule(once))).toEqual(once);
  });

  it.each(INVALID)('rejects %s', (_name, src, code, text) => {
    const r = parseRule(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(code);
    if (text !== undefined) expect(r.error.text).toBe(text);
    expect(typeof r.error.at).toBe('number');
    expect(validateRule(src)).toEqual(r.error);
  });

  it('builds the expected terms', () => {
    expect(rule('usage.5h >= 80 ~5 || !git')).toEqual([
      [
        { kind: 'cmp', metric: 'usage.5h', op: '>=', value: 80, band: 5 },
        { kind: 'flag', metric: 'git', negate: true },
      ],
    ]);
    expect(rule(['time.hour in 22..6', 'time.weekday in sat,sun', 'provider != vertex'])).toEqual([
      [{ kind: 'range', metric: 'time.hour', from: 22, to: 6 }],
      [{ kind: 'list', metric: 'time.weekday', values: ['sat', 'sun'] }],
      [{ kind: 'str', metric: 'provider', op: '!=', value: 'vertex' }],
    ]);
  });

  it('reports positions and entries', () => {
    const r = parseRule(['git', 'context.pct => 5']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ code: 'bad-operator', at: 12, entry: 1, text: '=>' });
    const u = parseRule('git || contxt.pct > 5');
    expect(!u.ok && u.error.at).toBe(7);
  });

  it('accepts exactly 8 terms, 8 entries and 256 characters', () => {
    expect(validateRule(Array(8).fill('git').join(' || '))).toBeNull();
    expect(validateRule(Array(8).fill('git'))).toBeNull();
    expect(validateRule(`context.pct >= 70${' '.repeat(256 - 17)}`)).toBeNull();
    expect(validateRule(`context.pct >= 70${' '.repeat(257 - 17)}`)?.code).toBe('too-long');
  });

  it('lists the metrics in catalog order', () => {
    expect([...METRIC_SPECS.keys()]).toEqual([
      'context.pct',
      'context.usable',
      'usage.5h',
      'usage.7d',
      'cost.session',
      'cost.today',
      'tokens.total',
      'agents.running',
      'time.hour',
      'time.weekday',
      'provider',
      'git',
      'gsd',
      'agents',
      'limit-risk',
      'permission.waiting',
    ]);
    expect(METRIC_SPECS.get('provider')?.choices).toContain('firstParty');
    expect(METRIC_SPECS.get('permission.waiting')?.needs).toBe('hooks');
    expect(METRIC_SPECS.has('__proto__')).toBe(false);
  });
});

describe('describeRuleError', () => {
  it('names the error', () => {
    const r = parseRule('contxt.pct > 5');
    expect(!r.ok && describeRuleError(r.error)).toContain('contxt.pct');
    const s = parseRule('time.hour in 9..');
    expect(!s.ok && describeRuleError(s.error)).toMatch(/\d/);
  });
});

describe('evaluate', () => {
  it('compares numbers', () => {
    expect(evaluate(rule('context.pct >= 70'), getter({ 'context.pct': 72 }))).toBe(true);
    expect(evaluate(rule('context.pct >= 70'), getter({ 'context.pct': 69 }))).toBe(false);
    expect(evaluate(rule('context.pct == 70'), getter({ 'context.pct': 70 }))).toBe(true);
    expect(evaluate(rule('context.pct != 70'), getter({ 'context.pct': 71 }))).toBe(true);
    expect(evaluate(rule('context.pct < 70'), getter({ 'context.pct': 71 }))).toBe(false);
  });

  it.each(['>', '>=', '<', '<=', '==', '!='])('treats null as false for %s', (op) => {
    expect(evaluate(rule(`context.pct ${op} 50`), getter({}))).toBe(false);
  });

  it('treats null as absent for flags', () => {
    expect(evaluate(rule('!git'), getter({}))).toBe(true);
    expect(evaluate(rule('git'), getter({}))).toBe(false);
    expect(evaluate(rule('git'), getter({ git: true }))).toBe(true);
    expect(evaluate(rule('!git'), getter({ git: true }))).toBe(false);
  });

  it('wraps hours past midnight', () => {
    const r = rule('time.hour in 22..6');
    expect(evaluate(r, getter({ 'time.hour': 23 }))).toBe(true);
    expect(evaluate(r, getter({ 'time.hour': 3 }))).toBe(true);
    expect(evaluate(r, getter({ 'time.hour': 22 }))).toBe(true);
    expect(evaluate(r, getter({ 'time.hour': 6 }))).toBe(true);
    expect(evaluate(r, getter({ 'time.hour': 12 }))).toBe(false);
    expect(evaluate(rule('time.hour in 9..18'), getter({ 'time.hour': 12 }))).toBe(true);
    expect(evaluate(rule('time.hour in 9..18'), getter({ 'time.hour': 19 }))).toBe(false);
  });

  it('orders weekdays', () => {
    expect(evaluate(rule('time.weekday in mon..fri'), getter({ 'time.weekday': 'sat' }))).toBe(false);
    expect(evaluate(rule('time.weekday in mon..fri'), getter({ 'time.weekday': 'wed' }))).toBe(true);
    expect(evaluate(rule('time.weekday in fri..mon'), getter({ 'time.weekday': 'sun' }))).toBe(true);
    expect(evaluate(rule('time.weekday in fri..mon'), getter({ 'time.weekday': 'tue' }))).toBe(false);
  });

  it('checks list membership', () => {
    const r = rule('provider in bedrock,vertex');
    expect(evaluate(r, getter({ provider: 'vertex' }))).toBe(true);
    expect(evaluate(r, getter({ provider: 'firstParty' }))).toBe(false);
    expect(evaluate(r, getter({}))).toBe(false);
    expect(evaluate(rule('time.hour in 9,12'), getter({ 'time.hour': 12 }))).toBe(true);
    expect(evaluate(rule('time.hour in 9,12'), getter({ 'time.hour': 10 }))).toBe(false);
  });

  it('compares strings and treats null as false', () => {
    expect(evaluate(rule('provider != firstParty'), getter({ provider: 'bedrock' }))).toBe(true);
    expect(evaluate(rule('provider != firstParty'), getter({ provider: 'firstParty' }))).toBe(false);
    expect(evaluate(rule('provider != firstParty'), getter({}))).toBe(false);
    expect(evaluate(rule('provider == bedrock'), getter({}))).toBe(false);
  });

  it('ANDs entries and ORs terms', () => {
    const r = rule(['git', 'usage.5h >= 80 || usage.7d >= 90']);
    expect(evaluate(r, getter({ git: true, 'usage.5h': 10, 'usage.7d': 95 }))).toBe(true);
    expect(evaluate(r, getter({ git: true, 'usage.5h': 10, 'usage.7d': 50 }))).toBe(false);
    expect(evaluate(r, getter({ 'usage.5h': 90 }))).toBe(false);
  });

  it('keeps a banded term on while the previous value was on', () => {
    const r = rule('usage.5h >= 80 ~5');
    const at = (v: number, p: number | null) =>
      evaluate(r, getter({ 'usage.5h': v }), (m) => (m === 'usage.5h' ? p : null));
    expect(at(77, 82)).toBe(true);
    expect(at(77, 78)).toBe(false);
    expect(at(77, null)).toBe(false);
    expect(at(74, 90)).toBe(false);
    expect(at(81, null)).toBe(true);
    expect(evaluate(r, getter({ 'usage.5h': 77 }))).toBe(false);
  });

  it('bands downward comparisons upward', () => {
    const r = rule('context.pct <= 20 ~5');
    const at = (v: number, p: number | null) => evaluate(r, getter({ 'context.pct': v }), () => p);
    expect(at(23, 18)).toBe(true);
    expect(at(26, 18)).toBe(false);
    expect(at(23, 22)).toBe(false);
  });
});

describe('itemVisible', () => {
  const get = getter({ 'context.pct': 40, git: true });

  it('shows items without rules', () => {
    expect(itemVisible({ type: 'model' }, get)).toEqual({ visible: true });
  });

  it('hides when showWhen fails', () => {
    const v = itemVisible({ type: 'model', showWhen: 'context.pct >= 70' }, get);
    expect(v.visible).toBe(false);
    expect(v.decided).toEqual({
      key: 'showWhen',
      clause: 'context.pct >= 70',
      metric: 'context.pct',
      value: 40,
    });
  });

  it('hides when hideWhen holds', () => {
    const v = itemVisible({ type: 'model', hideWhen: ['git'] }, get);
    expect(v.visible).toBe(false);
    expect(v.decided?.key).toBe('hideWhen');
    expect(v.decided?.metric).toBe('git');
    expect(v.decided?.value).toBe(true);
  });

  it('shows when showWhen holds and hideWhen does not', () => {
    const v = itemVisible({ type: 'model', showWhen: 'git', hideWhen: 'context.pct > 90' }, get);
    expect(v).toEqual({ visible: true });
  });

  it('fails open on an invalid showWhen', () => {
    const v = itemVisible({ type: 'model', showWhen: 'contxt.pct > 5' }, get);
    expect(v.visible).toBe(true);
    expect(v.invalid?.key).toBe('showWhen');
    expect(v.invalid?.error.code).toBe('unknown-metric');
  });

  it('follows a valid showWhen when hideWhen is invalid', () => {
    const hidden = itemVisible({ type: 'model', showWhen: 'context.pct > 50', hideWhen: 'git >= 1' }, get);
    expect(hidden.visible).toBe(false);
    expect(hidden.decided?.key).toBe('showWhen');
    expect(hidden.invalid?.key).toBe('hideWhen');
    const shown = itemVisible({ type: 'model', showWhen: 'context.pct > 10', hideWhen: 'git >= 1' }, get);
    expect(shown.visible).toBe(true);
    expect(shown.invalid?.error.code).toBe('bad-operator');
  });

  it('treats an empty array as no rule', () => {
    expect(itemVisible({ type: 'model', showWhen: [], hideWhen: [] }, get).visible).toBe(true);
  });

  it('passes prev through for bands', () => {
    const item = { type: 'model', showWhen: 'context.pct >= 42 ~5' };
    expect(itemVisible(item, get).visible).toBe(false);
    expect(itemVisible(item, get, () => 45).visible).toBe(true);
  });
});

describe('itemRules', () => {
  it('memoizes per item', () => {
    const item = { type: 'model', showWhen: 'git', hideWhen: ['context.pct > 5'] };
    const a = itemRules(item);
    expect(itemRules(item)).toBe(a);
    expect(a.show?.ok).toBe(true);
    expect(a.hide?.ok).toBe(true);
    expect(itemRules({ type: 'model' })).toEqual({ show: null, hide: null });
  });

  it('re-parses when a rule changes', () => {
    const item: { type: string; showWhen: string } = { type: 'model', showWhen: 'git' };
    const a = itemRules(item);
    item.showWhen = 'contxt';
    expect(itemRules(item)).not.toBe(a);
    expect(itemRules(item).show?.ok).toBe(false);
  });
});

describe('ruleMetrics', () => {
  it('lists the metrics of valid rules', () => {
    expect(ruleMetrics({ type: 'x', showWhen: ['time.hour in 9..18', 'git'] })).toEqual(
      new Set(['time.hour', 'git']),
    );
    expect(ruleMetrics({ type: 'x', showWhen: 'contxt > 1', hideWhen: 'usage.5h > 1 || !gsd' })).toEqual(
      new Set(['usage.5h', 'gsd']),
    );
    expect(ruleMetrics({ type: 'x' }).size).toBe(0);
  });
});

describe('conditions source', () => {
  it('has no dynamic code', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/conditions.ts'), 'utf8');
    expect(src).not.toContain('eval(');
    expect(src).not.toContain('new Function');
  });
});
