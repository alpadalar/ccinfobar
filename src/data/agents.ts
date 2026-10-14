import fs from 'node:fs';
import path from 'node:path';
import { sanitizeText } from '../core/sanitize.js';
import { cacheKey, readCache, writeCache } from './cache.js';
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

function cached(file: string, size: number, env: NodeJS.ProcessEnv): Summary {
  const name = `agent2-${cacheKey(file)}.json`;
  const hit = readCache<Summary>(name, env);
  if (hit && hit.size === size) return hit;
  const s = summarize(file, size);
  writeCache(name, s, env);
  return s;
}

// agents of the current turn, running ones first
export function readAgents(
  transcriptPath: string | undefined,
  info: TranscriptInfo | null,
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): AgentInfo[] {
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
    const recent = turn !== null ? stat.mtimeMs >= turn : now - stat.mtimeMs < 10 * 60_000;
    if (!running && !recent) continue;
    const s = cached(jsonl, stat.size, env);
    out.push({
      id: id.replace(/^agent-/, ''),
      type: typeof meta.agentType === 'string' ? sanitizeText(meta.agentType) || 'agent' : 'agent',
      description: typeof meta.description === 'string' ? sanitizeText(meta.description) : '',
      model: s.model === null ? null : sanitizeText(s.model),
      input: s.input,
      output: s.output,
      total: s.total,
      fresh: s.fresh,
      start: s.first,
      last: running ? now : s.last,
      tool: s.tool === null ? null : sanitizeText(s.tool),
      running,
    });
  }
  return out
    .sort((a, b) => Number(b.running) - Number(a.running) || (a.start ?? 0) - (b.start ?? 0))
    .slice(0, MAX);
}
