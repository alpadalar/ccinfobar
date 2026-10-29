import type { Outcome, Req } from '../core/cache-rule.js';
import { deepSanitize, sanitizeText } from '../core/sanitize.js';

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
  partial?: boolean;
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

export interface Recent {
  key: string;
  prev: number | null;
  ts: number | null;
  input: number;
  output: number;
  read: number;
  write: number;
  outcome?: Outcome;
}

export interface ReqBase {
  prev: Req | null;
  ever: boolean;
  expect: boolean;
  missAt: number | null;
  at: number | null;
}

export interface State {
  v: number;
  offset: number;
  ino: number;
  mtimeMs: number;
  size: number;
  head: string;
  headLen: number;
  tail: string;
  complete: boolean;
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

export const VERSION = 10;
export const HEAD_BYTES = 256;
export const TAIL_BYTES = 64;
export const RESPONSES = 20;
export const MAX_RESPONSE_MS = 300_000;
export const RECENT = 64;
export const SPEED_WINDOW = 10;
export const CHUNK = 8 * 1024 * 1024;
export const MIN_CHUNK = 64 * 1024;
// first scan of a long transcript spreads over renders
export const TRANSCRIPT_BUDGET = 8 * 1024 * 1024;
export const TRANSCRIPT_DEADLINE_MS = 250;
export const RUNNING = 8;
export const TOOL_NAMES = 50;
export const TOOL_NAMES_KEPT = 200;
export const COUNTED = 64;
export const ARG_MAX = 32;
export const FINAL = new Set(['end_turn', 'stop_sequence', 'max_tokens']);
export const INTERRUPT = /^\s*\[Request interrupted/;

export function emptyState(): State {
  return {
    v: VERSION,
    offset: 0,
    ino: 0,
    mtimeMs: 0,
    size: 0,
    head: '',
    headLen: 0,
    tail: '',
    complete: false,
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

export function outputSpeed(s: State): number | null {
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

export function clean(v: string | null): string | null {
  return v === null ? null : sanitizeText(v) || null;
}

export function turnEnd(s: State): number | null {
  const end = s.turnEnd ?? (s.lastStop?.final ? s.lastStop.ts : null);
  return end !== null && s.promptStart !== null && end < s.promptStart ? null : end;
}

// the cache is trusted only after this
export function counts(list: unknown): [string, number][] {
  if (!Array.isArray(list)) return [];
  const out: [string, number][] = [];
  for (const x of list) {
    if (!Array.isArray(x) || typeof x[0] !== 'string' || typeof x[1] !== 'number' || !Number.isFinite(x[1]))
      continue;
    out.push([sanitizeText(x[0]), x[1]]);
    if (out.length >= TOOL_NAMES) break;
  }
  return out;
}

export function toInfo(s: State): TranscriptInfo {
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
