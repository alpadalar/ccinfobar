import type { JobEnvelope, JobNetwork } from '../data/jobs/runner.js';
import { LEDGER_TYPES } from '../data/ledger.js';
import { trustedTurn } from '../data/live.js';
import { detectProvider, type Provider } from '../data/provider.js';
import { budgetPeriod } from '../widgets/cost.js';
import { PR_CI_GONE_MS, prCiState } from '../widgets/git.js';
import { HTTP_GONE_MS, httpState } from '../widgets/http.js';
import { getWidget } from '../widgets/index.js';
import { projectionState } from '../widgets/projection.js';
import { isLoadingOutput } from '../widgets/shared.js';
import { STATUS_STALE_MS, serviceState } from '../widgets/status.js';
import { stripAnsi } from './ansi.js';
import { describeRuleError, METRIC_SPECS, type MetricValue, type Visibility } from './conditions.js';
import { resolveGlyphMode, widthModeFor } from './glyphs.js';
import { compareIds } from './i18n/format.js';
import { setLanguage, t } from './i18n/index.js';
import { isLanguageId } from './i18n/languages.js';
import { parsePath } from './jsonpath.js';
import { hasItemRules, ruleDecision } from './metrics.js';
import { hasReplies } from './payload.js';
import {
  effectivePriority,
  hiddenByWorkspace,
  hidesWhenEmpty,
  type LineReport,
  maxLineWidth,
  normalizeResult,
  overflowOf,
  renderLine,
  resolveAppearance,
  workspaceMode,
} from './renderer.js';
import { sanitizeText } from './sanitize.js';
import { createTrace, type JobSource, leaves, type SourceKind, type Trace, type TraceRead } from './trace.js';
import type { RenderContext, StatusPayload, WidgetDef, WidgetItem, WidgetResult } from './types.js';
import { setWidthMode } from './width.js';

export type { SourceKind } from './trace.js';

export type LimitOrigin = 'session' | 'usage-api';

export interface Source {
  kind: SourceKind;
  path?: string;
  age?: number;
  origin?: LimitOrigin;
  job?: JobSource;
}

export type EmptyCode =
  | 'unknown-type'
  | 'missing-option'
  | 'bad-option'
  | 'no-gsd'
  | 'no-rate-limits'
  | 'limits-expired'
  | 'projection-warming'
  | 'provider-no-plan-limits'
  | 'no-context-window'
  | 'no-transcript'
  | 'no-git'
  | 'no-jj'
  | 'inside-repo'
  | 'no-child-repos'
  | 'no-tools'
  | 'needs-hooks'
  | 'no-hook-state'
  | 'workspace-mode'
  | 'no-ledger'
  | 'no-budget'
  | 'no-replies'
  | 'payload-field-absent'
  | 'no-mcp-health'
  | 'no-turn'
  | 'all-zero'
  | 'job-pending'
  | 'job-error'
  | 'nonessential-traffic-off'
  | 'stale'
  | 'gh-missing'
  | 'gh-auth'
  | 'gh-host'
  | 'gh-old'
  | 'merge-request'
  | 'no-ci-checks'
  | 'not-scalar'
  | 'path-miss'
  | 'error'
  | 'no-data'
  | 'hidden-by-rule'
  | 'invalid-rule'
  | 'dropped-by-priority';

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
  priority?: number;
  note?: EmptyReason;
  ci?: EmptyReason;
  warning?: EmptyReason;
}

export interface LineRow {
  line: number;
  width: number;
  max: number | null;
  cut: boolean;
  // set when the cut happened under wrap or priority
  overflow?: 'wrap' | 'priority';
  dropped?: string[];
}

const TRANSCRIPT_TYPES = new Set([
  'skills',
  'compactions',
  'message-count',
  'output-speed',
  'gsd-last-command',
  'gsd-task',
  'tool-activity',
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
  const path = payload.map((r) => r.path!).sort((a, b) => a.length - b.length || compareIds(a, b))[0]!;
  return reason('payload-field-absent', undefined, { path: sanitizeText(path), since: sinceFor(path) });
}

// an absent payload window the store saw roll over
function expiredWindow(ctx: RenderContext, item: WidgetItem, reads: TraceRead[] | undefined): boolean {
  let expired: string[] | undefined;
  try {
    expired = ctx.data.limits?.()?.expired;
  } catch {
    return false;
  }
  if (!expired?.length || !reads) return false;
  const models = expired.filter((k) => k.startsWith('model:'));
  return leaves(reads).some((r) => {
    const w = r.kind === 'payload' && r.absent && r.path ? windowOf(r.path, item, models) : null;
    return !!w && expired.includes(w);
  });
}

const absentValue = (v: unknown): boolean => v === null || v === undefined;

const jobErrorText = (error: string | undefined): string =>
  error === 'insecure-url'
    ? t('explain.job.insecure-url')
    : sanitizeText(error ?? '') || t('explain.job.unknownError');

// shared by every job-backed widget
export function jobReason(
  e: JobEnvelope<unknown> | null,
  network: JobNetwork,
  env: Record<string, string | undefined>,
  now: number,
  staleAfterMs: number,
): EmptyCode | null {
  if (!e) {
    return network === 'auto' && env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
      ? 'nonessential-traffic-off'
      : 'job-pending';
  }
  if (!e.ok && absentValue(e.value) && absentValue(e.lastGood)) return 'job-error';
  const at = e.ok ? e.fetchedAt : (e.lastGoodAt ?? null);
  if (at === null || now - at > staleAfterMs) return 'stale';
  return null;
}

export function jobEmpty(
  e: JobEnvelope<unknown> | null,
  network: JobNetwork,
  env: Record<string, string | undefined>,
  now: number,
  staleAfterMs: number,
): EmptyReason | null {
  const code = jobReason(e, network, env, now, staleAfterMs);
  if (code === null) return null;
  if (code === 'job-error') return reason(code, undefined, { error: jobErrorText(e?.error) });
  if (code === 'job-pending' && env.CCINFOBAR_NO_JOBS)
    return reason(code, t('explain.reason.job-pending') + t('explain.job.noJobs'));
  return reason(code);
}

function serviceReason(ctx: RenderContext, item: WidgetItem): EmptyReason {
  if (ctx.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return reason('nonessential-traffic-off');
  const e = ctx.data.jobs?.()?.job('status') ?? null;
  const job = jobEmpty(e, 'auto', ctx.env, ctx.now.getTime(), STATUS_STALE_MS);
  if (job) return job;
  const s = serviceState(ctx, item);
  if (!s) return reason('no-data');
  if (s.stale) return reason('no-data', t('explain.reason.serviceStaleOk'));
  const filter = sanitizeText(String(item.options?.components ?? '')).trim();
  if (filter) return reason('no-data', t('explain.reason.serviceOkFiltered', { components: filter }));
  return reason('no-data', t('explain.reason.serviceOk'));
}

function httpReason(ctx: RenderContext, item: WidgetItem): EmptyReason {
  const s = httpState(ctx, item);
  const now = ctx.now.getTime();
  if (s.kind !== 'no-url' && s.kind !== 'bad-url') {
    const raw = item.options?.path;
    const path = parsePath((typeof raw === 'string' && raw) || '$');
    if (!path.ok) return reason('bad-option', undefined, { key: 'path', error: sanitizeText(path.error) });
  }
  switch (s.kind) {
    case 'no-url':
      return reason('missing-option', undefined, { key: 'url' });
    case 'bad-url':
      return reason('bad-option', undefined, { key: s.field ?? 'url', error: sanitizeText(s.error) });
    case 'pending':
      return jobEmpty(null, 'explicit', ctx.env, now, HTTP_GONE_MS)!;
    case 'error':
    case 'gone': {
      const e = ctx.data.jobs?.()?.job(s.key) ?? null;
      const fallback = s.kind === 'gone' ? 'stale' : 'job-error';
      return (
        jobEmpty(e, 'explicit', ctx.env, now, HTTP_GONE_MS) ??
        reason(fallback, undefined, { error: sanitizeText(s.error ?? '') || t('explain.job.unknownError') })
      );
    }
    case 'miss':
      return s.code === 'path-miss' || s.code === 'not-scalar'
        ? reason(s.code)
        : reason('bad-option', undefined, { key: 'path', error: sanitizeText(s.code) });
    default:
      return reason('no-data');
  }
}

const GH_CODES = new Set<string>(['gh-missing', 'gh-auth', 'gh-host', 'gh-old']);

function ciInfo(ctx: RenderContext, item: WidgetItem): { code: EmptyCode; error: string | null } | null {
  const s = prCiState(ctx, item);
  switch (s.kind) {
    case 'off':
      return null;
    case 'mr':
      return { code: 'merge-request', error: null };
    case 'no-repo':
      return { code: 'payload-field-absent', error: null };
    case 'ok':
      if (s.error)
        return { code: GH_CODES.has(s.error) ? (s.error as EmptyCode) : 'job-error', error: s.error };
      return s.v.total === 0 ? { code: 'no-ci-checks', error: null } : null;
    default: {
      const e = ctx.data.jobs?.()?.job(s.key) ?? null;
      const error = e && !e.ok ? (e.error ?? null) : null;
      if (error && GH_CODES.has(error)) return { code: error as EmptyCode, error };
      const code = jobReason(e, 'explicit', ctx.env, ctx.now.getTime(), PR_CI_GONE_MS);
      return { code: code ?? (s.kind === 'gone' ? 'stale' : 'job-error'), error };
    }
  }
}

// why the pr widget shows no CI part, or shows an old one
export function ciReason(ctx: RenderContext, item: WidgetItem): EmptyCode | null {
  return ciInfo(ctx, item)?.code ?? null;
}

function ciEmpty(ctx: RenderContext, item: WidgetItem): EmptyReason | null {
  const c = ciInfo(ctx, item);
  if (!c) return null;
  const error = sanitizeText(c.error ?? '') || t('explain.job.unknownError');
  if (c.code === 'payload-field-absent')
    return reason(c.code, undefined, { path: 'workspace.repo.owner/name', since: '' });
  if (c.code === 'job-error' && prCiState(ctx, item).kind === 'ok')
    return reason(c.code, t('explain.reason.ciLastGood', { error }));
  if (c.code === 'job-error') return reason(c.code, undefined, { error });
  if (c.code === 'job-pending' && ctx.env.CCINFOBAR_NO_JOBS)
    return reason(c.code, t('explain.reason.job-pending') + t('explain.job.noJobs'));
  return reason(c.code);
}

const PROJECTION_TYPES = new Set(['usage-projection', 'limit-eta', 'limit-risk']);
const BELOW = { 'limit-risk': 'explain.reason.belowRisk', 'limit-eta': 'explain.reason.limitSafe' } as const;

export function emptyReason(
  ctx: RenderContext,
  item: WidgetItem,
  reads?: TraceRead[],
  meta: InspectMeta = {},
): EmptyReason {
  const def = getWidget(item.type);
  if (!def) return reason('unknown-type', undefined, { type: sanitizeText(item.type) });
  if (item.type === 'command' && !String(item.options?.command ?? '').trim()) {
    return reason('missing-option', undefined, { key: 'command' });
  }
  if (item.type === 'env' && !item.options?.name) return reason('missing-option', undefined, { key: 'name' });
  if (item.type === 'service-status') return serviceReason(ctx, item);
  if (item.type === 'http') return httpReason(ctx, item);
  const p = ctx.payload;
  if (def.category === 'gsd') {
    return ctx.data.gsd() ? reason('no-data', t('explain.reason.gsdNothing')) : reason('no-gsd');
  }
  if (def.category === 'limits') {
    if (PROJECTION_TYPES.has(item.type)) {
      const s = projectionState(ctx, item);
      if (s === 'warming') return reason('projection-warming');
      const below = BELOW[item.type as keyof typeof BELOW];
      if (s === 'ok' && below) return reason('no-data', t(below));
    }
    if (expiredWindow(ctx, item, reads)) return reason('limits-expired');
    const provider = detectProvider(ctx.env);
    if (!provider.planLimits && !p.rate_limits) {
      return reason('provider-no-plan-limits', undefined, { provider: providerName(provider) });
    }
    return p.rate_limits ? reason('no-data', t('explain.reason.limitsWindow')) : reason('no-rate-limits');
  }
  if (def.category === 'context' && !p.context_window && !ctx.data.transcript()?.contextLength) {
    return reason('no-context-window');
  }
  if (item.type === 'provider' && detectProvider(ctx.env).kind === 'firstParty') {
    return reason('no-data', t('explain.reason.providerFirstParty'));
  }
  if (item.type === 'workspace-repos') return reason(ctx.data.repos?.() ? 'no-child-repos' : 'inside-repo');
  if (item.type.startsWith('jj-') && !ctx.data.jj?.()) return reason('no-jj');
  if (def.category === 'git' && !ctx.data.git()) return reason('no-git');
  if (TRANSCRIPT_TYPES.has(item.type) && !ctx.data.transcript()) return reason('no-transcript');
  if (item.type === 'permission-wait') {
    if (!ctx.data.hooks?.()) return reason(meta.hooksInstalled ? 'no-hook-state' : 'needs-hooks');
    return reason('no-data', t('explain.reason.noPermissionWait'));
  }
  if (item.type === 'turn-timer') {
    const h = ctx.data.hooks?.() ?? null;
    const turn = trustedTurn(h, ctx.data.transcript(), p.prompt_id, ctx.now.getTime());
    return turn ? reason('no-data', t('explain.reason.turnHidden')) : reason('no-turn');
  }
  if (item.type === 'env-counts' && ctx.data.environment?.()) return reason('all-zero');
  if (item.type === 'tool-activity') {
    return reason('no-tools', undefined, { scope: item.options?.scope === 'session' ? 'session' : 'turn' });
  }
  if (item.type === 'budget') {
    const period = budgetPeriod(item);
    if (!ctx.config.budget?.[period]) return reason('no-budget', undefined, { period });
    if (period === 'daily' && !ctx.data.ledger?.()) return reason('no-ledger');
  }
  if (LEDGER_TYPES.has(item.type) && !ctx.data.ledger?.()) return reason('no-ledger');
  if (!hasReplies(p) && /^(context|tokens|cost)$/.test(def.category)) return reason('no-replies');
  const absent = absentField(reads);
  if (absent) return absent;
  if (item.type === 'command') return reason('no-data', t('explain.reason.commandEmpty'));
  return reason('no-data');
}

function ruleValue(v: MetricValue): string {
  if (v === null) return t('explain.value.noData');
  if (typeof v === 'boolean') return t(v ? 'explain.value.yes' : 'explain.value.no');
  return sanitizeText(String(v));
}

function sourceOff(ctx: RenderContext, metric: string): boolean {
  const need = METRIC_SPECS.get(metric)?.needs;
  if (need === 'ledger') return !ctx.data.ledger?.();
  if (need === 'limits') return !detectProvider(ctx.env).planLimits;
  return false;
}

function ruleHidden(ctx: RenderContext, d: Visibility): EmptyReason {
  const k = d.decided;
  if (!k) return reason('hidden-by-rule', t('doctor.hiddenByRule'));
  if (k.value === null && sourceOff(ctx, k.metric)) {
    const text = t('explain.reason.ruleNoSource', {
      key: k.key,
      rule: sanitizeText(k.clause),
      metric: sanitizeText(k.metric),
    });
    return reason('hidden-by-rule', text);
  }
  return reason('hidden-by-rule', undefined, {
    key: k.key,
    rule: sanitizeText(k.clause),
    metric: sanitizeText(k.metric),
    value: ruleValue(k.value),
  });
}

function ruleWarning(d: Visibility): EmptyReason | null {
  if (!d.invalid) return null;
  const problem = sanitizeText(describeRuleError(d.invalid.error));
  return reason('invalid-rule', undefined, { key: d.invalid.key, problem });
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return sanitizeText(msg.split(/\r?\n/)[0] ?? '').trim();
}

export interface LimitWindowMeta {
  kind: 'limits-cache' | 'usage-cache';
  age?: number;
  origin?: LimitOrigin;
  job?: JobSource;
}

export interface InspectMeta {
  limitWindows?: Record<string, LimitWindowMeta>;
  limitModels?: string[];
  ages?: Partial<Record<'usage' | 'transcript' | 'agents' | 'ledger', number>>;
  gsdPath?: string;
  hooksInstalled?: boolean;
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

const LEGACY_MODEL: Record<string, string> = { 'weekly-sonnet-usage': 'sonnet', 'weekly-opus-usage': 'opus' };

// model windows are keyed model:<name>; the same match as modelWindow
function windowOf(path: string, item: WidgetItem, models: string[]): string | null {
  const m = /^rate_limits\.([^.[]+)/.exec(path);
  if (!m) return null;
  if (m[1] !== 'seven_day_models') return m[1]!;
  const opt = item.options?.model;
  const want = (LEGACY_MODEL[item.type] ?? (typeof opt === 'string' ? opt : '')).trim().toLowerCase();
  return models.find((k) => k.slice(k.indexOf(':') + 1).includes(want)) ?? null;
}

export function sourcesFor(
  def: WidgetDef,
  item: WidgetItem,
  reads: TraceRead[],
  meta: InspectMeta = {},
): Source[] {
  return uniq(def.sources ? hinted(def.sources) : toSources(item, reads, meta));
}

function uniq(raw: Source[]): Source[] {
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
  const windows = meta.limitWindows ?? {};
  const out: Source[] = [];
  for (const r of leaves(reads)) {
    if (r.absent) continue;
    switch (r.kind) {
      case 'payload': {
        const w = r.path ? windowOf(r.path, item, meta.limitModels ?? []) : null;
        const lw = w && Object.hasOwn(windows, w) ? windows[w] : undefined;
        if (lw) {
          const age = lw.age ?? (lw.kind === 'usage-cache' ? ages.usage : undefined);
          out.push({
            kind: lw.kind,
            path: r.path!,
            ...(age !== undefined ? { age } : {}),
            ...(lw.kind === 'limits-cache' && lw.origin ? { origin: lw.origin } : {}),
            ...(lw.kind === 'usage-cache' && lw.job ? { job: { ...lw.job } } : {}),
          });
        } else out.push({ kind: 'payload', ...(r.path ? { path: r.path } : {}) });
        break;
      }
      case 'transcript':
      case 'agents':
      case 'ledger': {
        const age = ages[r.kind];
        out.push({ kind: r.kind, ...(age !== undefined ? { age } : {}) });
        break;
      }
      case 'job':
        out.push({
          kind: 'job',
          ...(r.path ? { path: r.path } : {}),
          ...(r.age !== undefined ? { age: r.age } : {}),
          ...(r.job ? { job: { ...r.job } } : {}),
        });
        break;
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
  if (def.category !== 'layout') row.priority = effectivePriority(item, def);
  const base = item.type === 'command' && opts.commandEnv ? { ...traced, env: opts.commandEnv } : traced;
  // own data object, so the metric memo records this item's reads too (IN-02)
  const wctx = trace.forWidget({ ...base, data: { ...base.data } });
  let ruleReads: TraceRead[] = [];
  let warning: EmptyReason | null = null;
  if (hasItemRules(item)) {
    trace.begin();
    const d = ruleDecision(wctx, item);
    ruleReads = trace.end();
    warning = ruleWarning(d);
    if (!d.visible) {
      const sources = uniq(toSources(item, ruleReads, opts.meta ?? {}));
      return {
        ...row,
        status: 'hidden',
        sources,
        empty: ruleHidden(wctx, d),
        ...(warning ? { warning } : {}),
      };
    }
  }
  const warned = (r: InspectRow): InspectRow => (warning ? { ...r, warning } : r);
  let result: WidgetResult;
  trace.begin();
  try {
    result = def.render(wctx, item);
  } catch (e) {
    trace.end();
    return warned({ ...row, status: 'error', error: firstLine(e), empty: reason('error') });
  }
  const reads = trace.end();
  const sources = sourcesFor(def, item, [...ruleReads, ...reads], opts.meta);
  const out = normalizeResult(def, result, ctx.glyphMode);
  if (out) {
    const shown: InspectRow = {
      ...row,
      status: isLoadingOutput(result) ? 'loading' : 'shown',
      value: stripAnsi(out.text),
      sources,
    };
    const note = shownNote(ctx, item);
    const ci = item.type === 'pr' ? ciEmpty(ctx, item) : null;
    return warned({ ...shown, ...(note ? { note } : {}), ...(ci ? { ci } : {}) });
  }
  if (!item.hideEmpty && hiddenByWorkspace(ctx, def)) {
    return warned({ ...row, status: 'hidden', sources, empty: reason('workspace-mode') });
  }
  const status = hidesWhenEmpty(def, item) || def.category === 'layout' ? 'hidden' : 'empty';
  const empty = emptyReason(ctx, item, def.sources ? undefined : reads, opts.meta);
  return warned({ ...row, status, sources, empty });
}

// the payload has no mcp status yet
function shownNote(ctx: RenderContext, item: WidgetItem): EmptyReason | null {
  if (item.type === 'http') {
    const s = httpState(ctx, item);
    if (s.kind !== 'ok' || !s.error) return null;
    return reason('job-error', t('explain.reason.httpLastGood', { error: sanitizeText(s.error) }));
  }
  if (item.type !== 'env-counts' || item.options?.mcpHealth !== true) return null;
  return ctx.data.environment?.()?.mcpHealth ? null : reason('no-mcp-health');
}

// measure and fold like render()
function inMode<T>(base: RenderContext, fn: (ctx: RenderContext) => T): T {
  const glyphMode = base.glyphMode ?? resolveGlyphMode(base.config, base.env);
  const lang = base.config.language;
  const prevLang = isLanguageId(lang) ? setLanguage(lang) : null;
  const prev = setWidthMode(widthModeFor(glyphMode, base.config.ambiguousWidth));
  try {
    return fn({ ...base, glyphMode });
  } finally {
    setWidthMode(prev);
    if (prevLang) setLanguage(prevLang);
  }
}

export function inspectRows(base: RenderContext, opts: InspectOptions = {}): InspectRow[] {
  return inMode(base, (ctx) => inspectAll(ctx, opts));
}

function inspectAll(base: RenderContext, opts: InspectOptions): InspectRow[] {
  const ctx = withWorkspace(base);
  const trace = createTrace();
  const traced = trace.wrap(ctx);
  const out: InspectRow[] = [];
  const dctx = opts.commandEnv ? { ...ctx, env: opts.commandEnv } : ctx;
  ctx.config.lines.forEach((items, line) => {
    const drop = dropReport(dctx, items);
    items.forEach((item, index) => {
      const row = inspectItem(ctx, traced, trace, item, line, index, opts);
      out.push(drop?.dropped.includes(item.id) ? dropped(row, drop.width) : row);
    });
  });
  return out;
}

function dropReport(ctx: RenderContext, items: WidgetItem[]): LineReport | null {
  if (overflowOf(ctx.config) !== 'priority' || maxLineWidth(ctx) === null) return null;
  const a = resolveAppearance(ctx.config, ctx.theme, ctx.env);
  if (a.style === 'tui') return null;
  const report: LineReport = { dropped: [], width: null };
  renderLine(ctx, items, 0, a, report);
  return report;
}

const dropped = (row: InspectRow, width: number | null): InspectRow => ({
  ...row,
  status: 'hidden',
  empty: reason('dropped-by-priority', undefined, { width: String(width) }),
});

export function sessionNotes(p: StatusPayload): string[] {
  const notes: string[] = [];
  const full = (['five_hour', 'seven_day'] as const).filter(
    (k) => (p.rate_limits?.[k]?.used_percentage ?? 0) >= 100,
  );
  if (full.length) {
    const names = t(full.length > 1 ? 'doctor.limit.both' : `doctor.limit.${full[0]!}`);
    notes.push(t('doctor.note.limitFull', { names }));
  }
  if (!hasReplies(p)) notes.push(t('doctor.note.noReplies'));
  return notes;
}

const withWorkspace = (ctx: RenderContext): RenderContext =>
  workspaceMode(ctx) ? { ...ctx, workspaceMode: true } : ctx;

export function lineReport(base: RenderContext): LineRow[] {
  return inMode(base, lineRows);
}

function lineRows(base: RenderContext): LineRow[] {
  const ctx = withWorkspace(base);
  const a = resolveAppearance(ctx.config);
  if (a.style === 'tui') return [];
  const max = maxLineWidth(ctx);
  // one render per line (WR-08)
  return ctx.config.lines.map((items, line) => {
    const report: LineReport = { dropped: [], width: null };
    renderLine(ctx, items, 0, a, report);
    const width = report.natural ?? 0;
    const over = max !== null && width > max;
    const cut = report.truncated === true;
    const mode = overflowOf(ctx.config);
    return {
      line,
      width,
      max,
      cut,
      ...(cut && mode !== 'truncate' ? { overflow: mode as 'wrap' | 'priority' } : {}),
      ...(over && report.dropped.length ? { dropped: report.dropped } : {}),
    };
  });
}
