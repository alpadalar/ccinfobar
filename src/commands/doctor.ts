import { stripAnsi, visibleWidth } from '../core/ansi.js';
import { createContext } from '../core/context.js';
import { readLastPayload } from '../core/preview.js';
import { maxLineWidth, renderLine, renderPart, resolveAppearance } from '../core/renderer.js';
import type { Config, RenderContext, StatusPayload, WidgetItem } from '../core/types.js';
import { terminalWidth } from '../data/terminal.js';
import { getWidget } from '../widgets/index.js';

export interface WidgetReport {
  line: number;
  item: WidgetItem;
  value: string | null;
  reason: string | null;
}

const TRANSCRIPT_TYPES = new Set([
  'skills',
  'compactions',
  'message-count',
  'output-speed',
  'gsd-last-command',
  'gsd-task',
]);

export function hiddenReason(ctx: RenderContext, item: WidgetItem): string {
  const def = getWidget(item.type);
  if (!def) return `unknown widget type "${item.type}"`;
  const p = ctx.payload;
  if (def.category === 'gsd') {
    if (!ctx.data.gsd()) return 'not inside a GSD project (no .planning/ found above the working directory)';
    return 'the GSD files have nothing for this widget right now';
  }
  if (def.category === 'limits') {
    if (!p.rate_limits) {
      return 'Claude Code sent no rate_limits: they come only with a Pro/Max login on recent Claude Code versions, after the first reply';
    }
    return 'this usage window is not in rate_limits';
  }
  if (def.category === 'context' && !p.context_window && !ctx.data.transcript()?.contextLength) {
    return 'Claude Code sent no context_window and the transcript has no usage yet (update Claude Code or send a message)';
  }
  if (def.category === 'git' && !ctx.data.git()) return 'not a git repository, or git is not on PATH';
  if (TRANSCRIPT_TYPES.has(item.type) && !ctx.data.transcript()) return 'transcript not readable';
  if (item.type === 'command' && !item.options?.command) return 'no command set';
  if (item.type === 'env' && !item.options?.name) return 'no variable name set';
  return 'no data for this widget in the current session';
}

export function widgetReport(ctx: RenderContext): WidgetReport[] {
  const out: WidgetReport[] = [];
  ctx.config.lines.forEach((items, line) => {
    for (const item of items) {
      if (item.type === 'flex') continue;
      const part = renderPart(ctx, item);
      out.push({
        line,
        item,
        value: part ? stripAnsi(part.text) : null,
        reason: part ? null : hiddenReason(ctx, item),
      });
    }
  });
  return out;
}

export function lineReport(
  ctx: RenderContext,
): { line: number; width: number; max: number | null; cut: boolean }[] {
  const a = resolveAppearance(ctx.config);
  if (a.style === 'tui') return [];
  const max = maxLineWidth(ctx);
  return ctx.config.lines.map((items, line) => {
    const full = renderLine(
      { ...ctx, terminalWidth: null, config: { ...ctx.config, maxWidth: 'auto' } },
      items,
      0,
      a,
    );
    const width = visibleWidth(full);
    return { line, width, max, cut: max !== null && width > max && !ctx.config.autoWrap };
  });
}

export function printWidgetReport(config: Config, payload: StatusPayload | null = readLastPayload()): void {
  console.log('\nWidgets');
  if (!payload) {
    console.log('  No payload yet. Use Claude Code once with ccinfobar installed, then run doctor again.');
    return;
  }
  const keys = Object.keys(payload).filter((k) => (payload as Record<string, unknown>)[k] !== undefined);
  console.log(
    `  Last payload: Claude Code ${payload.version ?? 'unknown version'}, fields: ${keys.sort().join(', ')}`,
  );
  const width = terminalWidth(payload.session_id, payload.terminal_width ?? payload.columns);
  const ctx = createContext({ payload, config: { ...config, colorLevel: 0 }, terminalWidth: width });
  for (const r of widgetReport(ctx)) {
    const name = `${r.item.type}${r.item.id !== r.item.type ? ` (${r.item.id})` : ''}`;
    if (r.value !== null) console.log(`  ✓ L${r.line + 1} ${name}: ${r.value}`);
    else console.log(`  ✗ L${r.line + 1} ${name}: hidden, ${r.reason}`);
  }
  const lines = lineReport(ctx);
  const cut = lines.filter((l) => l.cut);
  console.log(
    `\n  Width: ${width ?? 'unknown'} columns detected, ${lines[0]?.max ?? 'no'} usable after widthOffset`,
  );
  for (const l of cut) {
    console.log(
      `  ⚠ Line ${l.line + 1} needs ${l.width} columns and is cut with "…". Lower widthOffset, set autoWrap, or move widgets to another line.`,
    );
  }
}
