import { describe, expect, it } from 'vitest';
import { visibleWidth } from '../../src/core/width.js';
import { formatTokens, SUBAGENT_FIELDS, shortModel, span, sparkline } from '../../src/widgets/shared.js';
import { type RowOpts, subagentRow } from '../../src/widgets/subagent-row.js';
import { NOW, withLang } from '../helpers.js';

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  agentType: 'Explore',
  name: 'scout',
  type: 'local_agent',
  status: 'running',
  label: 'Reading src/widgets',
  description: 'd',
  startTime: NOW.getTime() - 3 * 60_000,
  model: 'claude-sonnet-4-5',
  effort: 'high',
  contextWindowSize: 200_000,
  tokenCount: 42_000,
  tokenSamples: [1000, 5000, 12000, 20000, 42000],
  ...over,
});

const opts = (over: Partial<RowOpts> = {}): RowOpts => ({
  columns: 120,
  now: NOW.getTime(),
  fields: SUBAGENT_FIELDS,
  text: false,
  level: 0,
  ...over,
});

const SPARK = sparkline([4000, 7000, 8000, 22000], 8);
const FULL = `▸ Explore · Reading src/widgets · ${SPARK} ${formatTokens(42_000)} 21% · ${shortModel('claude-sonnet-4-5')} high · ${span(180_000)}`;

describe('subagentRow', () => {
  it('formats the full row in default order', () => {
    expect(subagentRow(task(), opts())).toBe(FULL);
  });

  it('falls back for the type', () => {
    expect(subagentRow(task({ agentType: undefined }), opts({ fields: ['type'] }))).toBe('scout');
    expect(subagentRow(task({ agentType: undefined, name: undefined }), opts({ fields: ['type'] }))).toBe(
      'local_agent',
    );
    expect(subagentRow(task({ label: undefined }), opts({ fields: ['label'] }))).toBe('d');
  });

  it('marks each status', () => {
    const m = (status: unknown, text = false) =>
      subagentRow(task({ status }), opts({ fields: ['status'], text }));
    expect([m('running'), m('completed'), m('failed'), m('killed'), m('weird')]).toEqual([
      '▸',
      '✓',
      '✗',
      '■',
      '·',
    ]);
    expect([m('running', true), m('completed', true), m('failed', true), m('killed', true)]).toEqual([
      '>',
      '+',
      'x',
      '-',
    ]);
  });

  it('uses ascii in text mode', () => {
    const row = subagentRow(task(), opts({ text: true }));
    expect(row.startsWith('> Explore | Reading src/widgets | ')).toBe(true);
    expect(row).not.toMatch(/[▁-█·]/);
  });

  it('handles context, effort and missing parts', () => {
    expect(subagentRow(task({ contextWindowSize: 0 }), opts({ fields: ['context'] }))).toBe('');
    expect(subagentRow(task({ contextWindowSize: undefined }), opts({ fields: ['context'] }))).toBe('');
    expect(subagentRow(task({ effort: 2 }), opts({ fields: ['model', 'effort'] }))).toBe('sonnet 2');
    const noEffort = subagentRow(task({ effort: undefined }), opts({ fields: ['model', 'effort'] }));
    expect(noEffort).toBe('sonnet');
    expect(subagentRow(task({ tokenSamples: [5] }), opts({ fields: ['spark'] }))).toBe('');
  });

  it('drops parts to fit the columns', () => {
    const row = subagentRow(task(), opts({ columns: 70 }));
    expect(visibleWidth(row)).toBeLessThanOrEqual(70);
    expect(row).not.toContain(SPARK);
    const narrower = subagentRow(task(), opts({ columns: 55 }));
    expect(narrower).not.toContain('high');
    expect(visibleWidth(narrower)).toBeLessThanOrEqual(55);
    expect(visibleWidth(subagentRow(task(), opts({ columns: 12 })))).toBeLessThanOrEqual(12);
  });

  it('falls back to 120 for bad columns', () => {
    for (const columns of [Number.NaN, 0, -3, '80' as unknown as number]) {
      expect(subagentRow(task(), opts({ columns }))).toBe(FULL);
    }
  });

  it('honours the field order', () => {
    const sep = ' · ';
    expect(subagentRow(task(), opts({ fields: ['status', 'label'] }))).toBe(`▸${sep}Reading src/widgets`);
    expect(subagentRow(task(), opts({ fields: ['label', 'elapsed', 'status'] }))).toBe(
      `Reading src/widgets${sep}${span(180_000)}${sep}▸`,
    );
    expect(subagentRow(task(), opts({ fields: ['type', 'status'] }))).toBe('Explore ▸');
  });

  it('never throws on garbage', () => {
    expect(subagentRow(null, opts())).toBe('');
    expect(subagentRow(42, opts())).toBe('');
    expect(subagentRow({}, opts({ fields: ['label'] }))).toBe('');
    expect(
      subagentRow({ tokenSamples: 'x', tokenCount: 'y', startTime: {}, effort: {} }, opts()).length,
    ).toBeLessThan(10);
    expect(subagentRow(task(), opts({ fields: null as unknown as [] }))).toBe(FULL);
  });

  it('fits to a very narrow pane instead of falling back to 120', () => {
    for (const columns of [1, 5, 9]) {
      const row = subagentRow(task(), opts({ columns }));
      expect(row).not.toBe('');
      expect(visibleWidth(row)).toBeLessThanOrEqual(columns);
    }
    expect(visibleWidth(subagentRow(task(), opts({ columns: 0 })))).toBeGreaterThan(9);
  });

  it('truncates a long label to the columns', () => {
    const row = subagentRow(task({ label: 'x'.repeat(500) }), opts({ columns: 60 }));
    expect(visibleWidth(row)).toBeLessThanOrEqual(60);
  });

  it('has no language dependence', () => {
    expect(withLang('tr', () => subagentRow(task(), opts()))).toBe(
      withLang('en', () => subagentRow(task(), opts())),
    );
  });

  it('colours only the mark', () => {
    const row = subagentRow(task(), opts({ level: 2 }));
    expect(row.startsWith('\x1b[')).toBe(true);
    expect(row.replace(/\x1b\[[0-9;]*m/g, '')).toBe(FULL);
    expect(row.indexOf('\x1b[', 1)).toBeLessThan(10);
  });
});
