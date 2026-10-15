import fs from 'node:fs';
import path from 'node:path';
import { sanitizeText } from '../core/sanitize.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import type { HookAgent, HookState } from './hooks.js';
import type { TranscriptInfo } from './transcript.js';

export interface AgentInfo {
  id: string;
  type: string;
  description: string;
  model: string | null;
  input: number;
  output: number;
  total: number;
  fresh: number;
  start: number | null;
  last: number | null;
  tool: string | null;
  running: boolean;
}

interface Summary {
  size: number;
  model: string | null;
  input: number;
  output: number;
  total: number;
  fresh: number;
  first: number | null;
  last: number | null;
  tool: string | null;
}

const LIVE_MS = 30_000;
const LOST_MS = 15 * 60_000;
const MAX = 8;
const HOOK_AGENT_MAX_MS = 2 * 3_600_000;
const MATCH_MS = 5_000;
const RECENT_MS = 10 * 60_000;

// biome-ignore lint/suspicious/noExplicitAny: untyped JSONL
type Json = Record<string, any>;

function short(name: string, input: Json): string {
  const arg =
    input.command ??
    input.pattern ??
    input.file_path ??
    input.path ??
    input.url ??
    input.query ??
    input.description;
  if (typeof arg !== 'string' || !arg) return name;
  const one = arg.replace(/\s+/g, ' ').trim();
  return `${name}[${one.length > 48 ? `${one.slice(0, 47)}…` : one}]`;
}

function summarize(file: string, size: number): Summary {
  const s: Summary = {
    size,
    model: null,
    input: 0,
    output: 0,
    total: 0,
    fresh: 0,
    first: null,
    last: null,
    tool: null,
  };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return s;
  }
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e: Json;
    try {
      e = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
    if (!Number.isNaN(ts)) {
      s.first ??= ts;
      s.last = ts;
    }
    if (e.type !== 'assistant') continue;
    const msg = (e.message ?? {}) as Json;
    if (typeof msg.model === 'string' && msg.model !== '<synthetic>') s.model = msg.model;
    for (const b of Array.isArray(msg.content) ? (msg.content as Json[]) : []) {
      if (b?.type === 'tool_use' && typeof b.name === 'string')
        s.tool = short(b.name, (b.input ?? {}) as Json);
    }
    const key = `${msg.id ?? ''}:${e.requestId ?? ''}`;
    const u = msg.usage as Json | undefined;
    if (!u || seen.has(key)) continue;
    seen.add(key);
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    s.input += n(u.input_tokens);
    s.output += n(u.output_tokens);
    const fresh = n(u.input_tokens) + n(u.output_tokens) + n(u.cache_creation_input_tokens);
    s.fresh += fresh;
    s.total += fresh + n(u.cache_read_input_tokens);
  }
  return s;
}

export function agentsCacheName(file: string): string {
  return `agent2-${cacheKey(file)}.json`;
}

function cached(file: string, size: number, env: NodeJS.ProcessEnv, persist: boolean): Summary {
  const name = agentsCacheName(file);
  const hit = readCache<Summary>(name, env);
  if (hit && hit.size === size) return hit;
  const s = summarize(file, size);
  if (persist) writeCache(name, s, env);
  return s;
}

function metaType(meta: Json): string {
  return typeof meta.agentType === 'string' ? sanitizeText(meta.agentType) || 'agent' : 'agent';
}

function row(
  id: string,
  meta: Json,
  s: Summary,
  r: { running: boolean; start: number | null; last: number | null; type?: string },
): AgentInfo {
  return {
    id: id.replace(/^agent-/, ''),
    type: r.type ?? metaType(meta),
    description: typeof meta.description === 'string' ? sanitizeText(meta.description) : '',
    model: s.model === null ? null : sanitizeText(s.model),
    input: s.input,
    output: s.output,
    total: s.total,
    fresh: s.fresh,
    start: r.start,
    last: r.last,
    tool: s.tool === null ? null : sanitizeText(s.tool),
    running: r.running,
  };
}

function sorted(out: AgentInfo[]): AgentInfo[] {
  return out
    .sort((a, b) => Number(b.running) - Number(a.running) || (a.start ?? 0) - (b.start ?? 0))
    .slice(0, MAX);
}

// agents of the current turn, running ones first
export function readAgents(
  transcriptPath: string | undefined,
  info: TranscriptInfo | null,
  now: number,
  env: NodeJS.ProcessEnv = process.env,
  opts: { persist?: boolean; hooks?: HookState | null; turnStart?: number | null } = {},
): AgentInfo[] {
  if (opts.hooks) return hookAgents(transcriptPath, info, now, env, opts.hooks, opts);
  if (!transcriptPath) return [];
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return [];
  }
  const calls = new Map((info?.agentCalls ?? []).map((c) => [c.id, c]));
  const out: AgentInfo[] = [];
  for (const f of files) {
    const id = f.slice(0, -'.meta.json'.length);
    const jsonl = path.join(dir, `${id}.jsonl`);
    let meta: Json = {};
    let stat: fs.Stats;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Json;
      stat = fs.statSync(jsonl);
    } catch {
      continue;
    }
    const call = typeof meta.toolUseId === 'string' ? calls.get(meta.toolUseId) : undefined;
    const quiet = now - stat.mtimeMs;
    const running = call ? call.done === null && (!call.async || quiet < LOST_MS) : quiet < LIVE_MS;
    const turn = info?.turnStart ?? null;
    const recent = turn !== null ? stat.mtimeMs >= turn : now - stat.mtimeMs < RECENT_MS;
    if (!running && !recent) continue;
    const s = cached(jsonl, stat.size, env, opts.persist !== false);
    out.push(row(id, meta, s, { running, start: s.first, last: running ? now : s.last }));
  }
  return sorted(out);
}

interface MetaFile {
  id: string;
  jsonl: string;
  meta: Json;
  stat: fs.Stats;
  s?: Summary;
}

const hookRunning = (h: HookAgent, now: number) =>
  h.start !== null && h.end === null && now - h.start < HOOK_AGENT_MAX_MS;

// hook paths are only compared by name, never opened
function hookName(p: string | null): string {
  return p ? path.basename(p.replace(/\\/g, '/')) : '';
}

function hookAgents(
  transcriptPath: string | undefined,
  info: TranscriptInfo | null,
  now: number,
  env: NodeJS.ProcessEnv,
  hooks: HookState,
  opts: { persist?: boolean; turnStart?: number | null },
): AgentInfo[] {
  const persist = opts.persist !== false;
  const metas: MetaFile[] = [];
  if (transcriptPath) {
    const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
    } catch {}
    for (const f of files) {
      const id = f.slice(0, -'.meta.json'.length);
      const jsonl = path.join(dir, `${id}.jsonl`);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Json;
        metas.push({
          id,
          jsonl,
          meta: meta && typeof meta === 'object' ? meta : {},
          stat: fs.statSync(jsonl),
        });
      } catch {}
    }
  }
  const keys = Object.keys(hooks.agents);
  const used = new Set<string>();
  const match = new Map<MetaFile, HookAgent>();
  const claim = (m: MetaFile, k: string) => {
    used.add(k);
    match.set(m, hooks.agents[k]!);
  };
  for (const m of metas) {
    const k = m.id.replace(/^agent-/, '');
    if (Object.hasOwn(hooks.agents, k)) claim(m, k);
  }
  for (const m of metas) {
    if (match.has(m)) continue;
    const k = keys.find((x) => !used.has(x) && hookName(hooks.agents[x]!.transcript) === `${m.id}.jsonl`);
    if (k !== undefined) claim(m, k);
  }
  for (const m of metas) {
    if (match.has(m) || typeof m.meta.agentType !== 'string') continue;
    const type = m.meta.agentType;
    const open = keys.filter(
      (x) => !used.has(x) && hooks.agents[x]!.type === type && hooks.agents[x]!.start !== null,
    );
    if (!open.length) continue;
    m.s = cached(m.jsonl, m.stat.size, env, persist);
    const first = m.s.first;
    if (first === null) continue;
    let best: string | undefined;
    let gap = MATCH_MS + 1;
    for (const x of open) {
      const d = Math.abs(hooks.agents[x]!.start! - first);
      if (d < gap) {
        gap = d;
        best = x;
      }
    }
    if (best !== undefined) claim(m, best);
  }
  const calls = new Map((info?.agentCalls ?? []).map((c) => [c.id, c]));
  const turn = opts.turnStart ?? info?.turnStart ?? null;
  const out: AgentInfo[] = [];
  for (const m of metas) {
    const h = match.get(m);
    const call = typeof m.meta.toolUseId === 'string' ? calls.get(m.meta.toolUseId) : undefined;
    let running: boolean;
    let ref = m.stat.mtimeMs;
    if (h) {
      // a lost SubagentStop: the transcript says done
      running = hookRunning(h, now) && !(call && call.done !== null);
      ref = h.end ?? (call?.done || ref);
    } else {
      const quiet = now - m.stat.mtimeMs;
      running = call ? call.done === null && (!call.async || quiet < LOST_MS) : quiet < LIVE_MS;
    }
    const recent = turn !== null ? ref >= turn : now - ref < RECENT_MS;
    if (!running && !recent) continue;
    const s = m.s ?? cached(m.jsonl, m.stat.size, env, persist);
    if (!h) {
      out.push(row(m.id, m.meta, s, { running, start: s.first, last: running ? now : s.last }));
      continue;
    }
    out.push(
      row(m.id, m.meta, s, {
        running,
        start: h.start ?? s.first,
        last: running ? now : (h.end ?? s.last),
        type: (h.type !== null ? sanitizeText(h.type) : '') || metaType(m.meta),
      }),
    );
  }
  for (const k of keys) {
    const h = hooks.agents[k]!;
    if (used.has(k) || !hookRunning(h, now) || (turn !== null && (h.start ?? 0) < turn)) continue;
    out.push({
      id: sanitizeText(k),
      type: (h.type !== null ? sanitizeText(h.type) : '') || 'agent',
      description: '',
      model: null,
      input: 0,
      output: 0,
      total: 0,
      fresh: 0,
      start: h.start,
      last: now,
      tool: null,
      running: true,
    });
  }
  return sorted(out);
}
