import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import type { LoadResult } from '../core/config.js';
import { createContext, lazy, resolveCwd } from '../core/context.js';
import { t } from '../core/i18n/index.js';
import {
  type InspectMeta,
  type InspectRow,
  inspectRows,
  type LimitWindowMeta,
  type LineRow,
  lineReport,
  type Source,
} from '../core/inspect.js';
import { loadForUse } from '../core/load.js';
import { claudeSettingsPath, lastPayloadPath, tildify } from '../core/paths.js';
import { ingestPayload } from '../core/payload.js';
import { readLastPayload, scenarioFlag, scenarioListLines } from '../core/preview.js';
import {
  sampleAgents,
  sampleGit,
  sampleGsd,
  sampleHistory,
  sampleHooks,
  sampleLedger,
  sampleLimits,
  samplePayload,
  sampleTranscript,
} from '../core/sample.js';
import { sanitizeText } from '../core/sanitize.js';
import { getScenario, SCENARIO_NOW, scenarioConfig, scenarioEnv } from '../core/scenarios.js';
import type { Config, DataSources, RenderContext, StatusPayload } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { agentsCacheName, readAgents } from '../data/agents.js';
import { cacheFile } from '../data/cache.js';
import { loadHistory } from '../data/history.js';
import { readHookState } from '../data/hooks.js';
import { ledgerOn, ledgerView, projectRoot, readLedger } from '../data/ledger.js';
import { accountKey, type LimitsView, modelKey, readLimitsStore } from '../data/limits.js';
import { hookTurnStart } from '../data/live.js';
import { readRepos } from '../data/repos.js';
import { readTranscript, type TranscriptInfo, transcriptCacheName } from '../data/transcript.js';
import { effectiveUsage, type UsageCache } from '../data/usage.js';
import { getWidget } from '../widgets/index.js';
import { type CliIo, cliIo, reportConfigIssue } from './io.js';
import { findHookEntries, readManifest } from './manifest.js';

export type InputKind = 'payload' | 'scenario' | 'last' | 'sample';

export interface InspectInput {
  loaded: LoadResult;
  config: Config;
  input: { kind: InputKind; name?: string; ageMs?: number; claudeCode?: string };
  raw: StatusPayload;
  payload: StatusPayload;
  usage: UsageCache | null;
  width: number | null;
  ctx: RenderContext;
  meta: InspectMeta;
  commandEnv?: NodeJS.ProcessEnv;
  cleanup(): void;
}

export interface LoadOptions {
  cfgFile: string;
  payloadFile?: string;
  scenario?: string;
  width?: number;
  widthOf?: (payload: StatusPayload) => number | null;
  fallback: 'sample' | 'none';
  env?: NodeJS.ProcessEnv;
  loaded?: LoadResult;
}

export class PayloadFileError extends Error {}

function probeFreeWidth(opts: LoadOptions, payload: StatusPayload, env: NodeJS.ProcessEnv): number | null {
  if (opts.width && opts.width > 0) return opts.width;
  if (opts.widthOf) return opts.widthOf(payload);
  const hint = payload.terminal_width ?? payload.columns;
  if (typeof hint === 'number' && hint > 0) return hint;
  const cols = Number(env.COLUMNS);
  if (Number.isFinite(cols) && cols > 0) return cols;
  if (process.stdout.isTTY && process.stdout.columns > 0) return process.stdout.columns;
  return null;
}

function readOnlyData(
  config: Config,
  payload: StatusPayload,
  env: NodeJS.ProcessEnv,
  now: number,
): Partial<DataSources> {
  const transcript = lazy<TranscriptInfo | null>(() =>
    readTranscript(payload.transcript_path, env, { persist: false }),
  );
  const hooks = lazy(() =>
    payload.session_id ? readHookState(payload.session_id, env, { persist: false }) : null,
  );
  const agents = lazy(() => {
    const h = hooks();
    const t = transcript();
    const turnStart = hookTurnStart(h, t, payload.prompt_id, now);
    return readAgents(payload.transcript_path, t, now, env, { persist: false, hooks: h, turnStart });
  });
  const data: Partial<DataSources> = {
    transcript,
    agents,
    history: () => loadHistory(payload.session_id, env),
    repos: lazy(() => readRepos(resolveCwd(payload), env, { persist: false, now })),
    hooks,
  };
  if (ledgerOn(config)) {
    data.ledger = lazy(() => {
      const read = readLedger(env, now, { persist: false });
      return ledgerView(read.summary, accountKey(env), projectRoot(payload), now, {
        session: payload.session_id,
        c: payload.cost?.total_cost_usd,
      });
    });
  }
  return data;
}

function sampleData(now: number, payload: StatusPayload): DataSources {
  return {
    git: sampleGit,
    gsd: sampleGsd,
    transcript: () => sampleTranscript(now),
    history: () => sampleHistory(now),
    agents: () => sampleAgents(now),
    limits: () => sampleLimits(now, payload.rate_limits ?? null),
    ledger: () => sampleLedger(now),
    repos: () => null,
    hooks: () => sampleHooks(now),
  };
}

function readPayloadFile(file: string): StatusPayload {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new PayloadFileError(t('explain.payloadUnreadable', { file: sanitizeText(tildify(file)) }));
  }
  const payload = ingestPayload(raw);
  if (!payload)
    throw new PayloadFileError(t('explain.payloadInvalid', { file: sanitizeText(tildify(file)) }));
  return payload;
}

function lastAge(env: NodeJS.ProcessEnv): number | undefined {
  try {
    return Math.max(0, Date.now() - fs.statSync(lastPayloadPath(env)).mtimeMs);
  } catch {
    return undefined;
  }
}

function mtimeAge(file: string, now: number): number | undefined {
  try {
    return Math.max(0, now - fs.statSync(file).mtimeMs);
  } catch {
    return undefined;
  }
}

function agentsAge(transcriptPath: string, env: NodeJS.ProcessEnv, now: number): number | undefined {
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  const ages = files
    .map((f) => mtimeAge(cacheFile(agentsCacheName(path.join(dir, f)), env), now))
    .filter((a): a is number => a !== undefined);
  return ages.length ? Math.min(...ages) : undefined;
}

// winner of each limits window, when not this session's payload
function limitWindows(
  view: LimitsView | null,
  usage: UsageCache | null,
  env: NodeJS.ProcessEnv,
  now: number,
): Record<string, LimitWindowMeta> {
  const out: Record<string, LimitWindowMeta> = Object.create(null);
  if (!view) return out;
  const wins = Object.entries(view.windows);
  const store = wins.some(([, w]) => w.source === 'limits-cache') ? readLimitsStore(env) : null;
  for (const [key, w] of wins) {
    if (w.source === 'limits-cache') {
      const src = store?.windows[key]?.src;
      out[key] = {
        kind: 'limits-cache',
        ...(w.at !== null ? { age: Math.max(0, now - w.at) } : {}),
        ...(src ? { origin: src === 'usage-api' ? 'usage-api' : 'session' } : {}),
      };
    } else if (w.source === 'usage-api') {
      out[key] = {
        kind: 'usage-cache',
        ...(usage ? { age: Math.max(0, now - usage.fetchedAt) } : {}),
      };
    }
  }
  return out;
}

function sourceMeta(
  config: Config,
  ctx: RenderContext,
  raw: StatusPayload,
  usage: UsageCache | null,
  limits: LimitsView | null,
  env: NodeJS.ProcessEnv,
  live: boolean,
): InspectMeta {
  const meta: InspectMeta = {};
  const now = Date.now();
  const ages: NonNullable<InspectMeta['ages']> = {};
  if (usage?.rate_limits && ctx.payload !== raw) ages.usage = Math.max(0, now - usage.fetchedAt);
  const windows = live ? limitWindows(limits, usage, env, now) : {};
  if (Object.keys(windows).length) meta.limitWindows = windows;
  const models = (ctx.payload.rate_limits?.seven_day_models ?? [])
    .map((m) => modelKey(m?.model)?.key)
    .filter((k): k is string => !!k);
  if (live && models.length) meta.limitModels = models;
  const tp = raw.transcript_path;
  if (live && typeof tp === 'string' && tp) {
    const tAge = mtimeAge(cacheFile(transcriptCacheName(tp), env), now);
    if (tAge !== undefined) ages.transcript = tAge;
    const aAge = agentsAge(tp, env, now);
    if (aAge !== undefined) ages.agents = aAge;
  }
  if (ledgerOn(config)) {
    const at = ctx.data.ledger?.()?.at;
    if (typeof at === 'number') ages.ledger = Math.max(0, ctx.now.getTime() - at);
  }
  if (Object.keys(ages).length) meta.ages = ages;
  if (config.lines.some((items) => items.some((i) => i.type === 'permission-wait')))
    meta.hooksInstalled = findHookEntries(readManifest(env), claudeSettingsPath(env)).length > 0;
  if (config.lines.some((items) => items.some((i) => getWidget(i.type)?.category === 'gsd'))) {
    const g = ctx.data.gsd();
    if (g) {
      const rel = path.relative(g.projectDir, path.join(g.planningDir, 'STATE.md')).replace(/\\/g, '/');
      meta.gsdPath = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '.planning/STATE.md';
    }
  }
  return meta;
}

export function loadInspectInput(opts: LoadOptions): InspectInput | null {
  const baseEnv = opts.env ?? process.env;
  const loaded = opts.loaded ?? loadForUse(opts.cfgFile);
  let config = loaded.config;
  let env = baseEnv;
  let now = new Date();
  let input: InspectInput['input'];
  let payload: StatusPayload;
  let data: Partial<DataSources>;
  const scenario = opts.scenario ? getScenario(opts.scenario) : null;
  const last = opts.payloadFile || scenario ? null : readLastPayload(baseEnv);
  if (opts.payloadFile) {
    payload = readPayloadFile(opts.payloadFile);
    input = { kind: 'payload', name: opts.payloadFile };
    data = readOnlyData(config, payload, env, now.getTime());
  } else if (scenario) {
    const bundle = scenario.build(SCENARIO_NOW);
    config = scenarioConfig(config, bundle);
    payload = bundle.payload;
    env = scenarioEnv(baseEnv, bundle.env);
    now = new Date(SCENARIO_NOW);
    input = { kind: 'scenario', name: scenario.id };
    data = bundle.data;
  } else if (last) {
    payload = last;
    const ageMs = lastAge(baseEnv);
    input = {
      kind: 'last',
      ...(ageMs !== undefined ? { ageMs } : {}),
      ...(typeof last.version === 'string' ? { claudeCode: last.version } : {}),
    };
    data = readOnlyData(config, payload, env, now.getTime());
  } else {
    if (opts.fallback === 'none') return null;
    payload = samplePayload(now.getTime());
    input = { kind: 'sample' };
    data = sampleData(now.getTime(), payload);
  }
  const live = input.kind === 'payload' || input.kind === 'last';
  const eff = live ? effectiveUsage(config, payload, env, { transcript: data.transcript }) : null;
  const usage = eff?.usage ?? null;
  const shown = eff?.payload ?? payload;
  if (eff) {
    const view = eff.limits;
    data = { ...data, limits: () => view };
  }
  const width = probeFreeWidth(opts, payload, env);
  let tmp: string | null = null;
  let lines = config.lines;
  if (config.lines.some((items) => items.some((i) => i.type === 'command'))) {
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-explain-'));
    } catch {
      lines = config.lines.map((items) =>
        items.map((i) => (i.type === 'command' ? { ...i, options: { ...i.options, cacheSeconds: 0 } } : i)),
      );
    }
  }
  const ctx = createContext({
    payload: shown,
    config: { ...config, colorLevel: 0, lines },
    env,
    now,
    terminalWidth: width,
    data,
  });
  const meta = sourceMeta(config, ctx, payload, usage, eff?.limits ?? null, env, live);
  return {
    loaded,
    config,
    input,
    raw: payload,
    payload: shown,
    usage,
    width,
    ctx,
    meta,
    ...(tmp ? { commandEnv: { ...env, CCINFOBAR_CACHE_DIR: tmp } } : {}),
    cleanup() {
      if (!tmp) return;
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {}
      tmp = null;
    },
  };
}

export function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('explain.age.seconds', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('explain.age.minutes', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('explain.age.hours', { n: h });
  return t('explain.age.days', { n: Math.round(h / 24) });
}

export function shortAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('explain.ageShort.seconds', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('explain.ageShort.minutes', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('explain.ageShort.hours', { n: h });
  return t('explain.ageShort.days', { n: Math.round(h / 24) });
}

export function sourceText(src: Source): string {
  const path = sanitizeText(src.path ?? '');
  switch (src.kind) {
    case 'limits-cache':
      return src.age === undefined || !src.origin
        ? t('explain.source.limits-cache')
        : t('explain.source.limits-cache.age', {
            age: shortAge(src.age),
            origin: t(`explain.source.origin.${src.origin}`),
          });
    case 'usage-cache':
    case 'transcript':
    case 'agents':
    case 'ledger':
      return src.age === undefined
        ? t(`explain.source.${src.kind}`)
        : t(`explain.source.${src.kind}.age`, { age: shortAge(src.age) });
    case 'payload':
    case 'env':
    case 'config':
      return path ? t(`explain.source.${src.kind}`, { path }) : src.kind;
    case 'gsd':
      return t('explain.source.gsd', { path: path || '.planning/STATE.md' });
    default:
      return t(`explain.source.${src.kind}`);
  }
}

function sourcesSuffix(r: InspectRow): string {
  if (!r.sources.length) return '';
  const list = [...new Set(r.sources.map(sourceText))].join(', ');
  return t('explain.sources', { sources: list });
}

function inputLine(input: InspectInput['input']): string {
  const s = (v: string) => sanitizeText(v);
  switch (input.kind) {
    case 'last':
      return t('explain.input.last', {
        claudeCode: s(input.claudeCode ?? t('explain.unknownVersion')),
        age: input.ageMs === undefined ? t('explain.age.unknown') : formatAge(input.ageMs),
      });
    case 'scenario':
      return t('explain.input.scenario', { name: s(input.name ?? '') });
    case 'payload':
      return t('explain.input.payload', { file: s(tildify(input.name ?? '')) });
    default:
      return t('explain.sampleNotice');
  }
}

export function rowLine(r: InspectRow): string {
  const line = statusLine(r);
  return r.status === 'error' || r.status === 'skipped' ? line : line + sourcesSuffix(r);
}

function statusLine(r: InspectRow): string {
  const id = sanitizeText(r.id);
  const type = sanitizeText(r.type);
  const name = id === type ? type : `${id} (${type})`;
  const value = sanitizeText(r.value ?? '');
  const reason = sanitizeText(r.empty?.text ?? '');
  switch (r.status) {
    case 'shown':
      return t('explain.row.shown', { name, value });
    case 'loading':
      return t('explain.row.loading', { name, value });
    case 'hidden':
      return t('explain.row.hidden', { name, reason });
    case 'error':
      return t('explain.row.error', { name, error: sanitizeText(r.error ?? '') });
    case 'skipped':
      return t('explain.row.skipped', { name });
    default:
      return t('explain.row.empty', { name, reason });
  }
}

const REDACT = new Set(['env', 'command']);

export function redactValue(r: InspectRow): string | null {
  return r.value !== null && REDACT.has(r.type) ? t('explain.redacted', { n: r.value.length }) : r.value;
}

function clean<T>(v: T): T {
  if (typeof v === 'string') return sanitizeText(v) as T;
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [sanitizeText(k), clean(x)])) as T;
  return v;
}

export interface ExplainJson {
  schema: 1;
  version: string;
  input: { kind: InputKind; name?: string; ageMs?: number; claudeCode?: string };
  width: number | null;
  widgets: InspectRow[];
  lines: LineRow[];
}

export function explainJson(
  input: InspectInput['input'],
  rows: InspectRow[],
  lines: LineRow[],
  width: number | null,
): ExplainJson {
  return clean({
    schema: 1,
    version: VERSION,
    input: {
      kind: input.kind,
      ...(input.kind === 'scenario' && input.name ? { name: input.name } : {}),
      ...(input.ageMs !== undefined ? { ageMs: Math.round(input.ageMs) } : {}),
      ...(input.claudeCode !== undefined ? { claudeCode: input.claudeCode } : {}),
    },
    width,
    widgets: rows.map((r) => ({
      line: r.line,
      index: r.index,
      id: r.id,
      type: r.type,
      status: r.status,
      value: redactValue(r),
      sources: r.sources.map((s) => ({
        kind: s.kind,
        ...(s.path !== undefined ? { path: s.path } : {}),
        ...(s.age !== undefined ? { age: Math.round(s.age) } : {}),
        ...(s.origin !== undefined ? { origin: s.origin } : {}),
      })),
      empty: r.empty ? { code: r.empty.code, text: r.empty.text } : null,
      error: r.error,
    })),
    lines: lines.map((l) => ({ line: l.line, width: l.width, max: l.max, cut: l.cut })),
  });
}

export function runExplain(args: Args, cfgFile: string, io: CliIo = cliIo()): void {
  const flag = scenarioFlag(args.flags.scenario);
  if (flag.kind === 'list') {
    for (const l of scenarioListLines()) io.log(l);
    return;
  }
  if (flag.kind === 'unknown') {
    io.error(t('preview.unknownScenario', { name: sanitizeText(flag.name) }));
    for (const l of scenarioListLines().slice(1)) io.error(l);
    process.exitCode = 1;
    return;
  }
  const w = args.flags.width;
  const widthFlag =
    typeof w === 'string' && w.trim() ? Number(w) : w === undefined || w === false ? undefined : Number.NaN;
  const badFlag =
    args.flags.payload === true
      ? t('explain.payloadMissing')
      : widthFlag !== undefined && !(Number.isFinite(widthFlag) && widthFlag > 0)
        ? t('explain.badWidth')
        : null;
  if (badFlag) {
    io.error(badFlag);
    process.exitCode = 1;
    return;
  }
  if (flag.kind === 'scenario' && args.flags.payload !== undefined && args.flags.payload !== false) {
    io.error(t('explain.scenarioWithPayload'));
    process.exitCode = 1;
    return;
  }
  const loaded = loadForUse(cfgFile);
  if (reportConfigIssue(loaded, io)) {
    process.exitCode = 1;
    return;
  }
  let data: InspectInput | null;
  try {
    data = loadInspectInput({
      cfgFile,
      loaded,
      ...(typeof args.flags.payload === 'string' ? { payloadFile: args.flags.payload } : {}),
      ...(flag.kind === 'scenario' ? { scenario: flag.id } : {}),
      ...(widthFlag !== undefined ? { width: widthFlag } : {}),
      fallback: 'sample',
    });
  } catch (e) {
    if (!(e instanceof PayloadFileError)) throw e;
    io.error(e.message);
    process.exitCode = 1;
    return;
  }
  if (!data) return;
  const json = args.flags.json === true;
  const show = args.flags['show-values'] === true;
  if (show && (json || !io.tty)) io.error(t('explain.showValuesTty'));
  try {
    printExplain(data, io, args.positional[0], json, show && !json && io.tty);
  } finally {
    data.cleanup();
  }
}

function pick(rows: InspectRow[], id: string): InspectRow[] {
  const byId = rows.filter((r) => r.id === id);
  return byId.length ? byId : rows.filter((r) => r.type === id);
}

function maskOptions(type: string, options: Record<string, unknown>): Record<string, unknown> {
  const spec = getWidget(type)?.options ?? [];
  return Object.fromEntries(
    Object.entries(options).map(([k, v]) => {
      const kind = spec.find((o) => o.key === k)?.kind;
      const text = kind === 'text' || (kind === undefined && typeof v === 'string');
      return [k, text ? t('explain.maskedOption', { n: String(v).length }) : v];
    }),
  );
}

function detailLines(data: InspectInput, r: InspectRow, reveal: boolean): string[] {
  const none = t('explain.detail.none');
  const s = (v: string) => sanitizeText(v);
  const id = s(r.id);
  const type = s(r.type);
  const options = data.config.lines[r.line]?.[r.index]?.options;
  const sources = [...new Set(r.sources.map(sourceText))].join(', ');
  const out = [
    t('explain.detail.header', { name: id === type ? type : `${id} (${type})` }),
    t('explain.detail.line', { line: r.line + 1 }),
    t('explain.detail.index', { index: r.index }),
    t('explain.detail.id', { id }),
    t('explain.detail.type', { type }),
    t('explain.detail.status', { status: r.status }),
    t('explain.detail.value', { value: r.value === null ? none : s(r.value) }),
    t('explain.detail.sources', { sources: sources || none }),
  ];
  if (r.error !== null) out.push(t('explain.detail.error', { error: s(r.error) }));
  else if (r.empty) out.push(t('explain.detail.reason', { reason: s(r.empty.text) }));
  const opts =
    options && Object.keys(options).length
      ? JSON.stringify(clean(reveal ? options : maskOptions(r.type, options)))
      : none;
  out.push(t('explain.detail.options', { options: opts }));
  return out;
}

function printExplain(
  data: InspectInput,
  io: CliIo,
  id: string | undefined,
  json: boolean,
  reveal: boolean,
): void {
  const rows = inspectRows(data.ctx, {
    meta: data.meta,
    ...(data.commandEnv ? { commandEnv: data.commandEnv } : {}),
  });
  const lines = lineReport(data.commandEnv ? { ...data.ctx, env: data.commandEnv } : data.ctx);
  const picked = id === undefined ? rows : pick(rows, id);
  if (id !== undefined && !picked.length) {
    io.error(t('explain.noMatch', { id: sanitizeText(id) }));
    io.error(t('explain.idList', { ids: rows.map((r) => sanitizeText(r.id)).join(', ') }));
    process.exitCode = 1;
    return;
  }
  if (json) {
    io.log(JSON.stringify(explainJson(data.input, picked, lines, data.width), null, 2));
    return;
  }
  const shown = (r: InspectRow): InspectRow => (reveal ? r : { ...r, value: redactValue(r) });
  io.log(t('explain.header', { version: VERSION }));
  io.log(inputLine(data.input));
  io.log(data.width === null ? t('explain.widthUnknown') : t('explain.width', { width: data.width }));
  if (id !== undefined) {
    for (const r of picked) {
      io.log('');
      for (const l of detailLines(data, shown(r), reveal)) io.log(l);
    }
    return;
  }
  data.config.lines.forEach((_, line) => {
    io.log('');
    io.log(t('explain.lineHeader', { line: line + 1 }));
    for (const r of rows) if (r.line === line) io.log(rowLine(shown(r)));
    const l = lines[line];
    if (l?.cut) io.log(t('explain.lineCut', { line: line + 1, width: l.width, max: l.max ?? 0 }));
  });
}
