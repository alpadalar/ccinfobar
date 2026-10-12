import { type Level, splitAnsiLines, style, truncate, visibleWidth } from './ansi.js';
import type { Appearance } from './renderer.js';
import type { BoxChars, RenderContext, TuiBreakpoint, TuiConfig, WidgetItem } from './types.js';

export const BOX_PRESETS: Record<string, BoxChars> = {
  rounded: box('╭╮╰╯─│├┤'),
  square: box('┌┐└┘─│├┤'),
  heavy: box('┏┓┗┛━┃┣┫'),
  double: box('╔╗╚╝═║╠╣'),
  dashed: box('╭╮╰╯┄┊├┤'),
  'heavy-dashed': box('┏┓┗┛┅┇┣┫'),
  mixed: box('┍┑┕┙━│┝┥'),
  ascii: box('++++-|++'),
  invisible: box('        '),
};

function box(chars: string): BoxChars {
  const c = [...chars];
  return {
    topLeft: c[0]!,
    topRight: c[1]!,
    bottomLeft: c[2]!,
    bottomRight: c[3]!,
    horizontal: c[4]!,
    vertical: c[5]!,
    teeLeft: c[6]!,
    teeRight: c[7]!,
  };
}

export interface Cell {
  text: string;
  label: string;
  value: string;
}

export interface PanelDeps {
  cell(item: WidgetItem, index: number, extra?: number): Cell | null;
  fill?(item: WidgetItem): boolean;
  contextColor?(): string | undefined;
}

const lineWidth = (text: string) => Math.max(0, ...splitAnsiLines(text).map(visibleWidth));

type Row = { divider: true } | { divider: false; cells: { name: string; span: number }[] };

const DEFAULT_TITLE = '{model}';
const DEFAULT_RIGHT = 'ccinfobar';

function pad(text: string, width: number, align: 'left' | 'center' | 'right' = 'left'): string {
  const t = visibleWidth(text) > width ? truncate(text, width) : text;
  const free = Math.max(0, width - visibleWidth(t));
  if (align === 'right') return ' '.repeat(free) + t;
  if (align === 'center')
    return ' '.repeat(Math.floor(free / 2)) + t + ' '.repeat(free - Math.floor(free / 2));
  return t + ' '.repeat(free);
}

export function resolveBox(tui: TuiConfig, ascii: boolean): BoxChars {
  if (ascii) return BOX_PRESETS.ascii!;
  if (typeof tui.box === 'string') return BOX_PRESETS[tui.box] ?? BOX_PRESETS.rounded!;
  return { ...BOX_PRESETS.rounded!, ...tui.box };
}

export function parseArea(line: string): Row {
  const t = line.trim();
  if (/^-{3,}$/.test(t)) return { divider: true };
  const cells: { name: string; span: number }[] = [];
  for (const name of t.split(/\s+/).filter(Boolean)) {
    const last = cells[cells.length - 1];
    if (last && last.name === name && name !== '.') last.span++;
    else cells.push({ name, span: 1 });
  }
  return { divider: false, cells };
}

export function pickBreakpoint(bps: TuiBreakpoint[], width: number): TuiBreakpoint | null {
  const sorted = [...bps].sort((a, b) => b.minWidth - a.minWidth);
  return sorted.find((b) => b.minWidth <= width) ?? sorted[sorted.length - 1] ?? null;
}

function cullRows(rows: Row[], has: (name: string) => boolean): Row[] {
  const kept = rows
    .map((r) =>
      r.divider
        ? r
        : {
            divider: false as const,
            cells: r.cells.map((c) => (c.name === '.' || has(c.name) ? c : { ...c, name: '.' })),
          },
    )
    .filter((r) => r.divider || r.cells.some((c) => c.name !== '.'));
  const out: Row[] = [];
  for (const r of kept) {
    if (r.divider && (out.length === 0 || out[out.length - 1]!.divider)) continue;
    out.push(r);
  }
  while (out.length && out[out.length - 1]!.divider) out.pop();
  return out;
}

export function sizeColumns(
  specs: string[],
  rows: Row[],
  widthOf: (name: string) => number,
  inner: number | null,
  gap: number,
): number[] {
  const n = specs.length;
  const widths = specs.map((s) => (/^\d+$/.test(s) ? Number(s) : 0));
  const isFr = specs.map((s) => /^\d*\.?\d*fr$/.test(s));
  for (const r of rows) {
    if (r.divider) continue;
    let col = 0;
    for (const c of r.cells) {
      if (c.span === 1 && col < n && !/^\d+$/.test(specs[col]!)) {
        widths[col] = Math.max(widths[col]!, c.name === '.' ? 0 : widthOf(c.name));
      }
      col += c.span;
    }
  }
  for (const r of rows) {
    if (r.divider) continue;
    let col = 0;
    for (const c of r.cells) {
      if (c.span > 1 && c.name !== '.') {
        const end = Math.min(n, col + c.span);
        const have = widths.slice(col, end).reduce((a, b) => a + b, 0) + gap * (end - col - 1);
        const need = widthOf(c.name) - have;
        if (need > 0) widths[end - 1]! += need;
      }
      col += c.span;
    }
  }
  if (inner !== null) {
    const used = widths.reduce((a, b) => a + b, 0) + gap * (n - 1);
    const free = inner - used;
    const frTotal = specs.reduce((a, s, i) => a + (isFr[i] ? Number.parseFloat(s) || 1 : 0), 0);
    if (free > 0 && frTotal > 0) {
      let given = 0;
      const frIdx = specs.map((_, i) => i).filter((i) => isFr[i]);
      frIdx.forEach((i, k) => {
        const share =
          k === frIdx.length - 1
            ? free - given
            : Math.floor((free * (Number.parseFloat(specs[i]!) || 1)) / frTotal);
        widths[i]! += share;
        given += share;
      });
    } else if (free < 0) {
      let over = -free;
      const order = widths.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0]);
      for (const [, i] of order) {
        if (over <= 0) break;
        const cut = Math.min(over, Math.max(0, widths[i]! - 4));
        widths[i]! -= cut;
        over -= cut;
      }
    }
  }
  return widths;
}

export function renderPanel(
  ctx: RenderContext,
  a: Appearance,
  level: Level,
  deps: PanelDeps,
  maxWidth: number | null,
): string[] {
  const tui = ctx.config.tui ?? {};
  const ascii = ctx.config.charset === 'text';
  const b = resolveBox(tui, ascii);
  const borderFg =
    tui.borderColor === 'context'
      ? (deps.contextColor?.() ?? a.separatorColor)
      : (tui.borderColor ?? a.separatorColor);
  const border = (s: string) => style(s, { fg: borderFg }, level);
  const gap = tui.columnGap ?? a.separator ?? '  ';
  const gapW = visibleWidth(gap);
  const padding = tui.padding ?? 1;

  const cells = new Map<string, Cell>();
  const sources = new Map<string, { item: WidgetItem; index: number }>();
  const hidden = new Set<string>();
  let index = 0;
  for (const line of ctx.config.lines) {
    for (const item of line) {
      const at = index++;
      const c = deps.cell(item, at);
      if (!c) {
        hidden.add(item.id).add(item.type);
        continue;
      }
      for (const key of [item.id, item.type]) {
        if (!cells.has(key)) {
          cells.set(key, c);
          sources.set(key, { item, index: at });
          cells.set(`${key}.label`, { text: c.label, label: c.label, value: c.label });
          cells.set(`${key}.value`, { text: c.value, label: '', value: c.value });
        }
      }
    }
  }
  const lookup = (name: string): string | null => {
    const hit = cells.get(name);
    if (hit) return hit.text || null;
    const base = name.replace(/\.(label|value)$/, '');
    if (hidden.has(base)) return null;
    const adhoc = deps.cell({ id: `adhoc-${base}`, type: base }, index++);
    if (!adhoc) return null;
    const part = name.endsWith('.label') ? adhoc.label : name.endsWith('.value') ? adhoc.value : adhoc.text;
    return part || null;
  };
  const template = (src: string): string =>
    src.replace(/\{([a-z0-9._-]+)\}/gi, (_, n: string) => lookup(n) ?? '').trim();

  const templates = tui.templates ?? {};
  const grown = new Map<string, string>();
  // let bars, graphs and tables use the whole cell
  const fitted = (name: string, width: number): string | null => {
    const src = sources.get(name);
    const base = cells.get(name)?.text;
    if (!src || !base || !deps.fill?.(src.item)) return null;
    const extra = width - lineWidth(base);
    if (extra <= 0) return null;
    const key = `${name}@${width}`;
    if (!grown.has(key)) grown.set(key, deps.cell(src.item, src.index, extra)?.text ?? base);
    return grown.get(key)!;
  };
  const cellText = (name: string, width?: number): string => {
    const t = templates[name];
    if (t) {
      const parts = t.items.map((i) => template(i)).filter((x) => x !== '');
      if (t.justify === 'between' && width !== undefined && parts.length > 1) {
        const used = parts.reduce((n, p) => n + visibleWidth(p), 0);
        const slots = parts.length - 1;
        const free = Math.max(slots, width - used);
        return parts
          .map((p, i) =>
            i < slots ? p + ' '.repeat(Math.floor(free / slots) + (i < free % slots ? 1 : 0)) : p,
          )
          .join('');
      }
      return parts.join(' '.repeat(t.gap ?? 1));
    }
    if (width !== undefined) {
      const f = fitted(name, width);
      if (f !== null) return f;
    }
    return lookup(name) ?? '';
  };
  const has = (name: string) => cellText(name) !== '';
  const widthOf = (name: string) => lineWidth(cellText(name));

  const fit = tui.fitContent === true || maxWidth === null;
  const minW = tui.minWidth ?? 32;
  const maxW = Math.min(tui.maxWidth ?? Number.POSITIVE_INFINITY, maxWidth ?? Number.POSITIVE_INFINITY);
  const target = Number.isFinite(maxW) ? Math.max(minW, maxW) : null;

  let rows: Row[];
  let specs: string[];
  let align: TuiBreakpoint['align'] = [];
  const bp = tui.breakpoints?.length
    ? pickBreakpoint(tui.breakpoints, target ?? Number.POSITIVE_INFINITY)
    : null;
  if (bp) {
    rows = bp.areas.map(parseArea);
    const n = Math.max(1, ...rows.map((r) => (r.divider ? 0 : r.cells.reduce((s, c) => s + c.span, 0))));
    specs = Array.from({ length: n }, (_, i) => bp.columns?.[i] ?? (i === n - 1 ? '1fr' : 'auto'));
    align = bp.align ?? [];
  } else {
    const dividers = tui.dividers ?? true;
    rows = [];
    ctx.config.lines.forEach((line, li) => {
      let text = '';
      let glue = '';
      for (const it of line) {
        const t = cells.get(it.id)?.text;
        if (!t) continue;
        text += glue + t;
        glue = it.merge ? '' : gap;
      }
      if (!text) return;
      const name = `__line${li}`;
      cells.set(name, { text, label: '', value: '' });
      if (rows.length && dividers) rows.push({ divider: true });
      rows.push({ divider: false, cells: [{ name, span: 1 }] });
    });
    specs = ['1fr'];
  }
  rows = cullRows(rows, has);
  if (!rows.length) return [];

  const contentWidth = (widths: number[]) => widths.reduce((s, w) => s + w, 0) + gapW * (widths.length - 1);
  const natural = sizeColumns(specs, rows, widthOf, null, gapW);
  let inner: number;
  if (fit) {
    inner = Math.max(minW - 2 - padding * 2, contentWidth(natural));
    if (target !== null) inner = Math.min(inner, target - 2 - padding * 2);
  } else {
    inner = (target ?? minW) - 2 - padding * 2;
  }
  inner = Math.max(4, inner);
  const widths = sizeColumns(specs, rows, widthOf, inner, gapW);
  const total = inner + padding * 2;
  const side = ' '.repeat(padding);

  const edge = (left: string, right: string, l?: string, r?: string | false): string => {
    const lt = l ? template(l) : '';
    const rt = r ? template(r) : '';
    if (!lt && !rt) return border(left + b.horizontal.repeat(total) + right);
    const room = total - 2;
    const lText = lt ? ` ${truncate(lt, Math.max(1, room - (rt ? visibleWidth(rt) + 3 : 0)))} ` : '';
    const rText = rt ? ` ${truncate(rt, Math.max(1, room - visibleWidth(lText)))} ` : '';
    const fill = Math.max(0, total - 1 - visibleWidth(lText) - visibleWidth(rText) - (rText ? 1 : 0));
    return (
      border(left + b.horizontal) +
      lText +
      border(b.horizontal.repeat(fill)) +
      rText +
      border((rText ? b.horizontal : '') + right)
    );
  };

  const titleRight = tui.title?.right === false ? undefined : (tui.title?.right ?? DEFAULT_RIGHT);
  const out = [edge(b.topLeft, b.topRight, tui.title?.left ?? DEFAULT_TITLE, titleRight)];
  for (const r of rows) {
    if (r.divider) {
      const ch = tui.divider ?? b.horizontal;
      out.push(border(b.teeLeft + ch.repeat(total) + b.teeRight));
      continue;
    }
    let col = 0;
    const columns: { lines: string[]; w: number; align: 'left' | 'center' | 'right' }[] = [];
    for (const c of r.cells) {
      const end = Math.min(widths.length, col + c.span);
      const w = widths.slice(col, end).reduce((a2, b2) => a2 + b2, 0) + gapW * (end - col - 1);
      const text = c.name === '.' ? '' : cellText(c.name, w);
      columns.push({ lines: splitAnsiLines(text), w, align: align?.[col] ?? 'left' });
      col = end;
    }
    while (col < widths.length) columns.push({ lines: [''], w: widths[col++]!, align: 'left' });
    const height = Math.max(1, ...columns.map((c) => c.lines.length));
    for (let k = 0; k < height; k++) {
      const parts = columns.map((c) => pad(c.lines[k] ?? '', c.w, c.align));
      const body = pad(parts.join(gap), inner);
      out.push(border(b.vertical) + side + body + side + border(b.vertical));
    }
  }
  out.push(edge(b.bottomLeft, b.bottomRight, tui.footer?.left, tui.footer?.right));
  return out;
}
