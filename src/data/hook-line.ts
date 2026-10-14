import path from 'node:path';
import { cacheDir } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'PermissionDenied',
  'PermissionRequest',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface HookLine {
  v: 1;
  t: number;
  e: HookEvent;
  p?: string;
  sa?: boolean;
  a?: string;
  at?: string;
  tp?: string;
  n?: string;
  tn?: string;
  s?: string;
}

export type StrKey = 'p' | 'a' | 'at' | 'tp' | 'n' | 'tn' | 's';

// stored key, stdin key, cap
const FIELDS: Record<HookEvent, Array<[StrKey, string, number]>> = {
  SessionStart: [['s', 'source', 256]],
  UserPromptSubmit: [['p', 'prompt_id', 256]],
  Stop: [['p', 'prompt_id', 256]],
  SubagentStart: [
    ['a', 'agent_id', 256],
    ['at', 'agent_type', 256],
  ],
  SubagentStop: [
    ['a', 'agent_id', 256],
    ['at', 'agent_type', 256],
    ['tp', 'agent_transcript_path', 1024],
  ],
  Notification: [['n', 'notification_type', 256]],
  PermissionDenied: [['tn', 'tool_name', 256]],
  PermissionRequest: [['tn', 'tool_name', 256]],
};

const EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);

export function isHookEvent(x: unknown): x is HookEvent {
  return typeof x === 'string' && EVENT_SET.has(x);
}

export function hookLine(event: HookEvent, input: Record<string, unknown>, now: number): HookLine {
  const line: HookLine = { v: 1, t: now, e: event };
  for (const [key, src, cap] of FIELDS[event]) {
    const v = input[src];
    if (typeof v === 'string') line[key] = sanitizeText(v).slice(0, cap);
  }
  if (event === 'Stop' && typeof input.stop_hook_active === 'boolean') line.sa = input.stop_hook_active;
  return line;
}

export function hooksDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'hooks');
}

export function hookLogPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return null;
  return path.join(hooksDir(env), `${sessionId}.jsonl`);
}
