import fs from 'node:fs';
import path from 'node:path';
import { sanitizeText } from '../core/sanitize.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import type { HookAgent, HookState } from './hooks.js';
import { headHash, shortArg, type TranscriptInfo } from './transcript.js';

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
  v: number;
  size: number;
  offset: number;
  ino: number;
  mtimeMs: number;
  head: string;
  headLen: number;
  complete: boolean;
  seen: string[];
  model: string | null;
  input: number;
  output: number;
  total: number;
  fresh: number;
  first: number | null;
  last: number | null;
  tool: string | null;
}

const SUMMARY_VERSION = 1;
const AGENT_CHUNK = 1024 * 1024;
const AGENT_MIN_CHUNK = 64 * 1024;
const HEAD_BYTES = 256;
const SEEN_KEPT = 32;
export const AGENT_BUDGET = 1024 * 1024;
export const AGENTS_BUDGET = 4 * 1024 * 1024;
const LIVE_MS = 30_000;
const LOST_MS = 15 * 60_000;
const MAX = 8;
const HOOK_AGENT_MAX_MS = 2 * 3_600_000;
const MATCH_MS = 5_000;
const RECENT_MS = 10 * 60_000;

// biome-ignore lint/suspicious/noExplicitAny: untyped JSONL
type Json = Record<string, any>;

function short(name: string, input: Json): string {
  const arg = shortArg(input, 48);
  return arg ? `${name}[${arg}]` : name;
}

function emptySummary(size: number): Summary {
  return {
    v: SUMMARY_VERSION,
    size,
    offset: 0,
    ino: 0,
    mtimeMs: 0,
    head: '',
    headLen: 0,
    complete: false,
    seen: [],
    model: null,
    input: 0,
    output: 0,
    total: 0,
    fresh: 0,
    first: null,
    last: null,
    tool: null,
  };
}

function applyLine(s: Summary, line: string): void {
  let e: Json;
  try {
    e = JSON.parse(line) as Json;
  } catch {
    return;
  }
  const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
  if (!Number.isNaN(ts)) {
    s.first ??= ts;
    s.last = ts;
  }
  if (e.type !== 'assistant') return;
  const msg = (e.message ?? {}) as Json;
  if (typeof msg.model === 'string' && msg.model !== '<synthetic>') s.model = msg.model;
  for (const b of Array.isArray(msg.content) ? (msg.content as Json[]) : []) {
    if (b?.type === 'tool_use' && typeof b.name === 'string') s.tool = short(b.name, (b.input ?? {}) as Json);
  }
  const key = `${msg.id ?? ''}:${e.requestId ?? ''}`;
  const u = msg.usage as Json | undefined;
  if (!u || s.seen.includes(key)) return;
  s.seen.push(key);
  if (s.seen.length > SEEN_KEPT) s.seen.splice(0, s.seen.length - SEEN_KEPT);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  s.input += n(u.input_tokens);
  s.output += n(u.output_tokens);
  const fresh = n(u.input_tokens) + n(u.output_tokens) + n(u.cache_creation_input_tokens);
  s.fresh += fresh;
  s.total += fresh + n(u.cache_read_input_tokens);
}

// returns bytes read; sets s.complete when the scan reached the end of the file
function advanceSummary(s: Summary, fd: number, size: number, budget: number): number {
  const from = s.offset;
  const end = Math.min(size, from + Math.max(0, budget));
  const buf = Buffer.allocUnsafe(Math.min(AGENT_CHUNK, Math.max(end - from, AGENT_MIN_CHUNK)));
  let parts: Buffer[] = [];
  let carryLen = 0;
  let pos = from;
  // a line longer than the budget is read through to its newline
  while (pos < end || (s.offset === from && carryLen > 0 && pos < size)) {
    const limit = pos < end ? end - pos : size - pos;
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, limit), pos);
    if (n <= 0) break;
    pos += n;
    const chunk = buf.subarray(0, n);
    let start = 0;
    let nl = chunk.indexOf(10, start);
    while (nl !== -1) {
      const seg = parts.length
        ? Buffer.concat([...parts, chunk.subarray(start, nl)])
        : chunk.subarray(start, nl);
      parts = [];
      if (seg.length > 0) applyLine(s, seg.toString('utf8'));
      start = nl + 1;
      nl = chunk.indexOf(10, start);
    }
    carryLen = n - start + (start === 0 ? carryLen : 0);
    if (start < n) parts.push(Buffer.from(chunk.subarray(start)));
    s.offset = pos - carryLen;
  }
  s.complete = pos >= size;
  // an unterminated last line counts if it parses; seen dedupes the re-read
  if (s.complete && carryLen > 0) applyLine(s, Buffer.concat(parts).toString('utf8'));
  return pos - from;
}

export function agentsCacheName(file: string): string {
  return `agent3-${cacheKey(file)}.json`;
}

function headChanged(fd: number, s: Summary, h: { head: string; headLen: number }, size: number): boolean {
  if (s.headLen <= 0) return false;
  if (h.headLen === s.headLen) return h.head !== s.head;
  // small file grew past its old head length
  if (s.headLen < HEAD_BYTES && size > s.size && h.headLen > s.headLen) {
    return headHash(fd, s.headLen).head !== s.head;
  }
  return true;
}

function cached(
  file: string,
  st: fs.Stats,
  env: NodeJS.ProcessEnv,
  persist: boolean,
  left: { bytes: number },
): Summary {
  const size = st.size;
  const name = agentsCacheName(file);
  let s = readCache<Summary>(name, env);
  if (
    !s ||
    s.v !== SUMMARY_VERSION ||
    !Array.isArray(s.seen) ||
    s.offset > size ||
    (s.ino !== 0 && st.ino !== 0 && s.ino !== st.ino)
  ) {
    s = emptySummary(size);
  } else if (s.complete && s.mtimeMs === st.mtimeMs && s.size === size) {
    return s;
  }
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const h = headHash(fd, size);
    if (s.offset > 0 && headChanged(fd, s, h, size)) s = emptySummary(size);
    const budget = Math.min(AGENT_BUDGET, left.bytes);
    if (budget > 0 && s.offset < size) left.bytes -= advanceSummary(s, fd, size, budget);
    else s.complete = s.offset >= size;
    s.ino = st.ino;
    s.mtimeMs = st.mtimeMs;
    s.size = size;
    s.head = h.head;
    s.headLen = h.headLen;
    if (persist) writeCache(name, s, env);
  } catch {
    return s;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return s;
}

interface AgentListing {
  id: string;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
}

const LISTING_VERSION = 1;
const AGENT_ID = /^[A-Za-z0-9_-]+$/;

export function agentsDirCacheName(dir: string): string {
  return `agents-dir-${cacheKey(dir)}.json`;
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? sanitizeText(v) : null);

function validListing(files: unknown): files is AgentListing[] {
  return (
    Array.isArray(files) &&
    files.every(
      (f) =>
        f &&
        typeof f === 'object' &&
        typeof f.id === 'string' &&
        AGENT_ID.test(f.id) &&
        [f.agentType, f.description, f.toolUseId].every((v) => v === null || typeof v === 'string'),
    )
  );
}

// the directory mtime moves on create/delete, not on append
function listAgents(dir: string, env: NodeJS.ProcessEnv, persist: boolean): AgentListing[] {
  let dirMtime: number;
  try {
    dirMtime = fs.statSync(dir).mtimeMs;
  } catch {
    return [];
  }
  const name = agentsDirCacheName(dir);
  const hit = readCache<{ v: number; dirMtime: number; files: unknown }>(name, env);
  if (hit && hit.v === LISTING_VERSION && hit.dirMtime === dirMtime && validListing(hit.files)) {
    return hit.files.map((f) => ({
      id: f.id,
      agentType: strOrNull(f.agentType),
      description: strOrNull(f.description),
      toolUseId: strOrNull(f.toolUseId),
    }));
  }
  const files: AgentListing[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return [];
  }
  for (const f of names) {
    const id = f.slice(0, -'.meta.json'.length);
    if (!AGENT_ID.test(id)) continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const m = (parsed && typeof parsed === 'object' ? parsed : {}) as Json;
      files.push({
        id,
        agentType: strOrNull(m.agentType),
        description: strOrNull(m.description),
        toolUseId: strOrNull(m.toolUseId),
      });
    } catch {}
  }
  if (persist) writeCache(name, { v: LISTING_VERSION, dirMtime, files }, env);
  return files;
}

function metaOf(e: AgentListing): Json {
  const meta: Json = {};
  if (e.agentType !== null) meta.agentType = e.agentType;
  if (e.description !== null) meta.description = e.description;
  if (e.toolUseId !== null) meta.toolUseId = e.toolUseId;
  return meta;
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
  const persistCache = opts.persist !== false;
  const left = { bytes: AGENTS_BUDGET };
  const calls = new Map((info?.agentCalls ?? []).map((c) => [c.id, c]));
  const out: AgentInfo[] = [];
  for (const entry of listAgents(dir, env, persistCache)) {
    const id = entry.id;
    const jsonl = path.join(dir, `${id}.jsonl`);
    const meta = metaOf(entry);
    let stat: fs.Stats;
    try {
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
    const s = cached(jsonl, stat, env, persistCache, left);
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
  const left = { bytes: AGENTS_BUDGET };
  const metas: MetaFile[] = [];
  if (transcriptPath) {
    const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
    for (const entry of listAgents(dir, env, persist)) {
      const jsonl = path.join(dir, `${entry.id}.jsonl`);
      try {
        metas.push({ id: entry.id, jsonl, meta: metaOf(entry), stat: fs.statSync(jsonl) });
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
    m.s = cached(m.jsonl, m.stat, env, persist, left);
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
    const s = m.s ?? cached(m.jsonl, m.stat, env, persist, left);
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
