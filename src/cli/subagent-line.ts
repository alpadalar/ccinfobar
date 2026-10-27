import path from 'node:path';
import { detectLevel } from '../core/ansi.js';
import { fs } from '../core/builtins.js';
import { configPath } from '../core/paths.js';
import { ingestPayload } from '../core/payload.js';
import type { ColorLevel } from '../core/types.js';
import { setWidthMode } from '../core/width.js';
import { readJsonSafe } from '../data/store.js';
import { SUBAGENT_FIELDS, type SubagentField } from '../widgets/shared.js';
import { subagentRow } from '../widgets/subagent-row.js';
import { parseArgs } from './args.js';

export interface SubagentDeps {
  read?: () => Promise<string | null>;
  write?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// own copy: importing cli/hook.ts would split the hook chunk
export function readStdin(capBytes = 1_048_576, deadlineMs = 1000): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(65_536);
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, deadlineMs);
    const next = () => {
      if (done) return;
      fs.read(0, buf, 0, buf.length, null, (err, n) => {
        if (err?.code === 'EAGAIN') return void setTimeout(next, 5);
        if (err || !n) return finish();
        const take = Math.min(n, capBytes - size);
        chunks.push(Buffer.from(buf.subarray(0, take)));
        size += take;
        if (take < n) return finish();
        next();
      });
    };
    next();
  });
}

function fieldsOf(cfg: Obj | null): SubagentField[] {
  const raw = isObject(cfg?.subagentLine) ? cfg.subagentLine.fields : undefined;
  const ok = SUBAGENT_FIELDS as readonly string[];
  const out = Array.isArray(raw)
    ? [...new Set(raw.filter((f): f is SubagentField => typeof f === 'string' && ok.includes(f)))]
    : [];
  return out.length ? out : [...SUBAGENT_FIELDS];
}

export async function subagentMain(argv: string[], deps: SubagentDeps = {}): Promise<void> {
  try {
    if (!deps.write) process.removeAllListeners('warning');
    const env = deps.env ?? process.env;
    const args = parseArgs(argv);
    const cfgFile = typeof args.flags.config === 'string' ? path.resolve(args.flags.config) : configPath(env);
    const raw = await (deps.read ?? readStdin)();
    if (!raw) return;
    const payload = ingestPayload(raw) as unknown as { columns?: unknown; tasks?: unknown } | null;
    if (!payload || !Array.isArray(payload.tasks)) return;
    const cfg = readJsonSafe<Obj>(cfgFile, isObject);
    const fields = fieldsOf(cfg);
    const text = cfg?.charset === 'text';
    const level = detectLevel((cfg?.colorLevel as ColorLevel | undefined) ?? 'auto', env);
    const columns = typeof payload.columns === 'number' ? payload.columns : Number.NaN;
    const now = (deps.now ?? Date.now)();
    // mirrors widthModeFor; importing core/glyphs.ts would add chunks
    const jb =
      cfg?.glyphMode === 'jetbrains' ||
      (cfg?.glyphMode === 'auto' && /JetBrains/.test(env.TERMINAL_EMULATOR ?? ''));
    const prev = setWidthMode({ emoji: jb ? 1 : 2, ambiguous: cfg?.ambiguousWidth === 2 ? 2 : 1 });
    const out: string[] = [];
    try {
      for (const task of payload.tasks) {
        try {
          if (!isObject(task) || typeof task.id !== 'string') continue;
          const content = subagentRow(task, { columns, now, fields, text, level });
          if (content === '') continue; // keep Claude Code's default row
          out.push(`${JSON.stringify({ id: task.id, content })}\n`);
        } catch {
          // skip this task
        }
      }
    } finally {
      setWidthMode(prev);
    }
    if (out.length) (deps.write ?? ((s) => void process.stdout.write(s)))(out.join(''));
  } catch {
    // silent
  }
}
