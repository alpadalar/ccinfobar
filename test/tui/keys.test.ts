import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Hit } from '../../src/tui/hits.js';
import { dropTarget } from '../../src/tui/hits.js';
import {
  type InputEvent,
  type Key,
  keyToAction,
  mouseToAction,
  parseInput,
  splitPending,
} from '../../src/tui/keys.js';
import { initialState, reduce, type State } from '../../src/tui/state.js';

const state = (): State => initialState(defaultConfig(), '/tmp/c.json');
const keyOf = (data: string): Key => {
  const ev = parseInput(data)[0] as Extract<InputEvent, { type: 'key' }>;
  return ev.key;
};
const act = (data: string, s = state()) => keyToAction(keyOf(data), s);

describe('parseInput', () => {
  it('parses arrows with modifiers', () => {
    expect(keyOf('\x1b[A')).toMatchObject({ name: 'up', shift: false });
    expect(keyOf('\x1b[1;2C')).toMatchObject({ name: 'right', shift: true, ctrl: false });
    expect(keyOf('\x1b[1;5D')).toMatchObject({ name: 'left', ctrl: true });
    expect(keyOf('\x1bOB')).toMatchObject({ name: 'down' });
  });

  it('parses special keys', () => {
    expect(keyOf('\x1b[3~').name).toBe('delete');
    expect(keyOf('\x1b[5~').name).toBe('pageup');
    expect(keyOf('\x1b[H').name).toBe('home');
    expect(keyOf('\x1b').name).toBe('escape');
    expect(keyOf('\r').name).toBe('return');
    expect(keyOf('\x7f').name).toBe('backspace');
    expect(keyOf('\x1b[Z')).toMatchObject({ name: 'tab', shift: true });
  });

  it('parses ctrl and printable keys', () => {
    expect(keyOf('\x1a')).toMatchObject({ name: 'z', ctrl: true });
    expect(keyOf('D')).toMatchObject({ name: 'd', shift: true, sequence: 'D' });
    expect(keyOf('é').sequence).toBe('é');
  });

  it('splits batched input', () => {
    expect(parseInput('ab\x1b[B').map((e) => (e.type === 'key' ? e.key.name : '?'))).toEqual([
      'a',
      'b',
      'down',
    ]);
  });

  it('parses SGR mouse sequences', () => {
    expect(parseInput('\x1b[<0;12;5M')[0]).toEqual({
      type: 'mouse',
      mouse: { kind: 'down', button: 0, x: 11, y: 4 },
    });
    expect(parseInput('\x1b[<0;12;5m')[0]).toMatchObject({ mouse: { kind: 'up' } });
    expect(parseInput('\x1b[<32;3;4M')[0]).toMatchObject({ mouse: { kind: 'move', x: 2, y: 3 } });
    expect(parseInput('\x1b[<64;1;1M')[0]).toMatchObject({ mouse: { kind: 'wheel', wheel: 'up' } });
    expect(parseInput('\x1b[<65;1;1M')[0]).toMatchObject({ mouse: { kind: 'wheel', wheel: 'down' } });
  });
});

describe('keyToAction in normal mode', () => {
  it('maps navigation', () => {
    expect(act('\x1b[D')).toEqual({ type: 'select', dir: 'left' });
    expect(act('\x1b[B')).toEqual({ type: 'select', dir: 'down' });
  });

  it('maps shift arrows and brackets to moves', () => {
    expect(act('\x1b[1;2C')).toEqual({ type: 'shiftChip', dir: 'right' });
    expect(act('\x1b[1;2D')).toEqual({ type: 'shiftChip', dir: 'left' });
    expect(act('\x1b[1;2A')).toEqual({ type: 'chipLine', dir: 'up' });
    expect(act('\x1b[1;2B')).toEqual({ type: 'chipLine', dir: 'down' });
    expect(act('<')).toEqual({ type: 'shiftChip', dir: 'left' });
    expect(act('>')).toEqual({ type: 'shiftChip', dir: 'right' });
    expect(act('{')).toEqual({ type: 'chipLine', dir: 'up' });
    expect(act('}')).toEqual({ type: 'chipLine', dir: 'down' });
  });

  it('maps commands', () => {
    const table: Record<string, unknown> = {
      a: { type: 'openPicker' },
      '+': { type: 'openPicker' },
      d: { type: 'removeChip' },
      '\x1b[3~': { type: 'removeChip' },
      e: { type: 'openProps' },
      '\r': { type: 'openProps' },
      n: { type: 'newLine' },
      D: { type: 'deleteLine' },
      K: { type: 'moveLine', dir: 'up' },
      J: { type: 'moveLine', dir: 'down' },
      g: { type: 'openGlobal' },
      t: { type: 'openPresets' },
      p: { type: 'togglePreview' },
      u: { type: 'undo' },
      '\x1a': { type: 'undo' },
      U: { type: 'redo' },
      '\x19': { type: 'redo' },
      s: { type: 'save' },
      '\x13': { type: 'save' },
      i: { type: 'install' },
      q: { type: 'quit' },
      '\x1b': { type: 'quit' },
      '?': { type: 'help' },
    };
    for (const [k, v] of Object.entries(table)) expect(act(k), JSON.stringify(k)).toEqual(v);
    expect(act('\x03')).toEqual({ type: 'quit' });
    expect(act('z')).toBeNull();
  });
});

describe('keyToAction in other modes', () => {
  it('types into the picker filter', () => {
    const s = reduce(state(), { type: 'openPicker' });
    expect(act('q', s)).toEqual({ type: 'text', text: 'q' });
    expect(act(' ', s)).toEqual({ type: 'text', text: ' ' });
    expect(act('\x7f', s)).toEqual({ type: 'backspace' });
    expect(act('\x1b[B', s)).toEqual({ type: 'nav', dir: 'down' });
    expect(act('\r', s)).toEqual({ type: 'enter' });
    expect(act('\x1b', s)).toEqual({ type: 'cancel' });
    expect(act('\x03', s)).toEqual({ type: 'forceQuit' });
  });

  it('maps confirm answers', () => {
    const s = reduce(reduce(state(), { type: 'openPresets' }), { type: 'enter' });
    expect(act('y', s)).toEqual({ type: 'confirm', answer: 'yes' });
    expect(act('n', s)).toEqual({ type: 'confirm', answer: 'no' });
    expect(act('x', s)).toBeNull();
  });

  it('cycles select fields with arrows in settings', () => {
    const s = reduce(state(), { type: 'openGlobal' });
    expect(act('\x1b[C', s)).toEqual({ type: 'cycle', delta: 1 });
    expect(act('\x1b[D', s)).toEqual({ type: 'cycle', delta: -1 });
  });
});

describe('mouse', () => {
  const hits: Hit[] = [
    { kind: 'chip', line: 0, index: 0, x: 5, y: 10, w: 8 },
    { kind: 'chip', line: 0, index: 1, x: 14, y: 10, w: 6 },
    { kind: 'line', line: 0, y: 10, count: 2 },
    { kind: 'line', line: 1, y: 11, count: 0 },
  ];
  const mouse = (kind: 'down' | 'up' | 'move' | 'wheel', x: number, y: number) => ({ kind, button: 0, x, y });

  it('presses on a chip to start a drag and releases to drop', () => {
    let s = state();
    const down = mouseToAction(mouse('down', 6, 10), s, hits);
    expect(down).toEqual({ type: 'dragStart', from: { line: 0, index: 0 } });
    s = reduce(s, down!);
    expect(mouseToAction(mouse('move', 18, 10), s, hits)).toEqual({
      type: 'dragOver',
      to: { line: 0, index: 2 },
    });
    expect(mouseToAction(mouse('up', 1, 11), s, hits)).toEqual({
      type: 'dragEnd',
      to: { line: 1, index: 0 },
    });
  });

  it('ignores motion without a drag and clicks empty space', () => {
    expect(mouseToAction(mouse('move', 6, 10), state(), hits)).toBeNull();
    expect(mouseToAction(mouse('down', 30, 10), state(), hits)).toEqual({
      type: 'selectAt',
      line: 0,
      index: 2,
    });
    expect(mouseToAction(mouse('down', 0, 0), state(), hits)).toBeNull();
  });

  it('resolves drop sides of a chip', () => {
    expect(dropTarget(hits, 14, 10)).toEqual({ line: 0, index: 1 });
    expect(dropTarget(hits, 19, 10)).toEqual({ line: 0, index: 2 });
  });

  it('wheel scrolls lists only inside modals', () => {
    const wheel = { kind: 'wheel' as const, button: 1, x: 0, y: 0, wheel: 'down' as const };
    expect(mouseToAction(wheel, state(), [])).toBeNull();
    const s = reduce(state(), { type: 'openPicker' });
    expect(mouseToAction(wheel, s, [])).toEqual({ type: 'nav', dir: 'down' });
  });

  it('clicks list items in modals', () => {
    const s = reduce(state(), { type: 'openPicker' });
    const item: Hit = { kind: 'item', area: 'main', index: 3, x: 0, y: 9, w: 40 };
    expect(mouseToAction(mouse('down', 4, 9), s, [item])).toEqual({
      type: 'clickItem',
      area: 'main',
      index: 3,
    });
  });
});

describe('splitPending', () => {
  it('holds back incomplete escape sequences', () => {
    expect(splitPending('ab\x1b[<0;12')).toEqual(['ab', '\x1b[<0;12']);
    expect(splitPending('\x1b[')).toEqual(['', '\x1b[']);
    expect(splitPending('x\x1b')).toEqual(['x', '\x1b']);
    expect(splitPending('\x1b[A')).toEqual(['\x1b[A', '']);
    expect(splitPending('\x1b[<0;12;5M')).toEqual(['\x1b[<0;12;5M', '']);
    expect(splitPending('plain')).toEqual(['plain', '']);
  });
});
