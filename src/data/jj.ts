import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deepSanitize, sanitizeText } from '../core/sanitize.js';
import { GIT_TIMEOUT, parseShortstat } from './git.js';

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

function defaultRun(args: string[], cwd: string): string | null {
  try {
    return execFileSync('jj', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }
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

export function readJj(cwd: string, opts: { run?: JjRun } = {}): JjReader | null {
  const root = findJjRoot(cwd);
  if (!root) return null;
  const run = opts.run ?? defaultRun;
  const jj = (args: string[], snapshot = false) => run([...(snapshot ? BASE : READ), ...args], root);
  const bookmarks = once(() => {
    const out = jj(['log', '--no-graph', '-r', 'heads(::@ & bookmarks())', '-T', 'bookmarks ++ "\\n"']);
    return out === null ? null : parseBookmarks(out);
  });
  const workspace = once(() => {
    const out = jj(['workspace', 'list', '-T', 'if(target.current_working_copy(), name ++ "\\n")']);
    const line = out?.split('\n').find((l) => l.trim());
    return line ? sanitizeText(line.trim()) : null;
  });
  const change = once(() => {
    const out = jj([
      'log',
      '--no-graph',
      '-r',
      '@',
      '-T',
      'change_id.shortest(8) ++ "\\t" ++ description.first_line() ++ "\\n"',
    ]);
    return out === null ? null : parseJjChange(out);
  });
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
          const out = jj(['diff', '--stat'], snapshot);
          return out === null ? null : parseJjStat(out);
        });
        diffs.set(snapshot, fn);
      }
      return fn();
    },
  };
}
