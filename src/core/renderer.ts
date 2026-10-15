import { contextPercent } from '../widgets/context.js';
import { getWidget } from '../widgets/index.js';
import { opt } from '../widgets/shared.js';
import {
  contrastRatio,
  detectLevel,
  gradientColor,
  type Level,
  RESET,
  sanitize,
  stripAnsi,
  style,
  truncate,
  visibleWidth,
} from './ansi.js';
import { foldText, pasteSafeText, resolveGlyphMode, stripLinks, widthModeFor } from './glyphs.js';
import { hasItemRules, ruleDecision } from './metrics.js';
import { renderPanel } from './panel.js';
import {
  resolveTheme,
  STYLE_GLYPHS,
  STYLE_SEPARATOR,
  type Swatch,
  type Theme,
  type ThemeGlyphs,
} from './themes.js';
import type {
  Align,
  Config,
  OverflowMode,
  RenderContext,
  ResolvedGlyphMode,
  ThemeStyle,
  WidgetCategory,
  WidgetDef,
  WidgetItem,
  WidgetOutput,
  WidgetResult,
} from './types.js';
import { setWidthMode } from './width.js';

export { gradientColor };

export interface Part {
  item: WidgetItem;
  def: WidgetDef;
  text: string;
  label: string;
  value: string;
  empty?: boolean;
  status: string | undefined;
  bg: string | undefined;
  flex: boolean;
}

export interface Appearance {
  theme: Theme;
  style: ThemeStyle;
  separator: string;
  separatorColor: string;
  padding: number;
  glyphs: ThemeGlyphs;
}

const ASCII_GLYPHS: ThemeGlyphs = { separator: '', thin: '|', startCap: '', endCap: '' };
const UNICODE_GLYPHS: Record<ThemeStyle, ThemeGlyphs> = {
  text: { separator: '', thin: '', startCap: '', endCap: '' },
  blocks: { separator: '', thin: '', startCap: '', endCap: '' },
  powerline: { separator: '', thin: '│', startCap: '', endCap: '' },
  capsule: { separator: '', thin: '', startCap: '▐', endCap: '▌' },
  tui: { separator: '', thin: '', startCap: '', endCap: '' },
};

export type ResolvedCharset = 'nerd' | 'unicode' | 'text';

export function resolveCharset(config: Config, env: NodeJS.ProcessEnv = process.env): ResolvedCharset {
  if (resolveGlyphMode(config, env) === 'paste-safe') return 'text';
  if (config.charset === 'auto' || config.charset === undefined) {
    return env.TERM_PROGRAM === 'Apple_Terminal' ? 'unicode' : 'nerd';
  }
  return config.charset;
}

export function resolveAppearance(
  config: Config,
  theme: Theme = resolveTheme(config.theme),
  env: NodeJS.ProcessEnv = process.env,
): Appearance {
  const style = config.style ?? theme.style;
  const styleChanged = style !== theme.style;
  const charset = resolveCharset(config, env);
  const themed = styleChanged ? STYLE_GLYPHS[style] : theme.glyphs;
  const base = charset === 'text' ? ASCII_GLYPHS : charset === 'unicode' ? UNICODE_GLYPHS[style] : themed;
  let separator = config.separator ?? (styleChanged ? STYLE_SEPARATOR[style] : theme.separator);
  if (
    charset === 'text' &&
    (config.separator === undefined ||
      (resolveGlyphMode(config, env) === 'paste-safe' &&
        /[\uE000-\uF8FF\u{F0000}-\u{10FFFF}]/u.test(separator)))
  ) {
    separator = asciiSeparator(separator, style);
  }
  return {
    theme,
    style,
    separator,
    separatorColor: config.separatorColor ?? theme.colors.muted,
    padding: config.padding ?? theme.padding,
    glyphs: { ...base, ...(charset === 'nerd' ? config.glyphs : {}) },
  };
}

function asciiSeparator(sep: string, s: ThemeStyle): string {
  if (/^[\x20-\x7e]*$/.test(sep)) return sep;
  if (s === 'capsule' || s === 'blocks') return ' ';
  return sep.trim() ? ' | ' : sep;
}

export function effectiveIcons(config: Config, env: NodeJS.ProcessEnv = process.env): Config['icons'] {
  const charset = resolveCharset(config, env);
  if (charset === 'text' && (config.icons === 'nerd' || config.icons === 'emoji')) return 'text';
  if (config.icons === 'emoji' && resolveGlyphMode(config, env) === 'single-width') return 'text';
  if (charset === 'unicode' && config.icons === 'nerd') return 'text';
  return config.icons;
}

export function labelFor(def: WidgetDef, item: WidgetItem, icons: Config['icons']): string {
  if (item.raw) return '';
  if (item.label !== undefined) return item.label && !/\s$/.test(item.label) ? `${item.label} ` : item.label;
  if (icons === 'none') return '';
  if (icons === 'nerd' && def.icon?.nerd) return `${def.icon.nerd} `;
  if (icons === 'emoji' && def.icon?.emoji) return `${def.icon.emoji} `;
  return def.label ?? '';
}

export const EMPTY_VALUE = '—';

export function emptyHint(def: WidgetDef): string {
  return def.name.replace(/^(GSD|Git)\s+/i, '').toLowerCase();
}

export function renderValue(ctx: RenderContext, def: WidgetDef, item: WidgetItem): WidgetOutput | null {
  let result: WidgetResult;
  try {
    result = def.render(ctx, item);
  } catch {
    return null;
  }
  return normalizeResult(def, result, ctx.glyphMode ?? resolveGlyphMode(ctx.config, ctx.env));
}

export function normalizeResult(
  def: WidgetDef,
  result: WidgetResult,
  mode: ResolvedGlyphMode = 'normal',
): WidgetOutput | null {
  if (result === null || result === undefined) return null;
  const out = typeof result === 'string' ? { text: result } : result;
  if (typeof out !== 'object' || typeof out.text !== 'string') return null;
  try {
    const text = glyphText(sanitize(out.text), mode);
    return text.trim() === '' && def.type !== 'flex' ? null : { ...out, text };
  } catch {
    return null;
  }
}

function glyphText(text: string, mode: ResolvedGlyphMode): string {
  if (mode === 'normal' || mode === 'jetbrains') return text;
  const folded = foldText(text, mode);
  return mode === 'paste-safe' ? pasteSafeText(folded) : folded;
}

export function workspaceMode(ctx: RenderContext): boolean {
  for (const item of ctx.config.lines.flat()) {
    if (item.type !== 'workspace-repos' || !opt(item, 'hideGitPlaceholders', true)) continue;
    const def = getWidget(item.type);
    if (def && visible(ctx, item) && renderValue(ctx, def, item)) return true;
  }
  return false;
}

export function hiddenByWorkspace(ctx: RenderContext, def: WidgetDef): boolean {
  return ctx.workspaceMode === true && def.category === 'git' && def.type !== 'workspace-repos';
}

export function hidesWhenEmpty(def: WidgetDef, item: WidgetItem): boolean {
  return item.hideEmpty ?? def.hideWhenEmpty === true;
}

export function visible(ctx: RenderContext, item: WidgetItem): boolean {
  return !hasItemRules(item) || ruleDecision(ctx, item).visible;
}

export function renderPart(ctx: RenderContext, item: WidgetItem): Part | null {
  const def = getWidget(item.type);
  if (!def || !visible(ctx, item)) return null;
  const flex = def.type === 'flex';
  let out = renderValue(ctx, def, item);
  let empty = false;
  if (!out) {
    if (hidesWhenEmpty(def, item) || def.category === 'layout' || hiddenByWorkspace(ctx, def)) return null;
    out = { text: EMPTY_VALUE };
    empty = true;
  }
  const mode = ctx.glyphMode ?? resolveGlyphMode(ctx.config, ctx.env);
  const label = flex ? '' : glyphText(labelFor(def, item, effectiveIcons(ctx.config, ctx.env)), mode);
  const hint = empty && !label.trim() ? `${emptyHint(def)} ` : '';
  return {
    item,
    def,
    text: flex ? '' : label + hint + out.text,
    label,
    value: flex ? '' : out.text,
    status: empty ? undefined : out.color,
    bg: out.background,
    flex,
    empty,
  };
}

interface Colors {
  fg: string | undefined;
  bg: string | undefined;
}

function pick(s: Swatch | undefined, key: 'fg' | 'bg'): string | undefined {
  if (s === undefined) return undefined;
  if (typeof s === 'string') return key === 'fg' ? s : undefined;
  return s[key];
}

function swatchFor(theme: Theme, part: Part, index: number): Swatch | undefined {
  const c = theme.colors;
  if (c.mode === 'category') return c.categories[part.def.category];
  if (c.mode === 'cycle' && c.cycle.length) return c.cycle[index % c.cycle.length];
  return undefined;
}

export function colorsFor(a: Appearance, part: Part, index: number): Colors {
  const t = a.theme;
  const sw = swatchFor(t, part, index);
  const clean = (v: string | undefined) => (v === 'default' ? undefined : v);
  if (a.style === 'text') {
    const themed = t.colors.mode === 'widget' ? part.def.color : (pick(sw, 'fg') ?? t.colors.fg);
    const status = t.statusColors ? part.status : undefined;
    return { fg: clean(part.item.color ?? status ?? themed), bg: clean(part.item.background ?? part.bg) };
  }
  const borrowed = (t.style === 'text' || t.style === 'tui') && typeof sw === 'object' && !sw.bg && sw.fg;
  if (borrowed) {
    const bg = clean(part.item.background ?? part.bg ?? sw.fg);
    const own = part.item.background ? part.item.color : readable(part.item.color, bg);
    return { fg: clean(own ?? onColor(bg)), bg };
  }
  const block =
    typeof sw === 'string' ? sw : (sw?.bg ?? (t.colors.mode === 'widget' ? part.def.color : t.colors.bg));
  const text = typeof sw === 'object' && sw.fg ? sw.fg : t.colors.on;
  const bg = clean(part.item.background ?? part.bg ?? block);
  const own = part.item.background ? part.item.color : readable(part.item.color, bg);
  return { fg: clean(own ?? text), bg };
}

// text palette used as blocks
function onColor(bg: string | undefined): string {
  return (contrastRatio('black', bg) ?? 21) >= (contrastRatio('brightWhite', bg) ?? 0)
    ? 'black'
    : 'brightWhite';
}

// own color on a block only when legible
const MIN_CONTRAST = 3;

function readable(fg: string | undefined, bg: string | undefined): string | undefined {
  if (!fg) return undefined;
  const ratio = contrastRatio(fg, bg);
  return ratio === null || ratio >= MIN_CONTRAST ? fg : undefined;
}

function styleFor(a: Appearance, part: Part, c: Colors) {
  return {
    fg: c.fg,
    bg: c.bg,
    bold: part.item.bold ?? a.theme.bold,
    dim: part.item.dim || part.empty,
    italic: part.item.italic,
  };
}

function renderText(parts: Part[], a: Appearance, level: Level, offset: number): string {
  let out = '';
  parts.forEach((p, i) => {
    if (i > 0 && !parts[i - 1]!.item.merge && a.separator) {
      out += style(a.separator, { fg: a.separatorColor }, level);
    }
    out += style(p.text, styleFor(a, p, colorsFor(a, p, i + offset)), level);
  });
  return out;
}

function renderBlocks(parts: Part[], a: Appearance, level: Level, offset: number): string {
  const pad = ' '.repeat(a.padding);
  let out = '';
  parts.forEach((p, i) => {
    const merged = i > 0 && parts[i - 1]!.item.merge;
    if (i > 0 && !merged && a.separator) out += style(a.separator, { fg: a.separatorColor }, level);
    const text = `${merged ? '' : pad}${p.text}${p.item.merge ? '' : pad}`;
    out += style(text, styleFor(a, p, colorsFor(a, p, i + offset)), level);
  });
  return out;
}

function renderPowerline(parts: Part[], a: Appearance, level: Level, offset: number): string {
  const pad = ' '.repeat(a.padding);
  const colors = parts.map((p, i) => colorsFor(a, p, i + offset));
  const g = a.glyphs;
  let out = '';
  if (g.startCap && colors[0]) out += style(g.startCap, { fg: colors[0].bg }, level);
  parts.forEach((p, i) => {
    const c = colors[i]!;
    const merged = i > 0 && parts[i - 1]!.item.merge;
    out += style(`${merged ? '' : pad}${p.text}${p.item.merge ? '' : pad}`, styleFor(a, p, c), level);
    const next = colors[i + 1];
    if (!next || p.item.merge) return;
    if (next.bg === c.bg && g.thin) out += style(g.thin, { fg: a.separatorColor, bg: c.bg }, level);
    else if (g.separator) out += style(g.separator, { fg: c.bg, bg: next.bg }, level);
  });
  const last = colors[colors.length - 1];
  if (g.endCap && last) out += style(g.endCap, { fg: last.bg }, level);
  return out;
}

function renderCapsule(parts: Part[], a: Appearance, level: Level, offset: number): string {
  const pad = ' '.repeat(a.padding);
  const g = a.glyphs;
  let out = '';
  parts.forEach((p, i) => {
    const c = colorsFor(a, p, i + offset);
    const merged = i > 0 && parts[i - 1]!.item.merge;
    if (i > 0 && !merged && a.separator) out += style(a.separator, { fg: a.separatorColor }, level);
    if (!merged && g.startCap) out += style(g.startCap, { fg: c.bg }, level);
    out += style(`${merged ? '' : pad}${p.text}${p.item.merge ? '' : pad}`, styleFor(a, p, c), level);
    if (!p.item.merge && g.endCap) out += style(g.endCap, { fg: c.bg }, level);
  });
  return out;
}

const RENDERERS: Record<
  Exclude<ThemeStyle, 'tui'>,
  (parts: Part[], a: Appearance, level: Level, offset: number) => string
> = {
  text: renderText,
  blocks: renderBlocks,
  powerline: renderPowerline,
  capsule: renderCapsule,
};

export function maxLineWidth(ctx: RenderContext): number | null {
  const { maxWidth, widthOffset } = ctx.config;
  if (typeof maxWidth === 'number') return maxWidth;
  if (ctx.terminalWidth) return Math.max(20, ctx.terminalWidth - widthOffset);
  return null;
}

function compose(parts: Part[], a: Appearance, level: Level, max: number | null): string {
  const groups: Part[][] = [[]];
  for (const p of parts) {
    if (p.flex) groups.push([]);
    else groups[groups.length - 1]!.push(p);
  }
  let offset = 0;
  const rendered = groups.map((g) => {
    const s = RENDERERS[a.style === 'tui' ? 'text' : a.style](g, a, level, offset);
    offset += g.length;
    return s;
  });
  const nonEmpty = rendered.filter((s) => s !== '');
  if (nonEmpty.length <= 1 || max === null) {
    const glue = a.style === 'text' ? style(a.separator || ' ', { fg: a.separatorColor }, level) : ' ';
    return nonEmpty.join(glue);
  }
  const used = nonEmpty.reduce((n, s) => n + visibleWidth(s), 0);
  const gaps = nonEmpty.length - 1;
  const free = Math.max(gaps, max - used);
  return nonEmpty
    .map((s, i) => {
      if (i === gaps) return s;
      const fill = Math.floor(free / gaps) + (i < free % gaps ? 1 : 0);
      return s + ' '.repeat(fill);
    })
    .join('');
}

export const CATEGORY_PRIORITY: Partial<Record<WidgetCategory, number>> = {
  context: 70,
  limits: 70,
  session: 70,
  git: 50,
  workspace: 50,
  cost: 50,
  tokens: 50,
  gsd: 30,
  agents: 30,
  charts: 30,
  system: 30,
  custom: 30,
};

export function overflowOf(config: Pick<Config, 'overflow' | 'autoWrap'>): OverflowMode {
  return config.overflow ?? (config.autoWrap ? 'wrap' : 'truncate');
}

export function effectivePriority(item: WidgetItem, def: WidgetDef): number {
  return item.priority ?? CATEGORY_PRIORITY[def.category] ?? 30;
}

export interface LineReport {
  dropped: string[];
  width: number | null;
}

interface Unit {
  parts: Part[];
  priority: number;
}

function toUnits(parts: Part[]): Unit[] {
  const chains: Part[][] = [];
  parts.forEach((p, i) => {
    if (p.flex) return;
    const prev = parts[i - 1];
    if (prev && !prev.flex && prev.item.merge) chains[chains.length - 1]!.push(p);
    else chains.push([p]);
  });
  return chains.flatMap((c) => {
    const ranked = c.filter((p) => p.def.category !== 'layout');
    if (!ranked.length) return [];
    return [{ parts: c, priority: Math.max(...ranked.map((p) => effectivePriority(p.item, p.def))) }];
  });
}

function dropByPriority(parts: Part[], a: Appearance, level: Level, max: number, dropped: Part[]): string {
  let alive = toUnits(parts);
  let kept = parts;
  let line = compose(kept, a, level, max);
  while (alive.length > 1 && visibleWidth(line) > max) {
    let victim = alive.length - 1;
    for (let i = victim - 1; i >= 0; i--) if (alive[i]!.priority < alive[victim]!.priority) victim = i;
    const gone = new Set(alive[victim]!.parts);
    dropped.push(...gone);
    alive = alive.filter((_, i) => i !== victim);
    kept = kept.filter((p) => !gone.has(p));
    line = compose(kept, a, level, max);
  }
  return visibleWidth(line) > max ? truncate(line, max) : line;
}

export function renderLine(
  ctx: RenderContext,
  items: WidgetItem[],
  level: Level,
  a = resolveAppearance(ctx.config, undefined, ctx.env),
  report?: LineReport,
): string {
  const parts = items.map((it) => renderPart(ctx, it)).filter((p): p is Part => p !== null);
  if (parts.every((p) => p.flex)) return '';
  const max = maxLineWidth(ctx);
  if (report) report.width = max;
  const below = new Map<Part, string[]>();
  const textual = { ...a, style: 'text' as const };
  parts.forEach((p, i) => {
    if (!p.text.includes('\n')) return;
    const [first, ...rest] = p.text.split('\n');
    const s = styleFor(textual, p, colorsFor(textual, p, i));
    below.set(
      p,
      rest.map((r) => style(r, s, level)),
    );
    p.text = first ?? '';
    p.value = p.value.split('\n')[0] ?? '';
  });
  const withBelow = (line: string, gone?: Set<Part>) => {
    const rows = parts.flatMap((p) => (gone?.has(p) ? [] : (below.get(p) ?? [])));
    return rows.length ? [line, ...rows.map((l) => (max === null ? l : truncate(l, max)))].join('\n') : line;
  };
  let line = compose(parts, a, level, max);
  if (max !== null && visibleWidth(line) > max) {
    const mode = overflowOf(ctx.config);
    if (mode === 'wrap' && parts.filter((p) => !p.flex).length > 1)
      return withBelow(wrapLine(parts, a, level, max));
    if (mode === 'priority') {
      const dropped: Part[] = [];
      line = dropByPriority(parts, a, level, max, dropped);
      if (report) report.dropped.push(...dropped.map((p) => p.item.id));
      return withBelow(line, new Set(dropped));
    }
    line = truncate(line, max);
  }
  return withBelow(line);
}

function wrapLine(parts: Part[], a: Appearance, level: Level, max: number): string {
  const items = parts.filter((p) => !p.flex);
  const rows: Part[][] = [[]];
  let offset = 0;
  for (const p of items) {
    const row = rows[rows.length - 1]!;
    const trial = RENDERERS[a.style === 'tui' ? 'text' : a.style]([...row, p], a, level, offset);
    if (row.length && visibleWidth(trial) > max) {
      offset += row.length;
      rows.push([p]);
    } else row.push(p);
  }
  offset = 0;
  return rows
    .map((r) => {
      const s = RENDERERS[a.style === 'tui' ? 'text' : a.style](r, a, level, offset);
      offset += r.length;
      return visibleWidth(s) > max ? truncate(s, max) : s;
    })
    .join('\n');
}

export function render(base: RenderContext): string[] {
  const glyphMode = resolveGlyphMode(base.config, base.env);
  const prev = setWidthMode(widthModeFor(glyphMode, base.config.ambiguousWidth));
  try {
    return renderAll({ ...base, glyphMode });
  } finally {
    setWidthMode(prev);
  }
}

function renderAll(base: RenderContext): string[] {
  const ws = workspaceMode(base) ? { ...base, workspaceMode: true } : base;
  const level = detectLevel(ws.config.colorLevel, ws.env);
  const a = resolveAppearance(ws.config, ws.theme, ws.env);
  const ctx = a.theme.gradient && !ws.gradient ? { ...ws, gradient: a.theme.gradient } : ws;
  if (a.style === 'tui') {
    const textual = { ...a, style: 'text' as const };
    return renderPanel(
      ctx,
      a,
      level,
      {
        cell(item, index, extra) {
          const p = renderPart(extra ? { ...ctx, extra } : ctx, item);
          if (!p || p.flex) return null;
          const s = styleFor(textual, p, colorsFor(textual, p, index));
          const paint = (t: string) =>
            t
              .split('\n')
              .map((l) => style(l, s, level))
              .join('\n');
          return { text: paint(p.text), label: paint(p.label), value: paint(p.value) };
        },
        fill: (item) => item.options?.fill === true || getWidget(item.type)?.fill === true,
        contextColor: () => {
          const pct = contextPercent(ctx, 'raw');
          return pct === null ? undefined : gradientColor(pct);
        },
      },
      maxLineWidth(ctx),
    );
  }
  const width = maxLineWidth(ctx);
  return ctx.config.lines.flatMap((items, li) => {
    const align = ctx.config.lineAlign?.[li] ?? ctx.config.align ?? 'left';
    return renderLine(ctx, items, level, a)
      .split('\n')
      .filter((l) => stripAnsi(l).trim() !== '')
      .map((l) => alignLine(l, width, align));
  });
}

export function alignLine(line: string, width: number | null, align: Align): string {
  if (align === 'left' || width === null) return line;
  const free = width - visibleWidth(line);
  if (free <= 0) return line;
  return ' '.repeat(align === 'center' ? Math.floor(free / 2) : free) + line;
}

export function finalizeLine(line: string, opts: { pasteSafe?: boolean } = {}): string {
  if (opts.pasteSafe) return `${RESET}${stripLinks(line)}`;
  return `${RESET}${line.replace(/ /g, '\u00a0')}`;
}
