import { detectProvider, type Provider } from '../data/provider.js';
import { getWidget } from '../widgets/index.js';
import { isLoadingOutput } from '../widgets/shared.js';
import { stripAnsi, visibleWidth } from './ansi.js';
import { t } from './i18n/index.js';
import { hasReplies } from './payload.js';
import { maxLineWidth, normalizeResult, renderLine, resolveAppearance } from './renderer.js';
import { sanitizeText } from './sanitize.js';
import type { RenderContext, StatusPayload, WidgetItem, WidgetResult } from './types.js';

export type SourceKind =
  | 'payload'
  | 'usage-cache'
  | 'transcript'
  | 'agents'
  | 'git'
  | 'gsd'
  | 'history'
  | 'env'
  | 'config'
  | 'clock'
  | 'system';

export interface Source {
  kind: SourceKind;
  path?: string;
  age?: number;
}

export type EmptyCode =
  | 'unknown-type'
  | 'missing-option'
  | 'no-gsd'
  | 'no-rate-limits'
  | 'provider-no-plan-limits'
  | 'no-context-window'
  | 'no-transcript'
  | 'no-git'
  | 'no-replies'
  | 'payload-field-absent'
  | 'error'
  | 'no-data';

export interface EmptyReason {
  code: EmptyCode;
  text: string;
}

export type RowStatus = 'shown' | 'empty' | 'hidden' | 'loading' | 'error' | 'skipped';

export interface InspectRow {
  line: number;
  index: number;
  id: string;
  type: string;
  status: RowStatus;
  value: string | null;
  sources: Source[];
  empty: EmptyReason | null;
  error: string | null;
}

export interface LineRow {
  line: number;
  width: number;
  max: number | null;
  cut: boolean;
}

const TRANSCRIPT_TYPES = new Set([
  'skills',
  'compactions',
  'message-count',
  'output-speed',
  'gsd-last-command',
  'gsd-task',
]);

const reason = (code: EmptyCode, text?: string, params?: Record<string, string>): EmptyReason => ({
  code,
  text: text ?? t(`explain.reason.${code}`, params),
});

function providerName(p: Provider): string {
  return t(`explain.provider.${p.kind}`, { host: sanitizeText(p.host ?? '') });
}

export function emptyReason(ctx: RenderContext, item: WidgetItem): EmptyReason {
  const def = getWidget(item.type);
  if (!def) return reason('unknown-type', undefined, { type: sanitizeText(item.type) });
  if (item.type === 'command' && !String(item.options?.command ?? '').trim()) {
    return reason('missing-option', undefined, { key: 'command' });
  }
  if (item.type === 'env' && !item.options?.name) return reason('missing-option', undefined, { key: 'name' });
  const p = ctx.payload;
  if (def.category === 'gsd') {
    return ctx.data.gsd() ? reason('no-data', t('explain.reason.gsdNothing')) : reason('no-gsd');
  }
  if (def.category === 'limits') {
    const provider = detectProvider(ctx.env);
    if (!provider.planLimits && !p.rate_limits) {
      return reason('provider-no-plan-limits', undefined, { provider: providerName(provider) });
    }
    return p.rate_limits ? reason('no-data', t('explain.reason.limitsWindow')) : reason('no-rate-limits');
  }
  if (def.category === 'context' && !p.context_window && !ctx.data.transcript()?.contextLength) {
    return reason('no-context-window');
  }
  if (def.category === 'git' && !ctx.data.git()) return reason('no-git');
  if (TRANSCRIPT_TYPES.has(item.type) && !ctx.data.transcript()) return reason('no-transcript');
  if (!hasReplies(p) && /^(context|tokens|cost)$/.test(def.category)) return reason('no-replies');
  // 02-05: payload-field-absent goes here
  if (item.type === 'command') return reason('no-data', t('explain.reason.commandEmpty'));
  return reason('no-data');
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return sanitizeText(msg.split(/\r?\n/)[0] ?? '').trim();
}

function inspectItem(
  ctx: RenderContext,
  item: WidgetItem,
  line: number,
  index: number,
  opts: { commandEnv?: NodeJS.ProcessEnv },
): InspectRow {
  const row: InspectRow = {
    line,
    index,
    id: item.id,
    type: item.type,
    status: 'empty',
    value: null,
    sources: [],
    empty: null,
    error: null,
  };
  if (item.type === 'flex') return { ...row, status: 'skipped' };
  const def = getWidget(item.type);
  if (!def) return { ...row, empty: emptyReason(ctx, item) };
  const wctx: RenderContext =
    item.type === 'command' && opts.commandEnv ? { ...ctx, env: opts.commandEnv } : { ...ctx };
  let result: WidgetResult;
  try {
    result = def.render(wctx, item);
  } catch (e) {
    return { ...row, status: 'error', error: firstLine(e), empty: reason('error') };
  }
  const out = normalizeResult(def, result);
  if (out) {
    return { ...row, status: isLoadingOutput(result) ? 'loading' : 'shown', value: stripAnsi(out.text) };
  }
  const status = item.hideEmpty || def.category === 'layout' ? 'hidden' : 'empty';
  return { ...row, status, empty: emptyReason(ctx, item) };
}

export function inspectRows(ctx: RenderContext, opts: { commandEnv?: NodeJS.ProcessEnv } = {}): InspectRow[] {
  const out: InspectRow[] = [];
  ctx.config.lines.forEach((items, line) => {
    items.forEach((item, index) => {
      out.push(inspectItem(ctx, item, line, index, opts));
    });
  });
  return out;
}

export function sessionNotes(p: StatusPayload): string[] {
  const notes: string[] = [];
  const full = (['five_hour', 'seven_day'] as const).filter(
    (k) => (p.rate_limits?.[k]?.used_percentage ?? 0) >= 100,
  );
  if (full.length) {
    const names = full.map((k) => (k === 'five_hour' ? '5-hour' : 'weekly')).join(' and ');
    notes.push(
      `Your ${names} usage limit is at 100%, so Claude cannot reply right now. Context, cache and token widgets fill in after the next successful reply.`,
    );
  }
  if (!hasReplies(p)) {
    notes.push(
      'This session has no replies yet (cost $0, no prompt cache). Send a message and run doctor again; context, cache and speed widgets need at least one answer.',
    );
  }
  return notes;
}

export function lineReport(ctx: RenderContext): LineRow[] {
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
