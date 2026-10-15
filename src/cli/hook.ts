import type { Dir } from 'node:fs';
import path from 'node:path';
import { fs } from '../core/builtins.js';
import { configPath } from '../core/paths.js';
import type { Config } from '../core/types.js';
import { hookLine, hookLogPath, hooksDir, isHookEvent, SESSION_RE } from '../data/hook-line.js';
import {
  isProgressEvent,
  markSent,
  progressFiles,
  progressSeq,
  readSent,
  readWant,
  terminalAllowed,
} from '../data/progress.js';
import { appendLine } from '../data/store.js';
import { parseArgs } from './args.js';

// tail: the last 64 KB after an overflow
export interface StdinText {
  text: string;
  overflow: boolean;
  tail?: string;
}

export interface HookDeps {
  argv: string[];
  readStdin: () => Promise<StdinText | null>;
  env: NodeJS.ProcessEnv;
  now: () => number;
  append: (file: string, line: string) => boolean;
  schedule?: (sessionId: string, configFile: string) => void | Promise<void>;
  prune?: (dir: string, keep: string[], now: number) => number;
  debug?: (reason: string) => void;
  writeOut?: (s: string) => void;
}

const DEBUG_CAP = 262_144;
const PRUNE_AGE = 7 * 86_400_000;

const SCAN_BYTES = 65_536;
const SCAN_RE =
  /"(session_id|hook_event_name|prompt_id|agent_id|agent_type|source|notification_type|tool_name)"\s*:\s*"([^"\\]{1,256})"/g;

type ReadFn = (buf: Buffer, cb: (err: NodeJS.ErrnoException | null, n: number) => void) => void;

const readFd0: ReadFn = (buf, cb) => fs.read(0, buf, 0, buf.length, null, cb);

function stdinIsTty(): boolean {
  try {
    return fs.fstatSync(0).isCharacterDevice();
  } catch {
    return true;
  }
}

function endsObject(buf: Buffer, n: number): boolean {
  let i = n - 1;
  while (i >= 0 && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i--;
  return i >= 0 && buf[i] === 0x7d;
}

// fs.read on fd 0, not the stdin stream; a read still pending at exit
// holds the process until the writer closes, so a complete object ends it
export function readHookStdin(
  capBytes = 1_048_576,
  deadlineMs = 1000,
  read: ReadFn = readFd0,
  isTty: () => boolean = stdinIsTty,
): Promise<StdinText | null> {
  if (isTty()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(65_536);
    let size = 0;
    let overflow = false;
    let done = false;
    let tail: Buffer | null = null;
    const keepTail = (b: Buffer) => {
      const all = tail ? Buffer.concat([tail, b]) : b;
      tail = Buffer.from(all.subarray(Math.max(0, all.length - SCAN_BYTES)));
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(tail ? { text, overflow, tail: tail.toString('utf8') } : { text, overflow });
    };
    const timer = setTimeout(finish, deadlineMs);
    const next = () => {
      if (done) return;
      read(buf, (err, n) => {
        if (err?.code === 'EAGAIN') return void setTimeout(next, 5);
        if (err || !n) return finish();
        if (!overflow) {
          const take = Math.min(n, capBytes - size);
          chunks.push(Buffer.from(buf.subarray(0, take)));
          size += take;
          if (take < n) {
            overflow = true;
            keepTail(buf.subarray(take, n));
          } else if (endsObject(buf, n)) {
            try {
              JSON.parse(Buffer.concat(chunks).toString('utf8'));
              return finish();
            } catch {}
          }
        } else keepTail(buf.subarray(0, n));
        next();
      });
    };
    next();
  });
}

// first match wins; nested keys can match, escaped ones inside strings cannot
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
  const file = path.resolve(configFile);
  const extra = file === path.resolve(configPath(env)) ? [] : [`--config=${file}`];
  scheduleCheck({ update } as Config, sessionId, env, extra);
}

const PRUNE_RE = /^([A-Za-z0-9_-]{1,128})(\.jsonl|\.fold\.json|\.progress\.json|\.progress-sent\.json)$/;

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
  let handle: Dir | undefined;
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

// one terminalSequence line per change, nothing else (D-42)
function runProgress(d: HookDeps, input: Record<string, unknown>): string {
  const at = d.argv.lastIndexOf('hook');
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : d.argv[at + 1];
  if (!isProgressEvent(event)) return 'unknown-event';
  const sid = input.session_id;
  const files = typeof sid === 'string' && SESSION_RE.test(sid) ? progressFiles(sid, d.env) : null;
  if (!files) return 'bad-session';
  const want = readWant(files.want);
  if (!want) return 'no-progress';
  if (want.channel !== 'hook') return 'channel';
  if (!terminalAllowed(d.env, want.always)) return 'terminal';
  const sent = readSent(files.sent);
  if (sent && sent.state === want.state && sent.pct === want.pct) return 'unchanged';
  if (!d.writeOut) return 'no-out';
  try {
    d.writeOut(`${JSON.stringify({ terminalSequence: progressSeq(want.state, want.pct) })}\n`);
  } catch {
    return 'write-failed';
  }
  return markSent(files.sent, { state: want.state, pct: want.pct }) ? 'emitted' : 'emitted:mark-failed';
}

export async function runHook(d: HookDeps): Promise<void> {
  try {
    const debug = d.debug ?? debugLog(d.env, d.now);
    const raw = await d.readStdin();
    if (!raw) return debug('tty');
    if (!raw.text) return debug('no-input');
    if (raw.overflow) debug('overflow');
    // prompt_id may follow a huge prompt; the head wins
    const input = raw.overflow
      ? { ...scanFields(raw.tail ?? ''), ...scanFields(raw.text) }
      : parseInput(raw.text);
    if (!input) return debug('bad-json');
    const at = d.argv.lastIndexOf('hook');
    if (at > 0 && d.argv.slice(0, at).includes('--progress')) return debug(runProgress(d, input));
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
    // a resumed session may sit in a new tab: send the bar again (IN-05)
    if (event === 'SessionStart') {
      const sent = progressFiles(sid, d.env)?.sent;
      try {
        if (sent) fs.unlinkSync(sent);
      } catch {}
    }
    // new sessions only (D-23)
    if (event !== 'SessionStart' || line.s !== 'startup') return;
    const prune = d.prune ?? pruneHookLogs;
    try {
      const keep = [`${sid}.jsonl`, `${sid}.fold.json`, `${sid}.progress.json`, `${sid}.progress-sent.json`];
      const n = prune(hooksDir(d.env), keep, d.now());
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
  try {
    await runHook({
      argv,
      // windows pipes may be overlapped; fs.read cannot read those
      readStdin: () =>
        process.platform === 'win32'
          ? import('./hook-stream.js').then((m) => m.readStdinStream())
          : readHookStdin(),
      env: process.env,
      now: Date.now,
      append: appendLine,
      writeOut: (s) => {
        fs.writeSync(1, s);
      },
    });
  } catch {}
  process.exit(0);
}
