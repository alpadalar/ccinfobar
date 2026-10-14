import { detectProvider, type Provider } from '../data/provider.js';
import { getWidget } from '../widgets/index.js';
import { isLoadingOutput } from '../widgets/shared.js';
import { stripAnsi, visibleWidth } from './ansi.js';
import { t } from './i18n/index.js';
import { hasReplies } from './payload.js';
import { maxLineWidth, normalizeResult, renderLine, resolveAppearance } from './renderer.js';
import { sanitizeText } from './sanitize.js';
import { createTrace, leaves, type SourceKind, type Trace, type TraceRead } from './trace.js';
import type { RenderContext, StatusPayload, WidgetDef, WidgetItem, WidgetResult } from './types.js';

export type { SourceKind } from './trace.js';

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

const MIN_VERSION: [string, string][] = [
  ['prompt_cache.last_miss_cause', '2.1.260'],
  ['prompt_cache', '2.1.251'],
];

function sinceFor(path: string): string {
  const hit = MIN_VERSION.find(([p]) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
  return hit ? t('explain.since', { version: hit[1] }) : '';
}

function absentField(reads: TraceRead[] | undefined): EmptyReason | null {
  if (!reads) return null;
  const payload = leaves(reads).filter((r) => r.kind === 'payload' && r.path);
  if (!payload.length || payload.some((r) => !r.absent)) return null;
  const path = payload.map((r) => r.path!).sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
  return reason('payload-field-absent', undefined, { path: sanitizeText(path), since: sinceFor(path) });
}

export function emptyReason(ctx: RenderContext, item: WidgetItem, reads?: TraceRead[]): EmptyReason {
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
  const absent = absentField(reads);
  if (absent) return absent;
  if (item.type === 'command') return reason('no-data', t('explain.reason.commandEmpty'));
  return reason('no-data');
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return sanitizeText(msg.split(/\r?\n/)[0] ?? '').trim();
}

export interface InspectMeta {
  usageWindows?: string[];
  ages?: Partial<Record<'usage' | 'transcript' | 'agents', number>>;
  gsdPath?: string;
}

export interface InspectOptions {
  commandEnv?: NodeJS.ProcessEnv;
  meta?: InspectMeta;
}

const PROVIDER_KEY = /^(CLAUDE_CODE_USE_|ANTHROPIC_)|^CLAUDE_CODE_OAUTH_TOKEN$/;

function hinted(hints: string[]): Source[] {
  return hints.map((h) => {
    const i = h.indexOf(':');
    return i < 0 ? { kind: h as SourceKind } : { kind: h.slice(0, i) as SourceKind, path: h.slice(i + 1) };
  });
}

function windowOf(path: string): string | null {
  const m = /^rate_limits\.([^.[]+)/.exec(path);
  return m ? m[1]! : null;
}

export function sourcesFor(
  def: WidgetDef,
  item: WidgetItem,
  reads: TraceRead[],
  meta: InspectMeta = {},
): Source[] {
  const raw = def.sources ? hinted(def.sources) : toSources(item, reads, meta);
  const seen = new Set<string>();
  return raw.filter((s) => {
    const k = `${s.kind}\u0000${s.path ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function toSources(item: WidgetItem, reads: TraceRead[], meta: InspectMeta): Source[] {
  const ages = meta.ages ?? {};
  const windows = new Set(meta.usageWindows ?? []);
  const out: Source[] = [];
  for (const r of leaves(reads)) {
    if (r.absent) continue;
    switch (r.kind) {
      case 'payload': {
        const w = r.path ? windowOf(r.path) : null;
        if (w && windows.has(w)) {
          out.push({
            kind: 'usage-cache',
            path: r.path!,
            ...(ages.usage !== undefined ? { age: ages.usage } : {}),
          });
        } else out.push({ kind: 'payload', ...(r.path ? { path: r.path } : {}) });
        break;
      }
      case 'transcript':
      case 'agents': {
        const age = ages[r.kind];
        out.push({ kind: r.kind, ...(age !== undefined ? { age } : {}) });
        break;
      }
      case 'gsd':
        out.push({ kind: 'gsd', path: meta.gsdPath ?? '.planning/STATE.md' });
        break;
      case 'env':
        if (item.type !== 'env' && r.path && PROVIDER_KEY.test(r.path))
          out.push({ kind: 'env', path: 'provider' });
        else out.push({ kind: 'env', ...(r.path ? { path: r.path } : {}) });
        break;
      default:
        out.push({ kind: r.kind, ...(r.path ? { path: r.path } : {}) });
    }
  }
  return out;
}

function inspectItem(
  ctx: RenderContext,
  traced: RenderContext,
  trace: Trace,
  item: WidgetItem,
  line: number,
  index: number,
  opts: InspectOptions,
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
  const wctx = trace.forWidget(
    item.type === 'command' && opts.commandEnv ? { ...traced, env: opts.commandEnv } : traced,
  );
  let result: WidgetResult;
  trace.begin();
  try {
    result = def.render(wctx, item);
  } catch (e) {
    trace.end();
    return { ...row, status: 'error', error: firstLine(e), empty: reason('error') };
  }
  const reads = trace.end();
  const sources = sourcesFor(def, item, reads, opts.meta);
  const out = normalizeResult(def, result);
  if (out) {
    return {
      ...row,
      status: isLoadingOutput(result) ? 'loading' : 'shown',
      value: stripAnsi(out.text),
      sources,
    };
  }
  const status = item.hideEmpty || def.category === 'layout' ? 'hidden' : 'empty';
  return { ...row, status, sources, empty: emptyReason(ctx, item, def.sources ? undefined : reads) };
}

export function inspectRows(ctx: RenderContext, opts: InspectOptions = {}): InspectRow[] {
  const trace = createTrace();
  const traced = trace.wrap(ctx);
  const out: InspectRow[] = [];
  ctx.config.lines.forEach((items, line) => {
    items.forEach((item, index) => {
      out.push(inspectItem(ctx, traced, trace, item, line, index, opts));
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
