import { describe, expect, it } from 'vitest';
import { ruleNeeds } from '../../src/core/conditions.js';

const cfg = (item: Record<string, unknown>) => ({ lines: [[{ type: 'model', ...item }]] });

describe('ruleNeeds', () => {
  it('detects ledger rules', () => {
    const c = cfg({ showWhen: 'cost.today > 5' });
    expect(ruleNeeds(c, 'ledger')).toBe(true);
    expect(ruleNeeds(c, 'limits')).toBe(false);
  });
  it('detects limits rules', () => {
    expect(ruleNeeds(cfg({ hideWhen: 'usage.5h < 50' }), 'limits')).toBe(true);
    expect(ruleNeeds(cfg({ hideWhen: 'usage.7d >= 90' }), 'limits')).toBe(true);
    expect(ruleNeeds(cfg({ showWhen: 'limit-risk' }), 'limits')).toBe(true);
  });
  it('detects hooks rules only for hooks', () => {
    const c = cfg({ showWhen: 'permission.waiting' });
    expect(ruleNeeds(c, 'hooks')).toBe(true);
    expect(ruleNeeds(c, 'ledger')).toBe(false);
  });
  it('is false without or with invalid rules', () => {
    for (const n of ['hooks', 'ledger', 'limits'] as const) {
      expect(ruleNeeds(cfg({}), n)).toBe(false);
      expect(ruleNeeds(cfg({ showWhen: 'cost.today >>' }), n)).toBe(false);
    }
  });
});
