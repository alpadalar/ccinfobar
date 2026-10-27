import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deepSanitize, sanitizeText } from '../core/sanitize.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { parseShortstat } from './git.js';
import { binary, pathValue, whichDeps } from './which.js';

// jj starts slower than git
export const JJ_TIMEOUT =
  Number(process.env.CCINFOBAR_JJ_TIMEOUT) || (process.platform === 'win32' ? 2000 : 1000);

const MISS_TTL = 300_000;
const BACKOFF_TTL = 60_000;

export interface JjChange {
  id: string;
  description: string;
}

export interface JjReader {
  root: string;
  bookmarks(): string[] | null;
  workspace(): string | null;
  change(): JjChange | null;
  diff(snapshot: boolean): { insertions: number; deletions: number } | null;
}

export type JjRun = (args: string[], cwd: string) => string | null;
export type JjExec = (bin: string, args: string[], cwd: string) => { out: string | null; code?: string };

export function findJjRoot(dir: string): string | null {
  let d = path.resolve(dir);
  for (;;) {
    try {
      if (fs.statSync(path.join(d, '.jj'), { throwIfNoEntry: false })?.isDirectory()) return d;
    } catch {}
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function parseBookmarks(out: string): string[] {
  return [...new Set(sanitizeText(out).split(/\s+/).filter(Boolean))];
}

export function parseJjChange(out: string): JjChange | null {
  const line = out.split('\n').find((l) => l.trim()) ?? '';
  const tab = line.indexOf('\t');
  const c = deepSanitize({
    id: (tab < 0 ? line : line.slice(0, tab)).trim(),
    description: tab < 0 ? '' : line.slice(tab + 1).trim(),
  });
  return c.id ? c : null;
}

export function parseJjStat(out: string): { insertions: number; deletions: number } {
  const lines = out.split('\n').filter((l) => l.trim());
  return parseShortstat(lines[lines.length - 1] ?? '');
}

const defaultExec: JjExec = (bin, args, cwd) => {
  try {
    const out = execFileSync(bin, args, {
      cwd,
      encoding: 'utf8',
      timeout: JJ_TIMEOUT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    });
    return { out };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code ? { out: null, code } : { out: null };
  }
};

function fresh(file: string, ttl: number, now: number, env: NodeJS.ProcessEnv): boolean {
  const hit = readCache<{ at: number }>(file, env);
  if (!hit || typeof hit.at !== 'number' || !Number.isFinite(hit.at)) return false;
  const age = now - hit.at;
  return age >= 0 && age < ttl;
}

function once<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      try {
        value = fn();
      } catch {
        value = null as T;
      }
      done = true;
    }
    return value;
  };
}

const BASE = ['--no-pager', '--color=never'];
const READ = [...BASE, '--ignore-working-copy'];

interface JjEntry {
  v: 1;
  sig: [number, number];
  bookmarks?: string[];
  workspace?: string;
  change?: JjChange;
  diff?: { insertions: number; deletions: number };
}

type Sig = [number, number];

export function jjCacheName(root: string, bin: string): string {
  return `jj-${cacheKey(root, bin)}.json`;
}

function opSig(root: string): Sig | null {
  try {
    const dir = path.join(root, '.jj', 'repo', 'op_heads', 'heads');
    return [fs.statSync(dir).mtimeMs, fs.readdirSync(dir).length];
  } catch {
    return null;
  }
}

function validEntry(e: JjEntry | null, sig: Sig): JjEntry | null {
  if (!e || e.v !== 1 || !Array.isArray(e.sig) || e.sig[0] !== sig[0] || e.sig[1] !== sig[1]) return null;
  return e;
}

function validValue(key: 'bookmarks' | 'workspace' | 'change' | 'diff', v: unknown): unknown {
  if (key === 'bookmarks')
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? deepSanitize(v) : undefined;
  if (key === 'workspace') return typeof v === 'string' ? sanitizeText(v) : undefined;
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return undefined;
  if (key === 'change')
    return typeof o.id === 'string' && typeof o.description === 'string'
      ? deepSanitize({ id: o.id, description: o.description })
      : undefined;
  return Number.isFinite(o.insertions) && Number.isFinite(o.deletions)
    ? { insertions: o.insertions, deletions: o.deletions }
    : undefined;
}

export interface JjOptions {
  run?: JjRun;
  exec?: JjExec;
  env?: NodeJS.ProcessEnv;
  now?: number;
  persist?: boolean;
}

export function readJj(cwd: string, opts: JjOptions = {}): JjReader | null {
  const root = findJjRoot(cwd);
  if (!root) return null;
  let run: JjRun;
  let cached = <T>(_key: 'bookmarks' | 'workspace' | 'change' | 'diff', fn: () => T): T => fn();
  if (opts.run) run = opts.run;
  else {
    const env = opts.env ?? process.env;
    const now = opts.now ?? Date.now();
    const persist = opts.persist !== false;
    const missFile = `jj-miss-${cacheKey(pathValue(env, process.platform))}.json`;
    if (fresh(missFile, MISS_TTL, now, env)) return null;
    const bin = binary('jj', whichDeps(env));
    if (!bin) return null;
    const backFile = `jj-backoff-${cacheKey(root)}.json`;
    let blocked = fresh(backFile, BACKOFF_TTL, now, env);
    const exec = opts.exec ?? defaultExec;
    run = (args, dir) => {
      if (blocked) return null;
      const r = exec(bin, args, dir);
      if (r.out === null && (r.code === 'ENOENT' || r.code === 'ETIMEDOUT')) {
        blocked = true;
        if (persist) writeCache(r.code === 'ENOENT' ? missFile : backFile, { at: now }, env);
      }
      return r.out;
    };
    const sig = opSig(root);
    if (sig) {
      const file = jjCacheName(root, bin);
      cached = (key, fn) => {
        const hit = validEntry(readCache<JjEntry>(file, env), sig);
        const v = hit && key in hit ? validValue(key, hit[key]) : undefined;
        if (v !== undefined) return v as ReturnType<typeof fn>;
        const value = fn();
        if (value !== null && persist) {
          const base = validEntry(readCache<JjEntry>(file, env), sig) ?? { v: 1, sig };
          writeCache(file, { ...base, [key]: value }, env);
        }
        return value;
      };
    }
  }
  const jj = (args: string[], snapshot = false) => run([...(snapshot ? BASE : READ), ...args], root);
  const bookmarks = once(() =>
    cached('bookmarks', () => {
      const out = jj(['log', '--no-graph', '-r', 'heads(::@ & bookmarks())', '-T', 'bookmarks ++ "\\n"']);
      return out === null ? null : parseBookmarks(out);
    }),
  );
  const workspace = once(() =>
    cached('workspace', () => {
      const out = jj(['workspace', 'list', '-T', 'if(target.current_working_copy(), name ++ "\\n")']);
      const line = out?.split('\n').find((l) => l.trim());
      return line ? sanitizeText(line.trim()) : null;
    }),
  );
  const change = once(() =>
    cached('change', () => {
      const out = jj([
        'log',
        '--no-graph',
        '-r',
        '@',
        '-T',
        'change_id.shortest(8) ++ "\\t" ++ description.first_line() ++ "\\n"',
      ]);
      return out === null ? null : parseJjChange(out);
    }),
  );
  const diffs = new Map<boolean, () => { insertions: number; deletions: number } | null>();
  return {
    root: sanitizeText(root),
    bookmarks,
    workspace,
    change,
    diff(snapshot) {
      let fn = diffs.get(snapshot);
      if (!fn) {
        fn = once(() => {
          const read = () => {
            const out = jj(['diff', '--stat'], snapshot);
            return out === null ? null : parseJjStat(out);
          };
          return snapshot ? read() : cached('diff', read);
        });
        diffs.set(snapshot, fn);
      }
      return fn();
    },
  };
}
