import type { Action, State } from './state.js';
import { chipAt, dropTarget, type Hit, itemAt } from './hits.js';

export interface Key {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export interface MouseEvent {
  kind: 'down' | 'up' | 'move' | 'wheel';
  button: number;
  x: number;
  y: number;
  wheel?: 'up' | 'down';
}

export type InputEvent = { type: 'key'; key: Key } | { type: 'mouse'; mouse: MouseEvent };

const key = (name: string, sequence: string, mods: Partial<Key> = {}): InputEvent => ({
  type: 'key',
  key: { name, sequence, ctrl: false, meta: false, shift: false, ...mods },
});

const CSI_FINAL: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};

const CSI_TILDE: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

function modifiers(param: string | undefined): Partial<Key> {
  const m = Math.max(0, Number(param ?? 1) - 1);
  return { shift: (m & 1) !== 0, meta: (m & 2) !== 0, ctrl: (m & 4) !== 0 };
}

const MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const CSI_RE = /^\x1b\[([0-9;?]*)([A-Za-z~])/;

function parseMouse(m: RegExpExecArray): InputEvent {
  const code = Number(m[1]);
  const base = {
    button: code & 3,
    x: Number(m[2]) - 1,
    y: Number(m[3]) - 1,
  };
  if (code & 64) {
    return { type: 'mouse', mouse: { ...base, kind: 'wheel', wheel: (code & 1) === 0 ? 'up' : 'down' } };
  }
  if (m[4] === 'm') return { type: 'mouse', mouse: { ...base, kind: 'up' } };
  return { type: 'mouse', mouse: { ...base, kind: code & 32 ? 'move' : 'down' } };
}

export function parseInput(data: string): InputEvent[] {
  const out: InputEvent[] = [];
  let s = data;
  while (s.length) {
    const mouse = MOUSE_RE.exec(s);
    if (mouse) {
      out.push(parseMouse(mouse));
      s = s.slice(mouse[0].length);
      continue;
    }
    if (s[0] === '\x1b') {
      if (s.length === 1) {
        out.push(key('escape', s));
        break;
      }
      const csi = CSI_RE.exec(s);
      if (csi) {
        const [seq, params = '', final = ''] = csi;
        const parts = params.split(';');
        let name: string | undefined;
        if (final === '~') name = CSI_TILDE[parts[0] ?? ''];
        else if (final === 'Z') {
          out.push(key('tab', seq, { shift: true }));
          s = s.slice(seq.length);
          continue;
        } else name = CSI_FINAL[final];
        if (name) out.push(key(name, seq, modifiers(parts[1])));
        s = s.slice(seq.length);
        continue;
      }
      if (s[1] === 'O' && s.length >= 3) {
        const name = CSI_FINAL[s[2]!];
        if (name) out.push(key(name, s.slice(0, 3)));
        s = s.slice(3);
        continue;
      }
      if (s[1] === '[') {
        s = s.slice(2);
        continue;
      }
      const rest = parseInput(s.slice(1));
      const first = rest[0];
      if (first?.type === 'key') {
        out.push({ type: 'key', key: { ...first.key, meta: true, sequence: `\x1b${first.key.sequence}` } });
        out.push(...rest.slice(1));
      } else out.push(...rest);
      break;
    }
    const ch = String.fromCodePoint(s.codePointAt(0)!);
    s = s.slice(ch.length);
    if (ch === '\r' || ch === '\n') out.push(key('return', ch));
    else if (ch === '\t') out.push(key('tab', ch));
    else if (ch === '\x7f' || ch === '\b') out.push(key('backspace', ch));
    else if (ch === ' ') out.push(key('space', ch));
    else if (ch < ' ') {
      const code = ch.charCodeAt(0);
      if (code >= 1 && code <= 26) out.push(key(String.fromCharCode(code + 96), ch, { ctrl: true }));
    } else {
      const lower = ch.toLowerCase();
      out.push(key(lower, ch, { shift: lower !== ch }));
    }
  }
  return out;
}

const isPrintable = (k: Key) => !k.ctrl && !k.meta && k.sequence.length > 0 && k.sequence >= ' ' && k.sequence[0] !== '\x1b' && k.sequence !== '\x7f';

const NAV_KEYS = ['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown'] as const;

function normalKey(k: Key): Action | null {
  if (k.ctrl) {
    switch (k.name) {
      case 'z':
        return { type: 'undo' };
      case 'y':
        return { type: 'redo' };
      case 's':
        return { type: 'save' };
      default:
        return null;
    }
  }
  if (k.shift && (k.name === 'left' || k.name === 'right')) return { type: 'shiftChip', dir: k.name };
  if (k.shift && (k.name === 'up' || k.name === 'down')) return { type: 'chipLine', dir: k.name };
  if ((NAV_KEYS as readonly string[]).includes(k.name) && !k.meta) {
    return { type: 'select', dir: k.name as (typeof NAV_KEYS)[number] };
  }
  switch (k.name) {
    case 'return':
      return { type: 'openProps' };
    case 'delete':
      return { type: 'removeChip' };
    case 'escape':
      return { type: 'quit' };
    default:
  }
  if (!isPrintable(k)) return null;
  switch (k.sequence) {
    case '<':
      return { type: 'shiftChip', dir: 'left' };
    case '>':
      return { type: 'shiftChip', dir: 'right' };
    case '{':
      return { type: 'chipLine', dir: 'up' };
    case '}':
      return { type: 'chipLine', dir: 'down' };
    case 'a':
    case '+':
      return { type: 'openPicker' };
    case 'd':
    case 'x':
      return { type: 'removeChip' };
    case 'e':
      return { type: 'openProps' };
    case 'n':
      return { type: 'newLine' };
    case 'D':
      return { type: 'deleteLine' };
    case 'K':
      return { type: 'moveLine', dir: 'up' };
    case 'J':
      return { type: 'moveLine', dir: 'down' };
    case 'g':
      return { type: 'openGlobal' };
    case 't':
      return { type: 'openPresets' };
    case 'p':
      return { type: 'togglePreview' };
    case 'u':
      return { type: 'undo' };
    case 'U':
      return { type: 'redo' };
    case 's':
      return { type: 'save' };
    case 'i':
      return { type: 'install' };
    case 'q':
      return { type: 'quit' };
    case '?':
      return { type: 'help' };
    case 'h':
      return { type: 'select', dir: 'left' };
    case 'l':
      return { type: 'select', dir: 'right' };
    case 'k':
      return { type: 'select', dir: 'up' };
    case 'j':
      return { type: 'select', dir: 'down' };
    default:
      return null;
  }
}

function listKey(k: Key): Action | null {
  if ((NAV_KEYS as readonly string[]).includes(k.name)) return { type: 'nav', dir: k.name as (typeof NAV_KEYS)[number] };
  if (k.name === 'return') return { type: 'enter' };
  if (k.name === 'escape') return { type: 'cancel' };
  return null;
}

function textKey(k: Key): Action | null {
  if (k.ctrl) {
    if (k.name === 'u') return { type: 'clear' };
    if (k.name === 'a') return { type: 'nav', dir: 'home' };
    if (k.name === 'e') return { type: 'nav', dir: 'end' };
    return null;
  }
  if (k.name === 'backspace') return { type: 'backspace' };
  if (k.name === 'delete') return { type: 'delete' };
  if (k.name === 'space') return { type: 'text', text: ' ' };
  const nav = listKey(k);
  if (nav) return nav;
  return isPrintable(k) ? { type: 'text', text: k.sequence } : null;
}

function confirmKey(k: Key, what: string): Action | null {
  if (k.name === 'escape') return { type: 'cancel' };
  const c = k.sequence.toLowerCase();
  if (what === 'quit') {
    if (c === 's' || k.name === 'return') return { type: 'confirm', answer: 'save' };
    if (c === 'd') return { type: 'confirm', answer: 'discard' };
    if (c === 'c' || c === 'n') return { type: 'confirm', answer: 'no' };
    return null;
  }
  if (c === 'y' || k.name === 'return') return { type: 'confirm', answer: 'yes' };
  if (c === 'n') return { type: 'confirm', answer: 'no' };
  return null;
}

export function keyToAction(k: Key, state: State): Action | null {
  if (k.ctrl && k.name === 'c') return state.mode.kind === 'normal' ? { type: 'quit' } : { type: 'forceQuit' };
  const mode = state.mode;
  switch (mode.kind) {
    case 'normal':
      return normalKey(k);
    case 'picker':
      return textKey(k);
    case 'settings': {
      if (mode.sub?.kind === 'input') return textKey(k);
      if (mode.sub?.kind === 'list') return listKey(k);
      if (k.name === 'left' || k.name === 'right') return { type: 'cycle', delta: k.name === 'left' ? -1 : 1 };
      if (k.name === 'backspace' || k.name === 'delete') return { type: 'delete' };
      if (k.sequence === 'q' || k.sequence === 'g' || k.sequence === 'e') return { type: 'cancel' };
      return listKey(k);
    }
    case 'presets':
      return listKey(k) ?? (k.sequence === 'q' || k.sequence === 't' ? { type: 'cancel' } : null);
    case 'confirm':
      return confirmKey(k, mode.what);
    case 'help':
      return { type: 'cancel' };
  }
}

export function mouseToAction(m: MouseEvent, state: State, hits: Hit[]): Action | null {
  const mode = state.mode;
  if (m.kind === 'wheel') {
    if (mode.kind === 'normal' || mode.kind === 'confirm' || mode.kind === 'help') return null;
    return { type: 'nav', dir: m.wheel === 'up' ? 'up' : 'down' };
  }
  if (mode.kind === 'normal') {
    if (m.kind === 'down' && m.button === 0) {
      const chip = chipAt(hits, m.x, m.y);
      if (chip) return { type: 'dragStart', from: { line: chip.line, index: chip.index } };
      const drop = dropTarget(hits, m.x, m.y);
      return drop ? { type: 'selectAt', line: drop.line, index: drop.index } : null;
    }
    if (!state.drag) return null;
    if (m.kind === 'move') return { type: 'dragOver', to: dropTarget(hits, m.x, m.y) };
    if (m.kind === 'up') return { type: 'dragEnd', to: dropTarget(hits, m.x, m.y) };
    return null;
  }
  if (m.kind === 'down' && m.button === 0) {
    const hit = itemAt(hits, m.x, m.y);
    if (hit) return { type: 'clickItem', area: hit.area, index: hit.index };
  }
  return null;
}
