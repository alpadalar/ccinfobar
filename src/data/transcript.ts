import fs from 'node:fs';
import { classify, type Outcome, type Req } from '../core/cache-rule.js';
import { deepSanitize, sanitizeText } from '../core/sanitize.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { byCount, TOOL_RESULTS } from './live.js';

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface AgentCall {
  id: string;
  start: number | null;
  done: number | null;
  async?: boolean;
}

export interface RunningTool {
  id: string;
  name: string;
  arg: string;
  start: number | null;
}

export interface TranscriptInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextLength: number | null;
  messageCount: number;
  userMessageCount: number;
  compactions: number;
  lastCommand: string | null;
  lastGsdCommand: string | null;
  skills: string[];
  sessionName: string | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  outputSpeed: number | null;
  currentTask: string | null;
  todos: Todo[];
  agentCalls: AgentCall[];
  turnStart: number | null;
  lastAssistantAt: number | null;
  cacheMisses: number;
  lastMissAt: number | null;
  responseMs: number | null;
  responseCount: number;
  runningTools: RunningTool[];
  turnToolCounts: [string, number][];
  sessionToolCounts: [string, number][];
  lastToolResultAt: number | null;
  toolResultTimes: number[];
  promptId: string | null;
  promptStart: number | null;
  turnEnd: number | null;
}

interface Recent {
  key: string;
  prev: number | null;
  ts: number | null;
  input: number;
  output: number;
  read: number;
  write: number;
  outcome?: Outcome;
}

interface ReqBase {
  prev: Req | null;
  ever: boolean;
  expect: boolean;
  missAt: number | null;
  at: number | null;
}

interface State {
  v: number;
  offset: number;
  recent: Recent[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextLength: number | null;
  messageCount: number;
  userMessageCount: number;
  compactions: number;
  boundaryPending: boolean;
  lastCommand: string | null;
  lastGsdCommand: string | null;
  skills: string[];
  title: string | null;
  titleKind: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  currentTask: string | null;
  tasks: string[];
  todos: Todo[];
  agentCalls: AgentCall[];
  turnStart: number | null;
  lastAssistantAt: number | null;
  cacheMisses: number;
  lastMissAt: number | null;
  prevReq: Req | null;
  reqBase: ReqBase | null;
  everCached: boolean;
  expectNext: boolean;
  pendingPrompt: number | null;
  responses: number[];
  running: RunningTool[];
  turnTools: [string, number][];
  sessionTools: [string, number][];
  counted: string[];
  lastToolResultAt: number | null;
  results: number[];
  promptId: string | null;
  promptStart: number | null;
  turnEnd: number | null;
  lastStop: { ts: number | null; final: boolean } | null;
}

const VERSION = 9;
const RESPONSES = 20;
const MAX_RESPONSE_MS = 300_000;
const RECENT = 64;
const SPEED_WINDOW = 10;
const CHUNK = 8 * 1024 * 1024;
const RUNNING = 8;
const TOOL_NAMES = 50;
const COUNTED = 64;
const ARG_MAX = 32;
const FINAL = new Set(['end_turn', 'stop_sequence', 'max_tokens']);
const INTERRUPT = /^\s*\[Request interrupted/;

export function emptyState(): State {
  return {
    v: VERSION,
    offset: 0,
    recent: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextLength: null,
    messageCount: 0,
    userMessageCount: 0,
    compactions: 0,
    boundaryPending: false,
    lastCommand: null,
    lastGsdCommand: null,
    skills: [],
    title: null,
    titleKind: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    currentTask: null,
    tasks: [],
    todos: [],
    agentCalls: [],
    turnStart: null,
    lastAssistantAt: null,
    cacheMisses: 0,
    lastMissAt: null,
    prevReq: null,
    reqBase: null,
    everCached: false,
    expectNext: false,
    pendingPrompt: null,
    responses: [],
    running: [],
    turnTools: [],
    sessionTools: [],
    counted: [],
    lastToolResultAt: null,
    results: [],
    promptId: null,
    promptStart: null,
    turnEnd: null,
    lastStop: null,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: untyped JSONL
type Json = Record<string, any>;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function setTitle(s: State, kind: number, title: unknown) {
  if (typeof title !== 'string' || !title.trim() || kind < s.titleKind) return;
  s.title = title.trim();
  s.titleKind = kind;
}

function userText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.length ? parts.join('\n') : null;
}

const WRAPPED = /^\s*<(command-name|local-command-stdout|local-command-caveat)>/;

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => b?.type === 'tool_result');
}

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

function handleToolUse(s: State, block: Json, ts: number | null) {
  const input = (block.input ?? {}) as Json;
  switch (block.name) {
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as Json[]) : [];
      s.todos = todos
        .filter((t) => t && typeof t.content === 'string')
        .slice(0, 100)
        .map((t) => ({
          content: String(t.content),
          status: STATUSES.has(t.status) ? t.status : 'pending',
          ...(typeof t.activeForm === 'string' ? { activeForm: t.activeForm } : {}),
        }));
      const active = todos.find((t) => t?.status === 'in_progress');
      s.currentTask = active ? String(active.activeForm ?? active.content ?? '') || null : null;
      break;
    }
    case 'TaskCreate':
      s.tasks.push(String(input.activeForm ?? input.subject ?? ''));
      if (s.tasks.length > 200) s.tasks.shift();
      s.todos.push({
        content: String(input.subject ?? input.description ?? ''),
        status: 'pending',
        ...(typeof input.activeForm === 'string' ? { activeForm: input.activeForm } : {}),
      });
      if (s.todos.length > 100) s.todos.shift();
      break;
    case 'TaskUpdate': {
      const idx = Number(input.taskId) - 1;
      const todo = s.todos[idx];
      if (todo && STATUSES.has(input.status)) todo.status = input.status;
      if (todo && input.status === 'deleted') s.todos.splice(idx, 1, { ...todo, status: 'completed' });
      if (input.status === 'in_progress') {
        const name = input.activeForm ?? s.tasks[idx] ?? input.subject;
        if (name) s.currentTask = String(name);
      } else if (input.status === 'completed' || input.status === 'deleted') {
        if (s.tasks[idx] && s.currentTask === s.tasks[idx]) s.currentTask = null;
      }
      break;
    }
    case 'Agent':
    case 'Task':
      if (typeof block.id === 'string') {
        s.agentCalls.push({ id: block.id, start: ts, done: null });
        if (s.agentCalls.length > 40) s.agentCalls.shift();
      }
      break;
    case 'Skill': {
      const name = input.skill ?? input.command;
      if (typeof name === 'string' && name) {
        const at = s.skills.indexOf(name);
        if (at >= 0) s.skills.splice(at, 1);
        s.skills.push(name);
        if (s.skills.length > 50) s.skills.shift();
      }
      break;
    }
  }
}

const ARG_KEYS = ['command', 'pattern', 'file_path', 'path', 'url', 'query', 'description'];

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const SECRET_VAR =
  /\b(\w*(?:token|secret|passw(?:or)?d|pwd|api_?key|access_?key|private_?key|auth|credential)\w*)=("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_SCHEME = /\b(bearer|basic|token)\s+[\w.~+/=-]{6,}/gi;
const URL_USER = /(\w+:\/\/[^\s/:@]+):[^\s/@]+@/g;

function maskSecrets(s: string): string {
  return s.replace(SECRET_VAR, '$1=…').replace(SECRET_SCHEME, '$1 …').replace(URL_USER, '$1:…@');
}

function shortArg(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  for (const key of ARG_KEYS) {
    const v = (input as Json)[key];
    if (typeof v !== 'string') continue;
    const raw = key === 'file_path' || key === 'path' ? baseName(v) : v;
    const flat = sanitizeText(raw.slice(0, 1024)).replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    const one = maskSecrets(Array.from(flat).slice(0, 256).join(''));
    const chars = Array.from(one);
    return chars.length > ARG_MAX ? `${chars.slice(0, ARG_MAX - 1).join('')}…` : one;
  }
  return '';
}

function bump(list: [string, number][], name: string) {
  const hit = list.find((x) => x[0] === name);
  if (hit) hit[1]++;
  else list.push([name, 1]);
  list.sort(byCount);
  if (list.length > TOOL_NAMES) list.length = TOOL_NAMES;
}

function trackTool(s: State, block: Json, ts: number | null) {
  const id = block.id;
  const name = typeof block.name === 'string' ? sanitizeText(block.name).slice(0, 64).trim() : '';
  if (typeof id !== 'string' || !id || !name || s.counted.includes(id)) return;
  s.counted.push(id);
  if (s.counted.length > COUNTED) s.counted.shift();
  s.running.push({ id, name, arg: shortArg(block.input), start: ts });
  if (s.running.length > RUNNING) s.running.shift();
  bump(s.turnTools, name);
  bump(s.sessionTools, name);
}

// ascending, deduped
function addResult(s: State, ts: number) {
  s.lastToolResultAt = ts;
  const r = s.results;
  const last = r[r.length - 1];
  if (last === ts) return;
  r.push(ts);
  if (last !== undefined && ts < last) r.sort((a, b) => a - b);
  if (r.length > TOOL_RESULTS) r.splice(0, r.length - TOOL_RESULTS);
}

function startTurn(s: State, promptId: string | null, ts: number | null) {
  s.promptId = promptId;
  s.promptStart = ts;
  s.turnTools = [];
  s.running = [];
  s.turnEnd = null;
  s.lastStop = null;
}

// Claude Code's miss rule, per API request
function classifyRequest(s: State, rec: Recent, ts: number | null, isNew: boolean) {
  const cur = { input: rec.input, read: rec.read, write: rec.write };
  if (isNew) {
    s.reqBase = { prev: s.prevReq, ever: s.everCached, expect: s.expectNext, missAt: s.lastMissAt, at: ts };
  } else {
    if (rec !== s.recent[s.recent.length - 1] || !s.reqBase) return;
    if (rec.outcome === 'miss') s.cacheMisses--;
    s.lastMissAt = s.reqBase.missAt;
  }
  const b = s.reqBase;
  rec.outcome = classify(b.prev, cur, b.ever, b.expect);
  if (rec.outcome === 'miss') {
    s.cacheMisses++;
    s.lastMissAt = b.at;
  }
  s.prevReq = cur;
  s.everCached = b.ever || cur.read + cur.write > 0;
  s.expectNext = false;
}

function applyAssistant(s: State, e: Json, ts: number | null, prevTs: number | null) {
  const msg = e.message as Json | undefined;
  if (!msg) return;
  const content = Array.isArray(msg.content) ? (msg.content as Json[]) : [];
  for (const b of content) {
    if (b?.type !== 'tool_use') continue;
    handleToolUse(s, b, ts);
    trackTool(s, b, ts);
  }
  s.lastStop = { ts, final: FINAL.has(msg.stop_reason) };
  const u = msg.usage as Json | undefined;
  if (!u || msg.model === '<synthetic>') return;
  if (ts !== null && (s.lastAssistantAt === null || ts > s.lastAssistantAt)) s.lastAssistantAt = ts;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const read = num(u.cache_read_input_tokens);
  const write = num(u.cache_creation_input_tokens);
  const key = `${msg.id ?? ''}:${e.requestId ?? ''}`;
  const hasKey = msg.id !== undefined || e.requestId !== undefined;
  let rec = hasKey ? s.recent.find((r) => r.key === key) : undefined;
  if (rec) {
    s.inputTokens += input - rec.input;
    s.outputTokens += output - rec.output;
    s.cacheReadTokens += read - rec.read;
    s.cacheWriteTokens += write - rec.write;
    Object.assign(rec, { ts, input, output, read, write });
    classifyRequest(s, rec, ts, false);
  } else {
    s.inputTokens += input;
    s.outputTokens += output;
    s.cacheReadTokens += read;
    s.cacheWriteTokens += write;
    s.messageCount++;
    rec = { key, prev: prevTs, ts, input, output, read, write };
    s.recent.push(rec);
    if (s.recent.length > RECENT) s.recent.shift();
    classifyRequest(s, rec, ts, true);
  }
  if (input + read + write > 0) s.contextLength = input + read + write;
}

function setCommand(s: State, cmd: string) {
  s.lastCommand = cmd;
  if (/^gsd[-:]/i.test(cmd)) s.lastGsdCommand = cmd;
}

function applyLine(s: State, line: string, st: { prevTs: number | null }) {
  if (line.includes('"type":"attachment"') || line.includes('"type":"file-history-snapshot"')) return;
  let e: Json;
  try {
    e = JSON.parse(line) as Json;
  } catch {
    return;
  }
  if (!e || typeof e !== 'object') return;
  const type = e.type;
  if (type === 'custom-title') return setTitle(s, 3, e.customTitle ?? e.title);
  if (type === 'ai-title') return setTitle(s, 2, e.aiTitle ?? e.title);
  if (type === 'summary') return setTitle(s, 1, e.summary);
  if (e.isSidechain === true) return;
  const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
  const tsv = Number.isNaN(ts) ? null : ts;
  if (tsv !== null) {
    if (s.firstTimestamp === null) s.firstTimestamp = tsv;
    s.lastTimestamp = tsv;
  }
  if (type === 'system') {
    if (e.subtype === 'local_command' && typeof e.content === 'string') {
      const m = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(e.content);
      if (m) setCommand(s, m[1]!);
    }
    if (e.subtype === 'turn_duration' && tsv !== null && (s.promptStart === null || tsv >= s.promptStart)) {
      s.turnEnd ??= tsv;
    }
    if (e.subtype === 'compact_boundary') {
      s.compactions++;
      s.boundaryPending = true;
      s.expectNext = true;
    }
  } else if (type === 'user') {
    if (e.isCompactSummary === true) {
      if (s.boundaryPending) s.boundaryPending = false;
      else {
        s.compactions++;
        s.expectNext = true;
      }
    } else if (!e.isMeta) {
      const content = e.message?.content;
      if (Array.isArray(content)) {
        for (const b of content as Json[]) {
          if (b?.type !== 'tool_result') continue;
          s.running = s.running.filter((r) => r.id !== b.tool_use_id);
          if (tsv !== null) addResult(s, tsv);
          const call = s.agentCalls.find((c) => c.id === b.tool_use_id);
          if (!call || call.done !== null) continue;
          // background agents report back with a task notification
          if (/^Async agent launched/.test(userText(b.content) ?? '')) call.async = true;
          else call.done = tsv ?? 0;
        }
      }
      const text = userText(content);
      if (text !== null) s.turnStart = tsv;
      if (text !== null && !hasToolResult(content) && !WRAPPED.test(text)) s.pendingPrompt = tsv;
      if (text !== null && INTERRUPT.test(text)) {
        s.running = [];
        s.turnEnd ??= tsv;
      } else if (text !== null && !hasToolResult(content)) {
        const pid = typeof e.promptId === 'string' ? e.promptId : null;
        if (pid !== null ? pid !== s.promptId : !WRAPPED.test(text)) startTurn(s, pid, tsv);
      }
      if (text !== null) {
        s.userMessageCount++;
        const m = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text);
        if (m) setCommand(s, m[1]!);
      }
    }
  } else if (type === 'assistant') {
    if (s.pendingPrompt !== null && tsv !== null && e.message?.model !== '<synthetic>') {
      const gap = tsv - s.pendingPrompt;
      if (gap > 0 && gap < MAX_RESPONSE_MS) {
        s.responses.push(gap);
        if (s.responses.length > RESPONSES) s.responses.shift();
      }
      s.pendingPrompt = null;
    }
    applyAssistant(s, e, tsv, st.prevTs);
  } else if (type === 'queue-operation' && typeof e.content === 'string') {
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(e.content)?.[1];
    const status = /<status>([^<]+)<\/status>/.exec(e.content)?.[1];
    const call = id ? s.agentCalls.find((c) => c.id === id) : undefined;
    if (call && call.done === null && status && status !== 'running') call.done = tsv ?? 0;
  }
  if (tsv !== null) st.prevTs = tsv;
}

function outputSpeed(s: State): number | null {
  let tokens = 0;
  let secs = 0;
  for (const r of s.recent.slice(-SPEED_WINDOW)) {
    if (r.ts === null || r.prev === null || r.output <= 0) continue;
    const dt = (r.ts - r.prev) / 1000;
    if (dt <= 0.2 || dt > 600) continue;
    tokens += r.output;
    secs += dt;
  }
  return secs > 0 ? tokens / secs : null;
}

function clean(v: string | null): string | null {
  return v === null ? null : sanitizeText(v) || null;
}

function turnEnd(s: State): number | null {
  const end = s.turnEnd ?? (s.lastStop?.final ? s.lastStop.ts : null);
  return end !== null && s.promptStart !== null && end < s.promptStart ? null : end;
}

// the cache is trusted only after this
function counts(list: unknown): [string, number][] {
  if (!Array.isArray(list)) return [];
  const out: [string, number][] = [];
  for (const x of list) {
    if (!Array.isArray(x) || typeof x[0] !== 'string' || typeof x[1] !== 'number' || !Number.isFinite(x[1]))
      continue;
    out.push([sanitizeText(x[0]), x[1]]);
  }
  return out;
}

function toInfo(s: State): TranscriptInfo {
  return {
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    totalTokens: s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens,
    contextLength: s.contextLength,
    messageCount: s.messageCount,
    userMessageCount: s.userMessageCount,
    compactions: s.compactions,
    lastCommand: clean(s.lastCommand),
    lastGsdCommand: clean(s.lastGsdCommand),
    skills: s.skills.map(sanitizeText),
    sessionName: clean(s.title),
    firstTimestamp: s.firstTimestamp,
    lastTimestamp: s.lastTimestamp,
    currentTask: clean(s.currentTask),
    outputSpeed: outputSpeed(s),
    todos: deepSanitize(s.todos),
    agentCalls: deepSanitize(s.agentCalls),
    turnStart: s.turnStart,
    lastAssistantAt: s.lastAssistantAt,
    cacheMisses: s.cacheMisses,
    lastMissAt: s.lastMissAt,
    responseMs: s.responses.length ? s.responses.reduce((a, b) => a + b, 0) / s.responses.length : null,
    responseCount: s.responses.length,
    runningTools: deepSanitize(s.running),
    turnToolCounts: counts(s.turnTools),
    sessionToolCounts: counts(s.sessionTools),
    lastToolResultAt: s.lastToolResultAt,
    toolResultTimes: Array.isArray(s.results) ? s.results.filter((x) => Number.isFinite(x)) : [],
    promptId: clean(s.promptId),
    promptStart: s.promptStart,
    turnEnd: turnEnd(s),
  };
}

function advance(s: State, fd: number, size: number) {
  const st = { prevTs: s.lastTimestamp };
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(size - s.offset, 1)));
  let carry = Buffer.alloc(0);
  let pos = s.offset;
  while (pos < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
    if (n <= 0) break;
    pos += n;
    const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    let start = 0;
    let nl = data.indexOf(10, start);
    while (nl !== -1) {
      if (nl > start) applyLine(s, data.toString('utf8', start, nl), st);
      start = nl + 1;
      nl = data.indexOf(10, start);
    }
    carry = Buffer.from(data.subarray(start));
    s.offset = pos - carry.length;
  }
}

export function parseTranscriptText(text: string): TranscriptInfo {
  const s = emptyState();
  const st = { prevTs: null as number | null };
  for (const line of text.split('\n')) if (line) applyLine(s, line, st);
  return toInfo(s);
}

export function transcriptCacheName(file: string): string {
  return `transcript-${cacheKey(file)}.json`;
}

export function readTranscript(
  file: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  opts: { persist?: boolean } = {},
): TranscriptInfo | null {
  if (!file) return null;
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const name = transcriptCacheName(file);
    let state = readCache<State>(name, env);
    if (!state || state.v !== VERSION || state.offset > size) state = emptyState();
    if (state.offset < size) {
      fd = fs.openSync(file, 'r');
      const before = state.offset;
      advance(state, fd, size);
      if (state.offset !== before && opts.persist !== false) writeCache(name, state, env);
    }
    return toInfo(state);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}
