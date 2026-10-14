import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import type { LoadResult } from '../core/config.js';
import { createContext } from '../core/context.js';
import { t } from '../core/i18n/index.js';
import {
  type InspectMeta,
  type InspectRow,
  inspectRows,
  type LineRow,
  lineReport,
  type Source,
} from '../core/inspect.js';
import { loadForUse } from '../core/load.js';
import { lastPayloadPath, tildify } from '../core/paths.js';
import { ingestPayload } from '../core/payload.js';
import { readLastPayload, scenarioFlag, scenarioListLines } from '../core/preview.js';
import {
  sampleAgents,
  sampleGit,
  sampleGsd,
  sampleHistory,
  samplePayload,
  sampleTranscript,
} from '../core/sample.js';
import { sanitizeText } from '../core/sanitize.js';
import { getScenario, SCENARIO_NOW, scenarioEnv } from '../core/scenarios.js';
import type { Config, DataSources, RenderContext, StatusPayload } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { agentsCacheName, readAgents } from '../data/agents.js';
import { cacheFile } from '../data/cache.js';
import { loadHistory } from '../data/history.js';
import { readTranscript, type TranscriptInfo, transcriptCacheName } from '../data/transcript.js';
import { effectiveUsage, type UsageCache } from '../data/usage.js';
import { getWidget } from '../widgets/index.js';

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

export interface InspectOptions {
  cfgFile: string;
  payloadFile?: string;
  scenario?: string;
  width?: number;
  fallback: 'sample' | 'none';
  env?: NodeJS.ProcessEnv;
  loaded?: LoadResult;
}

export class PayloadFileError extends Error {}

function once<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      try {
        value = fn();
      } catch {
        value = null as T;
      }
      done = true;
    }
    return value;
  };
}

function probeFreeWidth(opts: InspectOptions, payload: StatusPayload, env: NodeJS.ProcessEnv): number | null {
  if (opts.width && opts.width > 0) return opts.width;
  const hint = payload.terminal_width ?? payload.columns;
  if (typeof hint === 'number' && hint > 0) return hint;
  const cols = Number(env.COLUMNS);
  if (Number.isFinite(cols) && cols > 0) return cols;
  if (process.stdout.isTTY && process.stdout.columns > 0) return process.stdout.columns;
  return null;
}

function readOnlyData(payload: StatusPayload, env: NodeJS.ProcessEnv, now: number): Partial<DataSources> {
  const transcript = once<TranscriptInfo | null>(() =>
    readTranscript(payload.transcript_path, env, { persist: false }),
  );
  return {
    transcript,
    agents: once(() => readAgents(payload.transcript_path, transcript(), now, env, { persist: false })),
    history: () => loadHistory(payload.session_id, env),
  };
}

function sampleData(now: number): DataSources {
  return {
    git: sampleGit,
    gsd: sampleGsd,
    transcript: () => sampleTranscript(now),
    history: () => sampleHistory(now),
    agents: () => sampleAgents(now),
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

function lastAge(): number | undefined {
  try {
    return Math.max(0, Date.now() - fs.statSync(lastPayloadPath()).mtimeMs);
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

function sourceMeta(
  config: Config,
  ctx: RenderContext,
  raw: StatusPayload,
  usage: UsageCache | null,
  env: NodeJS.ProcessEnv,
  live: boolean,
): InspectMeta {
  const meta: InspectMeta = {};
  const now = Date.now();
  const ages: NonNullable<InspectMeta['ages']> = {};
  if (usage?.rate_limits && ctx.payload !== raw) {
    const own = (raw.rate_limits ?? {}) as Record<string, unknown>;
    meta.usageWindows = Object.keys(usage.rate_limits).filter((k) => own[k] === undefined);
    ages.usage = Math.max(0, now - usage.fetchedAt);
  }
  const tp = raw.transcript_path;
  if (live && typeof tp === 'string' && tp) {
    const tAge = mtimeAge(cacheFile(transcriptCacheName(tp), env), now);
    if (tAge !== undefined) ages.transcript = tAge;
    const aAge = agentsAge(tp, env, now);
    if (aAge !== undefined) ages.agents = aAge;
  }
  if (Object.keys(ages).length) meta.ages = ages;
  if (config.lines.some((items) => items.some((i) => getWidget(i.type)?.category === 'gsd'))) {
    const g = ctx.data.gsd();
    if (g) {
      const rel = path.relative(g.projectDir, path.join(g.planningDir, 'STATE.md')).replace(/\\/g, '/');
      meta.gsdPath = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '.planning/STATE.md';
    }
  }
  return meta;
}

export function loadInspectInput(opts: InspectOptions): InspectInput | null {
  const baseEnv = opts.env ?? process.env;
  const loaded = opts.loaded ?? loadForUse(opts.cfgFile);
  const config = loaded.config;
  let env = baseEnv;
  let now = new Date();
  let input: InspectInput['input'];
  let payload: StatusPayload;
  let data: Partial<DataSources>;
  const scenario = opts.scenario ? getScenario(opts.scenario) : null;
  const last = opts.payloadFile || scenario ? null : readLastPayload();
  if (opts.payloadFile) {
    payload = readPayloadFile(opts.payloadFile);
    input = { kind: 'payload', name: opts.payloadFile };
    data = readOnlyData(payload, env, now.getTime());
  } else if (scenario) {
    const bundle = scenario.build(SCENARIO_NOW);
    payload = bundle.payload;
    env = scenarioEnv(baseEnv, bundle.env);
    now = new Date(SCENARIO_NOW);
    input = { kind: 'scenario', name: scenario.id };
    data = bundle.data;
  } else if (last) {
    payload = last;
    const ageMs = lastAge();
    input = {
      kind: 'last',
      ...(ageMs !== undefined ? { ageMs } : {}),
      ...(typeof last.version === 'string' ? { claudeCode: last.version } : {}),
    };
    data = readOnlyData(payload, env, now.getTime());
  } else {
    if (opts.fallback === 'none') return null;
    payload = samplePayload(now.getTime());
    input = { kind: 'sample' };
    data = sampleData(now.getTime());
  }
  const live = input.kind === 'payload' || input.kind === 'last';
  const { usage, payload: shown } = live ? effectiveUsage(config, payload, env) : { usage: null, payload };
  const width = probeFreeWidth(opts, payload, env);
  const ctx = createContext({
    payload: shown,
    config: { ...config, colorLevel: 0 },
    env,
    now,
    terminalWidth: width,
    data,
  });
  const meta = sourceMeta(config, ctx, payload, usage, env, live);
  let tmp: string | null = null;
  if (config.lines.some((items) => items.some((i) => i.type === 'command'))) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-explain-'));
  }
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

export interface ExplainIo {
  tty: boolean;
  log(line: string): void;
  error(line: string): void;
}

export function explainIo(): ExplainIo {
  return {
    tty: !!process.stdout.isTTY,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
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
    case 'usage-cache':
    case 'transcript':
    case 'agents':
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
      })),
      empty: r.empty ? { code: r.empty.code, text: r.empty.text } : null,
      error: r.error,
    })),
    lines: lines.map((l) => ({ line: l.line, width: l.width, max: l.max, cut: l.cut })),
  });
}

function reportConfigIssue(loaded: LoadResult, io: ExplainIo): boolean {
  if (!loaded.issue) return false;
  const { line, column, message } = loaded.issue;
  io.error(
    t('config.issue', {
      file: sanitizeText(tildify(loaded.path)),
      line,
      column,
      message: sanitizeText(message),
    }),
  );
  io.error(t('explain.runDoctor'));
  process.exitCode = 1;
  return true;
}

export function runExplain(args: Args, cfgFile: string, io: ExplainIo = explainIo()): void {
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
  const loaded = loadForUse(cfgFile);
  if (reportConfigIssue(loaded, io)) return;
  const widthFlag = typeof args.flags.width === 'string' ? Number(args.flags.width) : undefined;
  let data: InspectInput | null;
  try {
    data = loadInspectInput({
      cfgFile,
      loaded,
      ...(typeof args.flags.payload === 'string' ? { payloadFile: args.flags.payload } : {}),
      ...(flag.kind === 'scenario' ? { scenario: flag.id } : {}),
      ...(widthFlag && Number.isFinite(widthFlag) ? { width: widthFlag } : {}),
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
  io: ExplainIo,
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
