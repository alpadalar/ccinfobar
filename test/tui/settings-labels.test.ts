import { describe, expect, it } from 'vitest';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { widgetText } from '../../src/core/i18n/widget-text.js';
import type { Config } from '../../src/core/types.js';
import { type Action, initialState, reduce, type State, settingsFields } from '../../src/tui/state.js';
import { renderScreen } from '../../src/tui/view.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const build = (config: Config, ...actions: Action[]): State =>
  actions.reduce(reduce, initialState(config, '/tmp/cc/config.json'));
const one = (type: string): Config => ({ ...defaultConfig(), lines: [[{ id: 'a', type }]] });
const shown = ALL_WIDGETS.filter((d) => !d.hidden);

function states(): State[] {
  const out = [
    build(defaultConfig(), { type: 'openGlobal' }),
    build(defaultConfig(), { type: 'openGlobal' }, { type: 'enter' }),
  ];
  for (const d of shown) {
    out.push(build(one(d.type), { type: 'openProps' }));
    out.push(build(one(d.type), { type: 'openProps' }, { type: 'enter' }));
  }
  return out;
}

describe.each(['en', 'tr'] as const)('TUI settings labels (%s)', (lang) => {
  it('never cuts a field label at 80 columns', () => {
    withLang(lang, () => {
      for (const s of states()) {
        const rows = stripAnsi(renderScreen(s, 80, 120).lines.join('\n'));
        for (const f of settingsFields(s)) expect(rows, f.label).toContain(f.label);
      }
    });
  });

  it('stays inside 60x20 and 80x24', () => {
    withLang(lang, () => {
      for (const s of states()) {
        for (const [cols, h] of [
          [60, 20],
          [80, 24],
        ] as const) {
          for (const l of renderScreen(s, cols, h).lines) expect(visibleWidth(l)).toBeLessThanOrEqual(cols);
        }
      }
    });
  });

  it('shows whole widget names in the picker at 80 columns', () => {
    withLang(lang, () => {
      for (const d of shown) expect(visibleWidth(widgetText(d, 'name')), d.type).toBeLessThanOrEqual(24);
    });
  });
});

it('keeps the three Turkish visibility rows apart', () => {
  withLang('tr', () => {
    const s = build(one('model'), { type: 'openProps' });
    const vis = settingsFields(s).filter((f) => f.id.startsWith('vis.'));
    expect(vis).toHaveLength(3);
    expect(new Set(vis.map((f) => f.label)).size).toBe(3);
    const rows = stripAnsi(renderScreen(s, 80, 120).lines.join('\n'));
    for (const f of vis) expect(rows).toContain(f.label);
  });
});
