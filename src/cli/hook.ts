import fs from 'node:fs';
import path from 'node:path';
import { configPath } from '../core/paths.js';
import type { Config } from '../core/types.js';
import { hookLine, hookLogPath, hooksDir, isHookEvent, SESSION_RE } from '../data/hooks.js';
import { appendLine } from '../data/store.js';
import { parseArgs } from './args.js';

export interface HookDeps {
  argv: string[];
  readStdin: () => Promise<{ text: string; overflow: boolean } | null>;
  env: NodeJS.ProcessEnv;
  now: () => number;
  append: (file: string, line: string) => boolean;
  schedule?: (sessionId: string, configFile: string) => void | Promise<void>;
  prune?: (dir: string, keep: string[], now: number) => number;
  debug?: (reason: string) => void;
}

const DEBUG_CAP = 262_144;
const PRUNE_AGE = 7 * 86_400_000;

const SCAN_BYTES = 65_536;
const SCAN_RE =
  /"(session_id|hook_event_name|prompt_id|agent_id|agent_type|source|notification_type|tool_name)"\s*:\s*"([^"\\]{1,256})"/g;

let silenced = false;

export function silence(): void {
  if (silenced) return;
  silenced = true;
  const noop = (() => true) as typeof process.stdout.write;
  process.stdout.write = noop;
  process.stderr.write = noop;
  process.removeAllListeners('warning');
  const bye = () => process.exit(0);
  process.on('uncaughtException', bye);
  process.on('unhandledRejection', bye);
  setTimeout(bye, 2000);
}

export function readHookStdin(
  stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  capBytes = 1_048_576,
  deadlineMs = 1000,
): Promise<{ text: string; overflow: boolean } | null> {
  if (stream.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString('utf8'), overflow });
    };
    const timer = setTimeout(finish, deadlineMs);
    stream.on('data', (chunk: Buffer | string) => {
      if (overflow) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (size + buf.length > capBytes) {
        overflow = true;
        chunks.push(buf.subarray(0, capBytes - size));
        size = capBytes;
        return;
      }
      chunks.push(buf);
      size += buf.length;
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

// top-level scalars only; escaped keys inside strings cannot match
export function scanFields(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of head.slice(0, SCAN_BYTES).matchAll(SCAN_RE)) {
    const k = m[1]!;
    if (!(k in out)) out[k] = m[2]!;
  }
  return out;
}

function parseInput(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// only the update key; missing file is the default, a broken file skips
export function readUpdateSetting(configFile: string): Config['update'] | null {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'auto' : null;
  }
  try {
    const v: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const u = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>).update : null;
    return u === 'notify' || u === 'auto' || u === 'off' ? u : 'auto';
  } catch {
    return null;
  }
}

export async function scheduleUpdate(
  sessionId: string,
  configFile: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const update = readUpdateSetting(configFile);
  if (update === null) return;
  const { scheduleCheck } = await import('../data/update-state.js');
  scheduleCheck({ update } as Config, sessionId, env);
}

const PRUNE_RE = /^([A-Za-z0-9_-]{1,128})(\.jsonl|\.fold\.json)$/;

// bounded by deletions and time, not entries; regular files only
export function pruneHookLogs(
  dir: string,
  keep: string[],
  now: number,
  maxAgeMs = PRUNE_AGE,
  maxRemove = 200,
  budgetMs = 15,
  clock: () => number = Date.now,
): number {
  let removed = 0;
  let handle: fs.Dir | undefined;
  const end = clock() + budgetMs;
  try {
    handle = fs.opendirSync(dir);
    while (removed < maxRemove && clock() < end) {
      const ent = handle.readSync();
      if (!ent) break;
      if (!PRUNE_RE.test(ent.name) || keep.includes(ent.name)) continue;
      const file = path.join(dir, ent.name);
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || now - st.mtimeMs <= maxAgeMs) continue;
        fs.unlinkSync(file);
        removed++;
      } catch {}
    }
  } catch {}
  try {
    handle?.closeSync();
  } catch {}
  return removed;
}

export function debugLog(env: NodeJS.ProcessEnv, now: () => number): (reason: string) => void {
  if (!env.CCINFOBAR_DEBUG) return () => {};
  const file = path.join(hooksDir(env), 'debug.log');
  return (reason) => {
    try {
      if (fs.statSync(file).size > DEBUG_CAP) return;
    } catch {}
    try {
      appendLine(file, `${new Date(now()).toISOString()} ${reason}`);
    } catch {}
  };
}

function configFileOf(argv: string[], env: NodeJS.ProcessEnv): string {
  const at = argv.lastIndexOf('hook');
  const flag = parseArgs(at < 0 ? argv : argv.slice(0, at)).flags.config;
  return typeof flag === 'string' ? path.resolve(flag) : configPath(env);
}

export async function runHook(d: HookDeps): Promise<void> {
  try {
    const debug = d.debug ?? debugLog(d.env, d.now);
    const raw = await d.readStdin();
    if (!raw) return debug('tty');
    if (!raw.text) return debug('no-input');
    if (raw.overflow) debug('overflow');
    const input = raw.overflow ? scanFields(raw.text) : parseInput(raw.text);
    if (!input) return debug('bad-json');
    const at = d.argv.lastIndexOf('hook');
    const fromArgv = at < 0 ? undefined : d.argv[at + 1];
    const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : fromArgv;
    if (!isHookEvent(event)) return debug('unknown-event');
    const sid = input.session_id;
    if (typeof sid !== 'string' || !SESSION_RE.test(sid)) return debug('bad-session');
    const file = hookLogPath(sid, d.env);
    if (!file) return debug('bad-session');
    const line = hookLine(event, input, d.now());
    let ok = false;
    try {
      ok = d.append(file, JSON.stringify(line));
    } catch {}
    if (!ok) debug('append-failed');
    // new sessions only (D-23)
    if (event !== 'SessionStart' || line.s !== 'startup') return;
    const prune = d.prune ?? pruneHookLogs;
    try {
      const n = prune(hooksDir(d.env), [`${sid}.jsonl`, `${sid}.fold.json`], d.now());
      if (n > 0) debug(`pruned:${n}`);
    } catch {}
    try {
      const configFile = configFileOf(d.argv, d.env);
      const schedule = d.schedule ?? ((s: string, f: string) => scheduleUpdate(s, f, d.env));
      await schedule(sid, configFile);
      debug('scheduled');
    } catch {}
  } catch {}
}

export async function hookMain(argv: string[]): Promise<void> {
  silence();
  try {
    await runHook({
      argv,
      readStdin: () => readHookStdin(),
      env: process.env,
      now: Date.now,
      append: appendLine,
    });
  } catch {}
  process.exit(0);
}
