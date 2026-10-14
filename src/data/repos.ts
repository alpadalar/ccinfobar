import fs from 'node:fs';
import path from 'node:path';
import { deepSanitize, sanitizeText } from '../core/sanitize.js';
import { cacheKey, readCache, writeCache } from './cache.js';

const VERSION = 1;
const TTL = 10_000;
const MAX_ENTRIES = 1000;
const MAX_FILE = 4096;
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

// ignores GIT_DIR and GIT_WORK_TREE on purpose
export function insideRepo(start: string, p: path.PlatformPath = path): string | null {
  for (const d of ancestors(start, p)) {
    try {
      if (fs.lstatSync(p.join(d, '.git'), { throwIfNoEntry: false })) return d;
    } catch {}
  }
  return null;
}

// nonblocking open, so a FIFO never hangs the render
function readSmall(file: string): string | null {
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
    const st = fs.lstatSync(dotgit, { throwIfNoEntry: false });
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

export function scanRepos(cwd: string): { repos: RepoEntry[]; total: number } {
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
      const h = readHead(child);
      if (!h.gitdir) continue;
      repos.push({
        name: sanitizeText(name),
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
  return deepSanitize({ repos: c.repos as RepoEntry[], total: c.total });
}

export function readRepos(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { persist?: boolean; now?: number } = {},
): WorkspaceRepos | null {
  try {
    if (insideRepo(cwd)) return null;
  } catch {}
  const root = path.resolve(cwd);
  try {
    const st = fs.statSync(root, { throwIfNoEntry: false });
    if (!st?.isDirectory()) return { root, repos: [], total: 0 };
    const now = opts.now ?? Date.now();
    const name = reposCacheName(root);
    const hit = fromCache(readCache<unknown>(name, env), now, st.mtimeMs);
    if (hit) return { root, ...hit };
    const scan = scanRepos(root);
    if (opts.persist !== false) writeCache(name, { v: VERSION, at: now, dirMtime: st.mtimeMs, ...scan }, env);
    return { root, ...scan };
  } catch {
    return { root, repos: [], total: 0 };
  }
}
