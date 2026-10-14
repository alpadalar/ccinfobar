import { hookLine, hookLogPath, isHookEvent, SESSION_RE } from '../data/hooks.js';
import { appendLine } from '../data/store.js';

export interface HookDeps {
  argv: string[];
  readStdin: () => Promise<{ text: string; overflow: boolean } | null>;
  env: NodeJS.ProcessEnv;
  now: () => number;
  append: (file: string, line: string) => boolean;
}

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

export async function runHook(d: HookDeps): Promise<void> {
  try {
    const raw = await d.readStdin();
    if (!raw) return;
    const input = raw.overflow ? scanFields(raw.text) : parseInput(raw.text);
    if (!input) return;
    const at = d.argv.lastIndexOf('hook');
    const fromArgv = at < 0 ? undefined : d.argv[at + 1];
    const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : fromArgv;
    if (!isHookEvent(event)) return;
    const sid = input.session_id;
    if (typeof sid !== 'string' || !SESSION_RE.test(sid)) return;
    const file = hookLogPath(sid, d.env);
    if (!file) return;
    d.append(file, JSON.stringify(hookLine(event, input, d.now())));
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
