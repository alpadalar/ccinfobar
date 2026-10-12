import {
  addLine,
  findItem,
  insertItem,
  moveItem,
  moveLine,
  type Position,
  removeItem,
  removeLine,
} from '../core/edit.js';
import { PRESETS, type Preset } from '../core/presets.js';
import type { PreviewSource } from '../core/preview.js';
import { listThemes, type Theme } from '../core/themes.js';
import type { Config, WidgetItem } from '../core/types.js';
import { getWidget } from '../widgets/index.js';
import { pickerItems } from './catalog.js';
import {
  CUSTOM,
  cycled,
  editText,
  type Field,
  globalFields,
  listCursorFor,
  listEntries,
  toggled,
  widgetFields,
} from './fields.js';

export type { Position };

export type Sub = { kind: 'list'; cursor: number } | { kind: 'input'; text: string; pos: number };

export type ConfirmKind = 'quit' | 'deleteLine' | 'preset' | 'install';

export type Mode =
  | { kind: 'normal' }
  | { kind: 'picker'; filter: string; cursor: number }
  | { kind: 'settings'; scope: 'widget' | 'global'; itemId: string; cursor: number; sub: Sub | null }
  | { kind: 'presets'; cursor: number }
  | {
      kind: 'themes';
      filter: string;
      cursor: number;
      back: Mode;
      naming: { text: string; pos: number } | null;
    }
  | { kind: 'confirm'; what: ConfirmKind; preset?: string }
  | { kind: 'help' };

export type Effect =
  | { kind: 'save'; thenQuit?: boolean }
  | { kind: 'install' }
  | { kind: 'saveTheme'; id: string };

export interface DragState {
  from: Position;
  to: Position | null;
}

export interface State {
  config: Config;
  path: string;
  savedJson: string;
  dirty: boolean;
  past: Config[];
  future: Config[];
  sel: Position;
  mode: Mode;
  preview: PreviewSource;
  message: string;
  drag: DragState | null;
  effect: Effect | null;
  quit: boolean;
  presets: Preset[];
  gsd: boolean;
}

export type NavDir = 'up' | 'down' | 'left' | 'right' | 'pageup' | 'pagedown' | 'home' | 'end';

export type Action =
  | { type: 'select'; dir: NavDir }
  | { type: 'selectAt'; line: number; index: number }
  | { type: 'shiftChip'; dir: 'left' | 'right' }
  | { type: 'chipLine'; dir: 'up' | 'down' }
  | { type: 'openPicker' }
  | { type: 'removeChip' }
  | { type: 'openProps' }
  | { type: 'newLine' }
  | { type: 'deleteLine' }
  | { type: 'moveLine'; dir: 'up' | 'down' }
  | { type: 'openGlobal' }
  | { type: 'openPresets' }
  | { type: 'openThemes' }
  | { type: 'saveTheme' }
  | { type: 'togglePreview' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'save' }
  | { type: 'install' }
  | { type: 'quit' }
  | { type: 'forceQuit' }
  | { type: 'help' }
  | { type: 'dragStart'; from: Position }
  | { type: 'dragOver'; to: Position | null }
  | { type: 'dragEnd'; to: Position | null }
  | { type: 'nav'; dir: NavDir }
  | { type: 'enter' }
  | { type: 'cancel' }
  | { type: 'text'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'clear' }
  | { type: 'cycle'; delta: 1 | -1 }
  | { type: 'clickItem'; area: 'main' | 'sub'; index: number }
  | { type: 'confirm'; answer: 'yes' | 'no' | 'save' | 'discard' }
  | {
      type: 'effectDone';
      ok: boolean;
      message: string;
      saved?: boolean;
      thenQuit?: boolean;
      applyTheme?: string;
    }
  | { type: 'message'; text: string };

const PAGE = 8;
const HISTORY = 100;

export function initialState(
  config: Config,
  path: string,
  message = '',
  opts: { presets?: Preset[]; gsd?: boolean } = {},
): State {
  return {
    presets: opts.presets ?? PRESETS,
    gsd: opts.gsd ?? true,
    config,
    path,
    savedJson: JSON.stringify(config),
    dirty: false,
    past: [],
    future: [],
    sel: { line: 0, index: 0 },
    mode: { kind: 'normal' },
    preview: 'sample',
    message,
    drag: null,
    effect: null,
    quit: false,
  };
}

export function themeItems(filter: string): Theme[] {
  const tokens = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return listThemes().filter((t) => {
    const hay =
      `${t.id} ${t.name} ${t.style} ${t.description} ${t.source === 'user' ? 'yours' : ''}`.toLowerCase();
    return tokens.every((x) => hay.includes(x));
  });
}

export function withTheme(config: Config, id: string): Config {
  const next: Config = { ...config, theme: id };
  delete next.style;
  delete next.separator;
  delete next.separatorColor;
  delete next.padding;
  delete next.glyphs;
  return next;
}

let previewCache: { base: Config; id: string; value: Config } | null = null;

export function previewConfig(state: State): Config {
  const mode = state.mode;
  if (mode.kind !== 'themes') return state.config;
  const id = themeItems(mode.filter)[mode.cursor]?.id;
  if (!id) return state.config;
  if (previewCache && previewCache.base === state.config && previewCache.id === id) return previewCache.value;
  const value = withTheme(state.config, id);
  previewCache = { base: state.config, id, value };
  return value;
}

export function selectedItem(state: State): WidgetItem | undefined {
  return state.config.lines[state.sel.line]?.[state.sel.index];
}

export function clampSel(config: Config, sel: Position): Position {
  const line = Math.max(0, Math.min(sel.line, config.lines.length - 1));
  const len = config.lines[line]?.length ?? 0;
  return { line: Math.max(0, line), index: Math.max(0, Math.min(sel.index, len - 1)) };
}

export function settingsFields(state: State): Field[] {
  const mode = state.mode;
  if (mode.kind !== 'settings') return [];
  if (mode.scope === 'global') return globalFields(state.config);
  const found = findItem(state.config, mode.itemId);
  return found ? widgetFields(getWidget(found.item.type), mode.itemId) : [];
}

function withDirty(state: State): State {
  return { ...state, dirty: JSON.stringify(state.config) !== state.savedJson };
}

function commit(state: State, config: Config, patch: Partial<State> = {}): State {
  if (JSON.stringify(config) === JSON.stringify(state.config)) return { ...state, ...patch };
  const next = withDirty({
    ...state,
    ...patch,
    config,
    past: [...state.past, state.config].slice(-HISTORY),
    future: [],
  });
  return { ...next, sel: clampSel(config, patch.sel ?? state.sel) };
}

function itemName(item: WidgetItem | undefined): string {
  if (!item) return '';
  return getWidget(item.type)?.name ?? item.type;
}

function step(cursor: number, dir: NavDir, count: number): number {
  if (count <= 0) return 0;
  const moved =
    dir === 'up' || dir === 'left'
      ? cursor - 1
      : dir === 'down' || dir === 'right'
        ? cursor + 1
        : dir === 'pageup'
          ? cursor - PAGE
          : dir === 'pagedown'
            ? cursor + PAGE
            : dir === 'home'
              ? 0
              : count - 1;
  return Math.max(0, Math.min(count - 1, moved));
}

function reduceNormal(state: State, action: Action): State {
  const { config, sel } = state;
  const lines = config.lines;
  const item = selectedItem(state);
  switch (action.type) {
    case 'select': {
      if (action.dir === 'up' || action.dir === 'down') {
        const line = Math.max(0, Math.min(lines.length - 1, sel.line + (action.dir === 'up' ? -1 : 1)));
        return { ...state, sel: clampSel(config, { line, index: sel.index }) };
      }
      const len = lines[sel.line]?.length ?? 0;
      return { ...state, sel: { ...sel, index: step(sel.index, action.dir, len) } };
    }
    case 'selectAt':
      return { ...state, sel: clampSel(config, { line: action.line, index: action.index }) };
    case 'shiftChip': {
      if (!item) return state;
      const len = lines[sel.line]!.length;
      if (action.dir === 'left' && sel.index > 0) {
        const to = { line: sel.line, index: sel.index - 1 };
        return commit(state, moveItem(config, item.id, to), { sel: to });
      }
      if (action.dir === 'right' && sel.index < len - 1) {
        const next = moveItem(config, item.id, { line: sel.line, index: sel.index + 2 });
        return commit(state, next, { sel: { line: sel.line, index: sel.index + 1 } });
      }
      return state;
    }
    case 'chipLine': {
      if (!item) return state;
      const line = sel.line + (action.dir === 'up' ? -1 : 1);
      if (line < 0 || line >= lines.length) return state;
      const index = Math.min(sel.index, lines[line]!.length);
      return commit(state, moveItem(config, item.id, { line, index }), { sel: { line, index } });
    }
    case 'openPicker':
      return { ...state, mode: { kind: 'picker', filter: '', cursor: 0 } };
    case 'removeChip': {
      if (!item) return state;
      const next = commit(state, removeItem(config, item.id), { message: `Removed ${itemName(item)}` });
      return next;
    }
    case 'openProps':
      return item
        ? { ...state, mode: { kind: 'settings', scope: 'widget', itemId: item.id, cursor: 0, sub: null } }
        : { ...state, message: 'Nothing selected. Press a to add a widget.' };
    case 'openGlobal':
      return { ...state, mode: { kind: 'settings', scope: 'global', itemId: '', cursor: 0, sub: null } };
    case 'openPresets':
      return { ...state, mode: { kind: 'presets', cursor: 0 } };
    case 'openThemes':
      return openThemes(state);
    case 'newLine': {
      const at = lines.length ? sel.line + 1 : 0;
      return commit(state, addLine(config, at), { sel: { line: at, index: 0 } });
    }
    case 'deleteLine': {
      if (!lines.length) return state;
      if (!lines[sel.line]!.length) return commit(state, removeLine(config, sel.line));
      return { ...state, mode: { kind: 'confirm', what: 'deleteLine' } };
    }
    case 'moveLine': {
      const to = sel.line + (action.dir === 'up' ? -1 : 1);
      if (to < 0 || to >= lines.length) return state;
      return commit(state, moveLine(config, sel.line, to), { sel: { line: to, index: sel.index } });
    }
    case 'togglePreview':
      return {
        ...state,
        preview: state.preview === 'sample' ? 'last' : 'sample',
        message: state.preview === 'sample' ? 'Preview: last session payload' : 'Preview: sample data',
      };
    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (!prev) return { ...state, message: 'Nothing to undo' };
      return withDirty({
        ...state,
        config: prev,
        past: state.past.slice(0, -1),
        future: [config, ...state.future],
        sel: clampSel(prev, sel),
        message: 'Undo',
      });
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return { ...state, message: 'Nothing to redo' };
      return withDirty({
        ...state,
        config: next,
        past: [...state.past, config],
        future: state.future.slice(1),
        sel: clampSel(next, sel),
        message: 'Redo',
      });
    }
    case 'save':
      return { ...state, effect: { kind: 'save' } };
    case 'install':
      return { ...state, mode: { kind: 'confirm', what: 'install' } };
    case 'quit':
      if (state.drag) return { ...state, drag: null };
      return state.dirty ? { ...state, mode: { kind: 'confirm', what: 'quit' } } : { ...state, quit: true };
    case 'help':
      return { ...state, mode: { kind: 'help' } };
    case 'dragStart':
      return {
        ...state,
        sel: clampSel(config, action.from),
        drag: lines[action.from.line]?.[action.from.index] ? { from: action.from, to: null } : null,
      };
    case 'dragOver':
      return state.drag ? { ...state, drag: { ...state.drag, to: action.to } } : state;
    case 'dragEnd': {
      const drag = state.drag;
      if (!drag) return state;
      const cleared = { ...state, drag: null };
      const to = action.to ?? drag.to;
      const moving = lines[drag.from.line]?.[drag.from.index];
      if (!to || !moving) return cleared;
      const same =
        to.line === drag.from.line && (to.index === drag.from.index || to.index === drag.from.index + 1);
      if (same) return cleared;
      const next = moveItem(config, moving.id, to);
      const at = findItem(next, moving.id);
      return commit(cleared, next, { sel: at ? { line: at.line, index: at.index } : sel });
    }
    default:
      return state;
  }
}

function openThemes(state: State): State {
  const at = themeItems('').findIndex((t) => t.id === state.config.theme);
  return {
    ...state,
    mode: { kind: 'themes', filter: '', cursor: Math.max(0, at), back: state.mode, naming: null },
  };
}

const THEME_ID = /^[A-Za-z0-9._-]+$/;

function reduceThemes(state: State, action: Action, mode: Extract<Mode, { kind: 'themes' }>): State {
  const set = (patch: Partial<Extract<Mode, { kind: 'themes' }>>): State => ({
    ...state,
    mode: { ...mode, ...patch },
  });
  const apply = (index: number): State => {
    const theme = themeItems(mode.filter)[index];
    if (!theme) return state;
    return commit({ ...state, mode: mode.back }, withTheme(state.config, theme.id), {
      message: `Theme: ${theme.name}`,
    });
  };
  if (mode.naming) {
    switch (action.type) {
      case 'enter': {
        const id = mode.naming.text.trim();
        if (!THEME_ID.test(id)) return { ...state, message: 'Use letters, numbers, dot, dash or underscore' };
        return { ...state, effect: { kind: 'saveTheme', id } };
      }
      case 'cancel':
        return set({ naming: null });
      default:
        return set({
          naming: editInput({ kind: 'input', ...mode.naming }, action) as { text: string; pos: number },
        });
    }
  }
  switch (action.type) {
    case 'nav':
      return set({ cursor: step(mode.cursor, action.dir, themeItems(mode.filter).length) });
    case 'text':
      return set({ filter: mode.filter + action.text, cursor: 0 });
    case 'backspace':
      return set({ filter: [...mode.filter].slice(0, -1).join(''), cursor: 0 });
    case 'clear':
      return set({ filter: '', cursor: 0 });
    case 'enter':
      return apply(mode.cursor);
    case 'clickItem':
      return apply(action.index);
    case 'saveTheme':
      return set({ naming: { text: '', pos: 0 } });
    case 'cancel':
      return { ...state, mode: mode.back };
    default:
      return state;
  }
}

function insertFromPicker(state: State, filter: string, cursor: number): State {
  const def = pickerItems(filter, state.gsd)[cursor];
  if (!def) return state;
  const lines = state.config.lines;
  const line = Math.min(state.sel.line, Math.max(0, lines.length - 1));
  const at = { line, index: lines[line]?.length ? state.sel.index + 1 : 0 };
  const next = insertItem(state.config, { type: def.type }, at);
  return commit({ ...state, mode: { kind: 'normal' } }, next, {
    sel: at,
    message: `Added ${def.name}`,
  });
}

function reducePicker(state: State, action: Action, mode: Extract<Mode, { kind: 'picker' }>): State {
  const set = (filter: string, cursor: number): State => ({
    ...state,
    mode: { kind: 'picker', filter, cursor },
  });
  const count = () => pickerItems(mode.filter, state.gsd).length;
  switch (action.type) {
    case 'nav':
      return set(mode.filter, step(mode.cursor, action.dir, count()));
    case 'text':
      return set(mode.filter + action.text, 0);
    case 'backspace':
      return set([...mode.filter].slice(0, -1).join(''), 0);
    case 'clear':
      return set('', 0);
    case 'enter':
      return insertFromPicker(state, mode.filter, mode.cursor);
    case 'clickItem':
      return insertFromPicker(state, mode.filter, action.index);
    case 'cancel':
      return { ...state, mode: { kind: 'normal' } };
    default:
      return state;
  }
}

function applyField(state: State, field: Field, value: ReturnType<Field['get']>): State {
  const mode = state.mode;
  if (mode.kind !== 'settings') return state;
  const next = commit({ ...state, mode: { ...mode, sub: null } }, field.set(state.config, value));
  return next;
}

function activateField(state: State, mode: Extract<Mode, { kind: 'settings' }>, field: Field): State {
  const open = (sub: Sub): State => ({ ...state, mode: { ...mode, sub } });
  switch (field.kind) {
    case 'bool':
      return applyField(state, field, toggled(field, state.config));
    case 'theme':
      return openThemes(state);
    case 'color':
    case 'select':
      return open({ kind: 'list', cursor: listCursorFor(field, state.config) });
    default: {
      const text = editText(field, state.config);
      return open({ kind: 'input', text, pos: [...text].length });
    }
  }
}

function submitInput(state: State, field: Field, text: string): State {
  const parsed = field.parse(text);
  if (!parsed.ok) return { ...state, message: parsed.error };
  return applyField(state, field, parsed.value);
}

function chooseEntry(state: State, field: Field, index: number): State {
  const mode = state.mode;
  if (mode.kind !== 'settings') return state;
  const entry = listEntries(field)[index];
  if (!entry) return state;
  if (entry.value === CUSTOM) {
    const cur = field.get(state.config);
    const text = cur === undefined ? '' : String(cur);
    return { ...state, mode: { ...mode, sub: { kind: 'input', text, pos: [...text].length } } };
  }
  const value = field.kind === 'number' ? Number(entry.value) : entry.value;
  return applyField(state, field, value);
}

function editInput(sub: Extract<Sub, { kind: 'input' }>, action: Action): Sub {
  const chars = [...sub.text];
  switch (action.type) {
    case 'text': {
      const ins = [...action.text];
      chars.splice(sub.pos, 0, ...ins);
      return { kind: 'input', text: chars.join(''), pos: sub.pos + ins.length };
    }
    case 'backspace':
      if (sub.pos === 0) return sub;
      chars.splice(sub.pos - 1, 1);
      return { kind: 'input', text: chars.join(''), pos: sub.pos - 1 };
    case 'delete':
      chars.splice(sub.pos, 1);
      return { kind: 'input', text: chars.join(''), pos: sub.pos };
    case 'clear':
      return { kind: 'input', text: '', pos: 0 };
    case 'nav': {
      const pos =
        action.dir === 'left'
          ? sub.pos - 1
          : action.dir === 'right'
            ? sub.pos + 1
            : action.dir === 'home'
              ? 0
              : action.dir === 'end'
                ? chars.length
                : sub.pos;
      return { kind: 'input', text: sub.text, pos: Math.max(0, Math.min(chars.length, pos)) };
    }
    default:
      return sub;
  }
}

function reduceSettings(state: State, action: Action, mode: Extract<Mode, { kind: 'settings' }>): State {
  const fields = settingsFields(state);
  const field = fields[mode.cursor];
  const sub = mode.sub;
  if (sub?.kind === 'input' && field) {
    if (action.type === 'enter') return submitInput(state, field, sub.text);
    if (action.type === 'cancel') return { ...state, mode: { ...mode, sub: null } };
    return { ...state, mode: { ...mode, sub: editInput(sub, action) } };
  }
  if (sub?.kind === 'list' && field) {
    const count = listEntries(field).length;
    switch (action.type) {
      case 'nav':
        return {
          ...state,
          mode: { ...mode, sub: { kind: 'list', cursor: step(sub.cursor, action.dir, count) } },
        };
      case 'enter':
        return chooseEntry(state, field, sub.cursor);
      case 'clickItem':
        return action.area === 'sub' ? chooseEntry(state, field, action.index) : state;
      case 'cancel':
        return { ...state, mode: { ...mode, sub: null } };
      default:
        return state;
    }
  }
  switch (action.type) {
    case 'nav':
      return { ...state, mode: { ...mode, cursor: step(mode.cursor, action.dir, fields.length) } };
    case 'enter':
      return field ? activateField(state, mode, field) : state;
    case 'clickItem':
      if (action.area !== 'main') return state;
      return fields[action.index]
        ? activateField(
            { ...state, mode: { ...mode, cursor: action.index } },
            { ...mode, cursor: action.index },
            fields[action.index]!,
          )
        : state;
    case 'cycle': {
      if (!field || (field.kind !== 'select' && field.kind !== 'bool' && field.kind !== 'number'))
        return state;
      return applyField(state, field, cycled(field, state.config, action.delta));
    }
    case 'delete':
    case 'backspace':
      return field?.resettable ? applyField(state, field, undefined) : state;
    case 'cancel':
      return { ...state, mode: { kind: 'normal' } };
    default:
      return state;
  }
}

function reducePresets(state: State, action: Action, mode: Extract<Mode, { kind: 'presets' }>): State {
  switch (action.type) {
    case 'nav':
      return {
        ...state,
        mode: { kind: 'presets', cursor: step(mode.cursor, action.dir, state.presets.length) },
      };
    case 'enter':
    case 'clickItem': {
      const preset = state.presets[action.type === 'clickItem' ? action.index : mode.cursor];
      return preset ? { ...state, mode: { kind: 'confirm', what: 'preset', preset: preset.id } } : state;
    }
    case 'cancel':
      return { ...state, mode: { kind: 'normal' } };
    default:
      return state;
  }
}

function reduceConfirm(state: State, action: Action, mode: Extract<Mode, { kind: 'confirm' }>): State {
  const back = { ...state, mode: { kind: 'normal' } as Mode };
  if (action.type === 'cancel') return back;
  if (action.type !== 'confirm') return state;
  if (action.answer === 'no') return back;
  switch (mode.what) {
    case 'quit':
      if (action.answer === 'save') return { ...back, effect: { kind: 'save', thenQuit: true } };
      if (action.answer === 'discard') return { ...back, quit: true };
      return state;
    case 'deleteLine':
      return action.answer === 'yes'
        ? commit(back, removeLine(state.config, state.sel.line), { message: 'Line deleted' })
        : state;
    case 'preset': {
      const preset = state.presets.find((p) => p.id === mode.preset);
      if (action.answer !== 'yes' || !preset) return state;
      return commit(back, preset.build(), {
        sel: { line: 0, index: 0 },
        message: `Applied preset ${preset.name}`,
      });
    }
    case 'install':
      return action.answer === 'yes' ? { ...back, effect: { kind: 'install' } } : state;
  }
}

export function reduce(prev: State, action: Action): State {
  const state =
    prev.message && action.type !== 'message' && action.type !== 'dragOver' ? { ...prev, message: '' } : prev;
  switch (action.type) {
    case 'message':
      return { ...state, message: action.text };
    case 'forceQuit':
      return { ...state, quit: true };
    case 'effectDone': {
      const done = { ...state, effect: null, message: action.message };
      if (!action.ok) return done;
      if (action.applyTheme && state.mode.kind === 'themes') {
        const applied = commit(
          { ...done, mode: state.mode.back },
          withTheme(state.config, action.applyTheme),
        );
        return { ...applied, message: action.message };
      }
      const saved = action.saved ? withDirty({ ...done, savedJson: JSON.stringify(state.config) }) : done;
      return { ...saved, quit: action.thenQuit === true };
    }
    default:
  }
  const mode = state.mode;
  switch (mode.kind) {
    case 'normal':
      return reduceNormal(state, action);
    case 'picker':
      return reducePicker(state, action, mode);
    case 'settings':
      return reduceSettings(state, action, mode);
    case 'presets':
      return reducePresets(state, action, mode);
    case 'themes':
      return reduceThemes(state, action, mode);
    case 'confirm':
      return reduceConfirm(state, action, mode);
    case 'help':
      return action.type === 'cancel' || action.type === 'enter'
        ? { ...state, mode: { kind: 'normal' } }
        : state;
  }
}
