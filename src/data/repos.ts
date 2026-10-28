import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReposDirtyValue } from '../core/job-values.js';
import { deepSanitize, sanitizeText, tooDeep } from '../core/sanitize.js';
import type { Config } from '../core/types.js';
import { cacheFile, cacheKey, readCache, writeCache } from './cache.js';
import { jobValue, readEnvelope } from './jobs/runner.js';
import { readJsonSafe } from './store.js';

const VERSION = 1;
const TTL = 10_000;
const MAX_ENTRIES = 1000;
const MAX_FILE = 4096;
const DIRTY_VERSION = 1;
const RD = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

export interface RepoEntry {
  name: string;
  branch: string | null;
  detached: boolean;
  activity: number | null;
  hidden: boolean;
}

export interface WorkspaceRepos {
  root: string;
  repos: RepoEntry[];
  total: number;
  dirty?: Record<string, boolean>;
  // when readRepos read the dirty cache: its time, or null without one
  dirtyAt?: number | null;
}

export interface HeadInfo {
  branch: string | null;
  detached: boolean;
  gitdir: string | null;
}

export function ancestors(start: string, p: path.PlatformPath = path): string[] {
  const out: string[] = [];
  let d = p.resolve(start);
  for (let i = 0; i < 64; i++) {
    out.push(d);
    const up = p.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

// follows symlinks; never spawns git
export function findUp(
  start: string,
  name: string,
  kind: 'any' | 'dir',
  p: path.PlatformPath = path,
): string | null {
  for (const d of ancestors(start, p)) {
    try {
      const st = fs.statSync(p.join(d, name), { throwIfNoEntry: false });
      if (st && (kind === 'any' || st.isDirectory())) return d;
    } catch {}
  }
  return null;
}

const isWin = (p: path.PlatformPath): boolean => p === path.win32 || process.platform === 'win32';

export function isHome(d: string, home: string, p: path.PlatformPath = path): boolean {
  const a = p.resolve(d);
  const b = p.resolve(home);
  return isWin(p) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function atOrAbove(d: string, stop: string, p: path.PlatformPath): boolean {
  const norm = (x: string) => (isWin(p) ? p.resolve(x).toLowerCase() : p.resolve(x));
  const a = norm(d);
  const b = norm(stop);
  return a === b || b.startsWith(a.endsWith(p.sep) ? a : a + p.sep);
}

// longest ceiling at or above start; the start dir itself is always checked
export function ceilingStop(
  start: string,
  env: NodeJS.ProcessEnv | undefined,
  p: path.PlatformPath = path,
): string | null {
  if (!env) return null;
  const win = isWin(p);
  let raw: string | undefined;
  for (const k of Object.keys(env)) {
    if ((win ? k.toUpperCase() : k) === 'GIT_CEILING_DIRECTORIES' && env[k] !== undefined) raw = env[k];
  }
  if (!raw) return null;
  const norm = (x: string) => (win ? x.toLowerCase() : x);
  const s = norm(p.resolve(start));
  let best: string | null = null;
  for (const c of raw.split(p.delimiter)) {
    if (!c || !p.isAbsolute(c)) continue;
    const r = p.resolve(c);
    const n = norm(r);
    const prefix = n.endsWith(p.sep) ? n : n + p.sep;
    if (n !== s && !s.startsWith(prefix)) continue;
    if (best === null || r.length > best.length) best = r;
  }
  return best;
}

// ignores GIT_DIR and GIT_WORK_TREE on purpose; follows a symlinked .git like readHead
export function insideRepo(
  start: string,
  p: path.PlatformPath = path,
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): string | null {
  const win = isWin(p);
  const e = opts.env;
  const home = opts.home ?? (win ? (e?.USERPROFILE ?? e?.HOME) : e?.HOME) ?? os.homedir();
  const stop = ceilingStop(start, opts.env, p);
  for (const [i, d] of ancestors(start, p).entries()) {
    if (stop !== null && i > 0 && atOrAbove(d, stop, p)) break;
    if (isHome(d, home, p)) continue;
    try {
      if (fs.statSync(p.join(d, '.git'), { throwIfNoEntry: false })) return d;
    } catch {}
  }
  return null;
}

// nonblocking open, so a FIFO never hangs the render
export function readSmall(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, RD);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function gitdirOf(text: string, childDir: string, p: path.PlatformPath = path): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  return m ? p.resolve(childDir, m[1]!) : null;
}

export function parseHead(raw: string): { branch: string | null; detached: boolean } {
  const head = raw.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) {
    // reftable stub
    if (ref[1] === '.invalid') return { branch: null, detached: false };
    return { branch: sanitizeText(ref[1]!) || null, detached: false };
  }
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) return { branch: head.slice(0, 7), detached: true };
  return { branch: null, detached: false };
}

export function readHead(childDir: string, p: path.PlatformPath = path): HeadInfo {
  try {
    const dotgit = p.join(childDir, '.git');
    const st = fs.statSync(dotgit, { throwIfNoEntry: false });
    let gitdir: string | null = null;
    if (st?.isDirectory()) gitdir = dotgit;
    else if (st?.isFile()) {
      const text = readSmall(dotgit);
      gitdir = text === null ? null : gitdirOf(text, childDir, p);
    }
    if (!gitdir) return { branch: null, detached: false, gitdir: null };
    const head = readSmall(p.join(gitdir, 'HEAD'));
    return { ...(head === null ? { branch: null, detached: false } : parseHead(head)), gitdir };
  } catch {
    return { branch: null, detached: false, gitdir: null };
  }
}

function activity(gitdir: string): number | null {
  let best: number | null = null;
  for (const f of ['HEAD', 'index']) {
    try {
      const st = fs.statSync(path.join(gitdir, f), { throwIfNoEntry: false });
      if (st && (best === null || st.mtimeMs > best)) best = st.mtimeMs;
    } catch {}
  }
  return best;
}

const byName = (a: RepoEntry, b: RepoEntry): number => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

// exact: only folders whose name survives sanitizing, so it can be joined back
export function scanRepos(
  cwd: string,
  opts: { exact?: boolean } = {},
): { repos: RepoEntry[]; total: number } {
  const repos: RepoEntry[] = [];
  let dir: fs.Dir | undefined;
  try {
    dir = fs.opendirSync(cwd);
    for (let i = 0; i < MAX_ENTRIES; i++) {
      const ent = dir.readSync();
      if (!ent) break;
      const name = ent.name;
      if (name === 'node_modules') continue;
      const child = path.join(cwd, name);
      let isDir = ent.isDirectory();
      if (!isDir && ent.isSymbolicLink()) {
        try {
          isDir = fs.statSync(child).isDirectory();
        } catch {}
      }
      if (!isDir) continue;
      const clean = sanitizeText(name);
      if (opts.exact && clean !== name) continue;
      const h = readHead(child);
      if (!h.gitdir) continue;
      repos.push({
        name: clean,
        branch: h.branch,
        detached: h.detached,
        activity: activity(h.gitdir),
        hidden: name.startsWith('.'),
      });
    }
  } catch {
  } finally {
    try {
      dir?.closeSync();
    } catch {}
  }
  repos.sort(byName);
  return { repos, total: repos.length };
}

// the widget's order: hidden folders only on request, newest first for recent
export function pickRepos(repos: RepoEntry[], includeHidden: boolean, sort: string): RepoEntry[] {
  const list = repos.filter((r) => includeHidden || !r.hidden);
  if (sort === 'recent') {
    list.sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0) || (a.name < b.name ? -1 : 1));
  }
  return list;
}

export const reposCacheName = (root: string): string => `repos-${cacheKey(root)}.json`;

function isEntry(v: unknown): v is RepoEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.name === 'string' &&
    (e.branch === null || typeof e.branch === 'string') &&
    typeof e.detached === 'boolean' &&
    (e.activity === null || typeof e.activity === 'number') &&
    typeof e.hidden === 'boolean'
  );
}

function fromCache(
  raw: unknown,
  now: number,
  dirMtime: number,
): { repos: RepoEntry[]; total: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.v !== VERSION || typeof c.at !== 'number' || c.dirMtime !== dirMtime) return null;
  if (now < c.at || now - c.at >= TTL) return null;
  if (!Array.isArray(c.repos) || !c.repos.every(isEntry) || typeof c.total !== 'number') return null;
  if (tooDeep(c.repos)) return null;
  return deepSanitize({ repos: c.repos as RepoEntry[], total: c.total });
}

export function readRepos(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { persist?: boolean; now?: number } = {},
): WorkspaceRepos | null {
  try {
    if (insideRepo(cwd, path, { env })) return null;
  } catch {}
  const root = path.resolve(cwd);
  try {
    const st = fs.statSync(root, { throwIfNoEntry: false });
    if (!st?.isDirectory()) return { root, repos: [], total: 0 };
    const now = opts.now ?? Date.now();
    const name = reposCacheName(root);
    const hit = fromCache(readCache<unknown>(name, env), now, st.mtimeMs);
    const scan = hit ?? scanRepos(root);
    if (!hit && opts.persist !== false) {
      writeCache(name, { v: VERSION, at: now, dirMtime: st.mtimeMs, ...scan }, env);
    }
    if (!scan.total) return { root, ...scan };
    const d = readDirty(root, env);
    return d ? { root, ...scan, dirty: d.dirty, dirtyAt: d.at } : { root, ...scan, dirtyAt: null };
  } catch {
    return { root, repos: [], total: 0 };
  }
}

export const reposKey = (cwd: string): string => `repos-dirty-${cacheKey(path.resolve(cwd))}`;

// phase 5 cache, read only as a fallback
export function legacyDirtyFile(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return cacheFile(`${reposKey(cwd)}.json`, env);
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cleanDirty(src: unknown): Record<string, boolean> | null {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const dirty = Object.create(null) as Record<string, boolean>;
  for (const [k, v] of Object.entries(src)) {
    const name = sanitizeText(k);
    if (typeof v === 'boolean' && name && !BAD_KEYS.has(name)) dirty[name] = v;
  }
  return dirty;
}

export function readLegacyDirty(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): { at: number; dirty: Record<string, boolean> } | null {
  const raw = readJsonSafe<Record<string, unknown>>(cacheFile(`${key}.json`, env));
  if (!raw || typeof raw !== 'object' || raw.v !== DIRTY_VERSION) return null;
  const at = raw.at;
  const dirty = cleanDirty(raw.dirty);
  if (typeof at !== 'number' || !Number.isFinite(at) || !dirty) return null;
  return { at, dirty };
}

export function readDirty(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { at: number; dirty: Record<string, boolean> } | null {
  const key = reposKey(cwd);
  const v = jobValue(readEnvelope<ReposDirtyValue>(key, env));
  if (!v) return readLegacyDirty(key, env);
  const dirty = cleanDirty(v.value?.dirty);
  return dirty && v.at !== null ? { at: v.at, dirty } : null;
}

// same parsing as opt(): true or 'true'
const flag = (v: unknown) => v === true || v === 'true';

export function repoDirtyWanted(config: Config): boolean {
  return config.lines.some((line) =>
    line.some((it) => it.type === 'workspace-repos' && flag(it.options?.dirty)),
  );
}
