import { getWidget } from '../widgets/index.js';
import {
  detectLevel,
  type Level,
  RESET,
  sanitize,
  stripAnsi,
  style,
  truncate,
  visibleWidth,
} from './ansi.js';
import { getTheme } from './themes.js';
import type { Config, RenderContext, WidgetDef, WidgetItem } from './types.js';

export interface Part {
  item: WidgetItem;
  def: WidgetDef;
  text: string;
  fg: string | undefined;
  bg: string | undefined;
  flex: boolean;
}

export function labelFor(def: WidgetDef, item: WidgetItem, icons: Config['icons']): string {
  if (item.raw) return '';
  if (item.label !== undefined) return item.label;
  if (icons === 'none') return '';
  if (icons === 'nerd' && def.icon?.nerd) return `${def.icon.nerd} `;
  if (icons === 'emoji' && def.icon?.emoji) return `${def.icon.emoji} `;
  return def.label ?? '';
}

export function renderPart(ctx: RenderContext, item: WidgetItem): Part | null {
  const def = getWidget(item.type);
  if (!def) return null;
  let result: ReturnType<WidgetDef['render']>;
  try {
    result = def.render(ctx, item);
  } catch {
    return null;
  }
  if (result === null || result === undefined) return null;
  const out = typeof result === 'string' ? { text: result } : result;
  const value = sanitize(out.text);
  const flex = def.type === 'flex';
  if (!flex && value.trim() === '') return null;
  return {
    item,
    def,
    text: flex ? '' : labelFor(def, item, ctx.config.icons) + value,
    fg: item.color ?? out.color ?? def.color,
    bg: item.background ?? out.background,
    flex,
  };
}

function styleFor(part: Part, fg: string | undefined, bg: string | undefined) {
  return { fg, bg, bold: part.item.bold, dim: part.item.dim, italic: part.item.italic };
}

function renderPlain(parts: Part[], config: Config, level: Level): string {
  let out = '';
  parts.forEach((p, i) => {
    if (i > 0 && !parts[i - 1]!.item.merge && config.separator) {
      out += style(config.separator, { fg: config.separatorColor }, level);
    }
    out += style(p.text, styleFor(p, p.fg === 'default' ? undefined : p.fg, p.bg), level);
  });
  return out;
}

function renderPowerline(parts: Part[], config: Config, level: Level, offset: number): string {
  const theme = getTheme(config.powerline.theme);
  const pad = ' '.repeat(config.padding);
  const colors = parts.map((p, i) => {
    const t = theme.colors[(i + offset) % theme.colors.length]!;
    return { fg: p.item.color ?? t.fg, bg: p.bg ?? t.bg };
  });
  let out = '';
  if (config.powerline.startCap && colors[0]) {
    out += style(config.powerline.startCap, { fg: colors[0].bg }, level);
  }
  parts.forEach((p, i) => {
    const c = colors[i]!;
    const merged = i > 0 && parts[i - 1]!.item.merge;
    const leftPad = merged ? '' : pad;
    const rightPad = p.item.merge ? '' : pad;
    out += style(`${leftPad}${p.text}${rightPad}`, styleFor(p, c.fg, c.bg), level);
    const next = colors[i + 1];
    if (next && !p.item.merge) {
      out += style(config.powerline.separator, { fg: c.bg, bg: next.bg }, level);
    }
  });
  const last = colors[colors.length - 1];
  if (config.powerline.endCap && last) out += style(config.powerline.endCap, { fg: last.bg }, level);
  return out;
}

export function maxLineWidth(ctx: RenderContext): number | null {
  const { maxWidth, widthOffset } = ctx.config;
  if (typeof maxWidth === 'number') return maxWidth;
  if (ctx.terminalWidth) return Math.max(20, ctx.terminalWidth - widthOffset);
  return null;
}

export function renderLine(ctx: RenderContext, items: WidgetItem[], level: Level): string {
  const parts = items.map((it) => renderPart(ctx, it)).filter((p): p is Part => p !== null);
  if (parts.every((p) => p.flex)) return '';
  const groups: Part[][] = [[]];
  for (const p of parts) {
    if (p.flex) groups.push([]);
    else groups[groups.length - 1]!.push(p);
  }
  let offset = 0;
  const rendered = groups.map((g) => {
    const s = ctx.config.powerline.enabled
      ? renderPowerline(g, ctx.config, level, offset)
      : renderPlain(g, ctx.config, level);
    offset += g.length;
    return s;
  });
  const max = maxLineWidth(ctx);
  const nonEmpty = rendered.filter((s) => s !== '');
  let line: string;
  if (nonEmpty.length <= 1 || max === null) {
    const glue = ctx.config.powerline.enabled
      ? ' '
      : style(ctx.config.separator || ' ', { fg: ctx.config.separatorColor }, level);
    line = nonEmpty.join(glue);
  } else {
    const used = nonEmpty.reduce((n, s) => n + visibleWidth(s), 0);
    const gaps = nonEmpty.length - 1;
    const free = Math.max(gaps, max - used);
    line = nonEmpty
      .map((s, i) => {
        if (i === gaps) return s;
        const fill = Math.floor(free / gaps) + (i < free % gaps ? 1 : 0);
        return s + ' '.repeat(fill);
      })
      .join('');
  }
  if (max !== null && visibleWidth(line) > max) line = truncate(line, max);
  return line;
}

export function render(ctx: RenderContext): string[] {
  const level = detectLevel(ctx.config.colorLevel, ctx.env);
  return ctx.config.lines
    .map((items) => renderLine(ctx, items, level))
    .filter((l) => stripAnsi(l).trim() !== '');
}

export function finalizeLine(line: string): string {
  return `${RESET}${line.replace(/ /g, ' ')}`;
}
