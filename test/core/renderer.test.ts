import { describe, expect, it } from 'vitest';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { finalizeLine, render } from '../../src/core/renderer.js';
import type { WidgetItem } from '../../src/core/types.js';
import { ctxWith } from '../helpers.js';

const text = (t: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({
  id: t,
  type: 'text',
  options: { text: t },
  ...extra,
});

describe('renderer', () => {
  it('joins widgets with the separator and skips empty lines', () => {
    const ctx = ctxWith({ config: { lines: [[text('a'), text('b')], [], [{ id: 'x', type: 'unknown' }]] } });
    expect(render(ctx)).toEqual(['a │ b']);
  });

  it('merges widgets without separator', () => {
    const ctx = ctxWith({ config: { lines: [[text('a', { merge: true }), text('b'), text('c')]] } });
    expect(render(ctx)).toEqual(['ab │ c']);
  });

  it('applies labels, raw and custom labels', () => {
    const ctx = ctxWith({
      config: {
        lines: [
          [
            { id: 'm', type: 'model', label: 'M: ' },
            { id: 'n', type: 'model', raw: true },
          ],
        ],
      },
    });
    expect(render(ctx)).toEqual(['M: Opus 5.5 │ Opus 5.5']);
  });

  it('pushes widgets right with flex', () => {
    const ctx = ctxWith({
      width: 30,
      config: { widthOffset: 0, lines: [[text('left'), { id: 'f', type: 'flex' }, text('right')]] },
    });
    const [line] = render(ctx);
    expect(visibleWidth(line!)).toBe(30);
    expect(line!.startsWith('left')).toBe(true);
    expect(line!.endsWith('right')).toBe(true);
  });

  it('truncates to the available width', () => {
    const ctx = ctxWith({
      width: 20,
      config: { widthOffset: 0, lines: [[text('abcdefghijklmn'), text('opqrstuv')]] },
    });
    expect(stripAnsi(render(ctx)[0]!)).toBe('abcdefghijklmn │ op…');
  });

  it('renders powerline segments with theme colors', () => {
    const ctx = ctxWith({
      config: {
        colorLevel: 2,
        theme: 'powerline',
        glyphs: { separator: '>', endCap: '>' },
        lines: [[text('a'), text('b')]],
      },
    });
    const line = render(ctx)[0]!;
    expect(stripAnsi(line)).toBe(' a > b >');
    expect(line).toContain('\x1b[44m');
  });

  it('shows a placeholder for widgets without data unless hideEmpty is set', () => {
    const ctx = ctxWith({
      payload: {},
      config: {
        lines: [
          [{ id: 'm', type: 'model' }, { id: 'c', type: 'context-percentage' }, text('ok')],
          [{ id: 'm2', type: 'model', hideEmpty: true }, text('ok')],
          [{ id: 'g', type: 'git-branch', hideEmpty: true }],
        ],
      },
      git: () => null,
    });
    expect(render(ctx)).toEqual(['model — │ Ctx — │ ok', 'ok']);
  });

  it('finalizes with reset and non-breaking spaces', () => {
    expect(finalizeLine('a b')).toBe('\x1b[0ma b');
  });
});
