import path from 'node:path';
import { hooksDir, SESSION_RE } from './hook-line.js';
import { readJsonSafe, writeSmall } from './store.js';

export const PROGRESS_EVENTS = ['UserPromptSubmit', 'Stop', 'StopFailure'] as const;
export type ProgressEvent = (typeof PROGRESS_EVENTS)[number];
export type ProgressState = 0 | 1 | 2 | 4;

export interface ProgressWant {
  v: 1;
  state: ProgressState;
  pct: number;
  channel: 'hook' | 'tty';
  always: boolean;
}

export interface ProgressSent {
  state: ProgressState;
  pct: number;
}

// Claude Code's OSC 9 body validator
export const SEQ_BODY_RE = /^4;[0-4](;(100|\d{1,2})?)?$/;

export function isProgressEvent(v: unknown): v is ProgressEvent {
  return typeof v === 'string' && (PROGRESS_EVENTS as readonly string[]).includes(v);
}

const clampPct = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0);

export function progressSeq(state: ProgressState, pct: number): string {
  if (state === 0) return '\x1b]9;4;0;\x07';
  return `\x1b]9;4;${state};${clampPct(pct)}\x07`;
}

export function progressFiles(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): { want: string; sent: string } | null {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return null;
  const dir = hooksDir(env);
  return {
    want: path.join(dir, `${sessionId}.progress.json`),
    sent: path.join(dir, `${sessionId}.progress-sent.json`),
  };
}

const isState = (v: unknown): v is ProgressState => v === 0 || v === 1 || v === 2 || v === 4;
const isPct = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isWant(v: unknown): v is ProgressWant {
  return (
    isObj(v) &&
    v.v === 1 &&
    isState(v.state) &&
    isPct(v.pct) &&
    (v.channel === 'hook' || v.channel === 'tty') &&
    typeof v.always === 'boolean'
  );
}

function isSent(v: unknown): v is ProgressSent {
  return isObj(v) && isState(v.state) && isPct(v.pct);
}

export function readWant(file: string): ProgressWant | null {
  return readJsonSafe(file, isWant);
}

export function readSent(file: string): ProgressSent | null {
  return readJsonSafe(file, isSent);
}

export function markSent(file: string, s: ProgressSent): boolean {
  return writeSmall(file, JSON.stringify({ state: s.state, pct: s.pct }));
}

function atLeast(version: string | undefined, min: readonly number[]): boolean {
  if (typeof version !== 'string') return false;
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < min.length; i++) {
    const n = parts[i] ?? 0;
    if (!Number.isFinite(n)) return false;
    if (n !== min[i]) return n > min[i]!;
  }
  return true;
}

// OSC 9 is a notification elsewhere
export function terminalAllowed(env: NodeJS.ProcessEnv, always: boolean): boolean {
  if (always || env.WT_SESSION || env.ConEmuPID || env.ConEmuANSI) return true;
  const prog = env.TERM_PROGRAM;
  if (prog === 'WezTerm') return true;
  if (prog === 'ghostty') return atLeast(env.TERM_PROGRAM_VERSION, [1, 2, 0]);
  if (prog === 'iTerm.app') return atLeast(env.TERM_PROGRAM_VERSION, [3, 6, 6]);
  return false;
}
