import fs from 'node:fs';
import path from 'node:path';
import {
  claudeDir,
  claudeJsonPath,
  managedDirs,
  managedFilesIn,
  projectSettingsPath,
} from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import { cacheKey, readCache, writeCache } from './cache.js';

const VERSION = 3;
const MAX_UP = 20;
const MAX_JSON = 1024 * 1024;
const MAX_CLAUDE_JSON = 8 * 1024 * 1024;
const SETTLE_MS = 30_000;
const MAX_NAMES = 1000;
const MAX_NAME = 256;
const RULE_DEPTH = 5;
const RULE_FILES = 500;
const RULE_DIRS = 200;
const RULE_TTL = 60_000;
const MAX_HOOKS = 100_000;
const RD = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
const AGENTS_PLUGIN = 'cc-plugin-agents-md@builtin';
const MODES = new Set(['claude-md-or-agents-md', 'claude-md-and-agents-md', 'claude-md', 'managed-only']);

export interface EnvCounts {
  claudeMd: number;
  agentsMd: number;
  rules: number;
  mcp: number;
  hooks: number;
  hooksDisabled: boolean;
  mcpHealth?: { ok: number; total: number };
  files: string[];
}

export interface EnvOptions {
  persist?: boolean;
  now?: number;
  platform?: NodeJS.Platform;
  managedDir?: string;
  stopAt?: string;
}

// h: handlers, d: disableAllHooks, m: allowManagedHooksOnly, i: instructionFiles,
// a/e/x: project mcp approvals, s: servers, p: project entry servers, k: project key
interface Facts {
  h: number;
  d: boolean | null;
  m: boolean;
  i: string | null;
  a?: boolean;
  e?: string[];
  x?: string[];
  s?: string[];
  p?: string[];
  k?: string;
}
type Sig = [string, number, number, Facts | null];
interface RuleScan {
  at: number;
  dirs: [string, number][];
  count: number;
}
interface Cached {
  files: Sig[];
  rules: RuleScan | null;
}
// a dir whose mtime moved re-checks only the names probed in it
type Group = [string, number, [string, 0 | 1][] | null];
interface Fast {
  at: number;
  exp: number;
  key: string;
  groups: Group[];
  sigs: [string, number, number][];
  counts: EnvCounts;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function stat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

export function launchAncestors(start: string, stopAt?: string, p: path.PlatformPath = path): string[] {
  const out: string[] = [];
  const stop = stopAt === undefined ? null : p.resolve(stopAt);
  let d = p.resolve(start);
  for (let i = 0; i < MAX_UP; i++) {
    out.push(d);
    const up = p.dirname(d);
    if (d === stop || up === d) break;
    d = up;
  }
  return out;
}

// nonblocking open, so a FIFO never hangs the render
function readJson(file: string, max: number): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, RD);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    const text = buf.toString('utf8', 0, n);
    const v: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return isObj(v) ? v : null;
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

function readText(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, RD);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 4096) return null;
    const buf = Buffer.alloc(st.size);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, st.size, 0));
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

function countHooks(v: unknown): number {
  if (!isObj(v)) return 0;
  let n = 0;
  for (const groups of Object.values(v)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (isObj(g) && Array.isArray(g.hooks)) n += g.hooks.filter(isObj).length;
    }
  }
  return Math.min(n, MAX_HOOKS);
}

function factsOf(v: Record<string, unknown>): Facts {
  const cfg =
    isObj(v.pluginConfigs) && Object.hasOwn(v.pluginConfigs, AGENTS_PLUGIN)
      ? v.pluginConfigs[AGENTS_PLUGIN]
      : null;
  const mode = isObj(cfg) && isObj(cfg.options) ? cfg.options.instructionFiles : null;
  return {
    h: countHooks(v.hooks),
    d: typeof v.disableAllHooks === 'boolean' ? v.disableAllHooks : null,
    m: v.allowManagedHooksOnly === true,
    i: typeof mode === 'string' && MODES.has(mode) ? mode : null,
  };
}

function cleanNames(list: unknown[]): string[] {
  const out = new Set<string>();
  for (const n of list) {
    if (out.size >= MAX_NAMES) break;
    if (typeof n !== 'string') continue;
    const c = sanitizeText(n).slice(0, MAX_NAME);
    if (c) out.add(c);
  }
  return [...out];
}

const serverNames = (v: unknown): string[] => (isObj(v) ? cleanNames(Object.keys(v)) : []);
const nameList = (v: unknown): string[] => (Array.isArray(v) ? cleanNames(v) : []);

// managedMcpServers: an object like mcpServers, or a list of names
const managedNames = (v: unknown): string[] =>
  Array.isArray(v)
    ? cleanNames(v.map((x) => (isObj(x) && typeof x.name === 'string' ? x.name : x)))
    : serverNames(v);

const NONE: Facts = { h: 0, d: null, m: false, i: null };

function withLists(f: Facts, lists: Partial<Record<'e' | 'x' | 's' | 'p', string[]>>, all: boolean): Facts {
  const out: Facts = { ...f };
  if (all) out.a = true;
  for (const [k, v] of Object.entries(lists) as ['e' | 'x' | 's' | 'p', string[]][]) if (v.length) out[k] = v;
  return out;
}

function approvals(v: Record<string, unknown>) {
  return { e: nameList(v.enabledMcpjsonServers), x: nameList(v.disabledMcpjsonServers) };
}

const settingsFacts = (v: Record<string, unknown>): Facts =>
  withLists(
    factsOf(v),
    { ...approvals(v), s: managedNames(v.managedMcpServers) },
    v.enableAllProjectMcpServers === true,
  );

const mcpFacts = (v: Record<string, unknown>): Facts =>
  withLists(NONE, { s: serverNames(v.mcpServers) }, false);

const loose = (k: string) => k.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// exact keys first, then a case-insensitive match where the filesystem is
function projectEntry(projects: unknown, keys: string[], fold: boolean): unknown {
  if (!isObj(projects)) return null;
  for (const k of keys) if (Object.hasOwn(projects, k)) return projects[k];
  if (!fold) return null;
  const want = keys.map(loose);
  for (const w of want) for (const k of Object.keys(projects)) if (loose(k) === w) return projects[k];
  return null;
}

function claudeJsonFacts(v: Record<string, unknown>, keys: string[], fold: boolean): Facts {
  const entry = projectEntry(v.projects, keys, fold);
  const p: Record<string, unknown> = isObj(entry) ? entry : {};
  return {
    ...withLists(
      NONE,
      { ...approvals(p), s: serverNames(v.mcpServers), p: serverNames(p.mcpServers) },
      p.enableAllProjectMcpServers === true,
    ),
    k: `${fold ? 'i' : ''}\n${keys.join('\n')}`,
  };
}

const isNames = (v: unknown): boolean =>
  v === undefined ||
  (Array.isArray(v) &&
    v.length <= MAX_NAMES &&
    v.every((n) => typeof n === 'string' && n.length > 0 && n.length <= MAX_NAME));

function isFacts(v: unknown): v is Facts {
  if (!isObj(v)) return false;
  return (
    (v.a === undefined || v.a === true) &&
    isNames(v.e) &&
    isNames(v.x) &&
    isNames(v.s) &&
    isNames(v.p) &&
    (v.k === undefined || typeof v.k === 'string') &&
    Number.isInteger(v.h) &&
    (v.h as number) >= 0 &&
    (v.h as number) <= MAX_HOOKS &&
    (v.d === null || typeof v.d === 'boolean') &&
    typeof v.m === 'boolean' &&
    (v.i === null || (typeof v.i === 'string' && MODES.has(v.i)))
  );
}

const isPair = (d: unknown): d is [string, number] =>
  Array.isArray(d) && d.length === 2 && typeof d[0] === 'string' && typeof d[1] === 'number';

function fromCache(raw: unknown): Cached | null {
  if (!isObj(raw) || raw.v !== VERSION || !Array.isArray(raw.files)) return null;
  const files: Sig[] = [];
  for (const f of raw.files) {
    if (!Array.isArray(f) || f.length !== 4) return null;
    const [p, m, s, facts] = f as unknown[];
    if (typeof p !== 'string' || typeof m !== 'number' || typeof s !== 'number') return null;
    if (facts !== null && !isFacts(facts)) return null;
    files.push([p, m, s, facts]);
  }
  const r = raw.rules;
  if (r === null || r === undefined) return { files, rules: null };
  if (
    !isObj(r) ||
    typeof r.at !== 'number' ||
    !Number.isInteger(r.count) ||
    (r.count as number) < 0 ||
    (r.count as number) > RULE_FILES ||
    !Array.isArray(r.dirs) ||
    !r.dirs.every(isPair)
  ) {
    return null;
  }
  return { files, rules: { at: r.at, dirs: r.dirs as [string, number][], count: r.count as number } };
}

const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function isCounts(v: unknown): v is EnvCounts {
  return (
    isObj(v) &&
    isCount(v.claudeMd) &&
    isCount(v.agentsMd) &&
    isCount(v.rules) &&
    isCount(v.mcp) &&
    isCount(v.hooks) &&
    typeof v.hooksDisabled === 'boolean' &&
    Array.isArray(v.files) &&
    v.files.every((f) => typeof f === 'string')
  );
}

function sameStat(p: string, m: number, z: number): boolean {
  const st = stat(p);
  return st ? st.mtimeMs === m && (z < 0 || st.size === z) : m === -1;
}

// valid while no probed file, dir or name changed
function fastHit(raw: unknown, key: string, now: number): EnvCounts | null {
  if (!isObj(raw) || raw.v !== VERSION || !isObj(raw.fast)) return null;
  const f = raw.fast as unknown as Fast;
  if (f.key !== key || typeof f.at !== 'number' || typeof f.exp !== 'number') return null;
  if (now < f.at || now >= f.exp || !isCounts(f.counts)) return null;
  if (!Array.isArray(f.sigs) || !Array.isArray(f.groups)) return null;
  for (const x of f.sigs) {
    if (!Array.isArray(x) || typeof x[0] !== 'string' || !sameStat(x[0], x[1], x[2])) return null;
  }
  for (const g of f.groups) {
    if (!Array.isArray(g) || typeof g[0] !== 'string' || typeof g[1] !== 'number') return null;
    const [dir, m, names] = g;
    const now = stat(dir)?.mtimeMs ?? -1;
    if (now === m) continue;
    if (!Array.isArray(names) || now === -1 || m === -1) return null;
    for (const n of names) {
      if (!Array.isArray(n) || typeof n[0] !== 'string') return null;
      if ((stat(path.join(dir, n[0])) ? 1 : 0) !== n[1]) return null;
    }
  }
  return { ...f.counts, files: [...f.counts.files] };
}

function scanRules(roots: string[], now: number): RuleScan {
  const dirs: [string, number][] = roots.map((r) => [r, stat(r)?.mtimeMs ?? -1]);
  const visited = new Set<string>();
  let count = 0;
  const walk = (dir: string, depth: number): void => {
    if (count >= RULE_FILES || dirs.length >= RULE_DIRS) return;
    const st = stat(dir);
    if (!st?.isDirectory()) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    if (depth > 0) dirs.push([dir, st.mtimeMs]);
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subs: string[] = [];
    for (const e of ents) {
      const p = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        const s = stat(p);
        isDir = !!s?.isDirectory();
        isFile = !!s?.isFile();
      }
      if (isFile && e.name.toLowerCase().endsWith('.md')) {
        if (count < RULE_FILES) count++;
      } else if (isDir && depth < RULE_DEPTH) subs.push(p);
    }
    for (const s of subs) walk(s, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return { at: now, dirs, count };
}

export function mcpProjectKey(dir: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? dir.replace(/\\/g, '/') : dir;
}

type Stat = (p: string) => fs.Stats | undefined;

function gitRoot(launch: string, stopAt: string | undefined, st0: Stat): { root: string; linked: boolean } {
  for (const d of launchAncestors(launch, stopAt)) {
    const st = st0(path.join(d, '.git'));
    if (st) return { root: d, linked: st.isFile() };
  }
  return { root: launch, linked: false };
}

// a linked worktree's main checkout, from .git and commondir
function mainCheckout(root: string): string | null {
  const ref = readText(path.join(root, '.git'));
  const m = ref === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(ref);
  if (!m) return null;
  const gitdir = path.resolve(root, m[1]!);
  const common = readText(path.join(gitdir, 'commondir'))?.trim();
  if (!common) return null;
  const dir = path.resolve(gitdir, common);
  return path.basename(dir) === '.git' ? path.dirname(dir) : null;
}

function projectRoot(launch: string, stopAt: string | undefined, st: Stat): string {
  for (const d of launchAncestors(launch, stopAt)) {
    if (st(path.join(d, '.git')) || st(path.join(d, '.claude'))?.isDirectory()) return d;
  }
  return launch;
}

const MD_CLAUDE = ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')];
const MD_AGENTS = ['AGENTS.md', path.join('.claude', 'AGENTS.md')];

export function envCacheName(projectDir: string, cwd: string): string {
  return `env-${cacheKey(path.resolve(projectDir), path.resolve(cwd))}.json`;
}

interface Input {
  platform: NodeJS.Platform;
  now: number;
  launch: string;
  name: string;
  cdir: string;
  cjPath: string;
  bases: string[];
  fastKey: string;
  raw: unknown;
}

// small on purpose: a cache hit never compiles the full read
export function readEnvironment(
  projectDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: EnvOptions = {},
): EnvCounts | null {
  try {
    const platform = opts.platform ?? process.platform;
    const now = opts.now ?? Date.now();
    const launch = path.resolve(projectDir);
    const name = envCacheName(launch, cwd);
    const cdir = claudeDir(env);
    const cjPath = claudeJsonPath(env);
    const bases = opts.managedDir ? [opts.managedDir] : managedDirs(platform, env);
    const fastKey = JSON.stringify([launch, cdir, cjPath, bases, platform, opts.stopAt ?? null]);
    const raw = readCache<unknown>(name, env);
    return (
      fastHit(raw, fastKey, now) ??
      fullRead({ platform, now, launch, name, cdir, cjPath, bases, fastKey, raw }, env, opts)
    );
  } catch {
    return null;
  }
}

function fullRead(input: Input, env: NodeJS.ProcessEnv, opts: EnvOptions): EnvCounts | null {
  try {
    const { platform, now, launch, name, cdir, cjPath, bases, fastKey, raw } = input;
    const cached = fromCache(raw);
    const prev = new Map<string, Sig>((cached?.files ?? []).map((f) => [f[0], f]));
    const sigs: Sig[] = [];
    const files: string[] = [];
    const live: [string, number, number][] = [];
    let exp = now + RULE_TTL;

    const memo = new Map<string, fs.Stats | undefined>();
    const st0: Stat = (p) => {
      if (memo.has(p)) return memo.get(p);
      const v = stat(p);
      memo.set(p, v);
      return v;
    };
    const groups = new Map<string, Set<string>>();
    const strict = new Set<string>();
    // a missing parent is probed as a name in its own parent
    const look = (file: string): void => {
      const dir = path.dirname(file);
      if (dir === file) return;
      if (!st0(dir)?.isDirectory()) {
        look(dir);
        return;
      }
      const g = groups.get(dir) ?? new Set<string>();
      groups.set(dir, g);
      g.add(path.basename(file));
    };
    const exists: Stat = (p) => {
      look(p);
      return st0(p);
    };
    const listManaged = (dir: string): string[] => {
      if (!exists(dir)?.isDirectory()) return [];
      strict.add(dir);
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    };

    const fold = (f: string) => (platform === 'win32' ? path.resolve(f).toLowerCase() : path.resolve(f));
    // HOME as launch dir: project settings are the user settings
    const read = new Set<string>();
    const json = (
      file: string,
      parse: (v: Record<string, unknown>) => Facts = settingsFacts,
      max = MAX_JSON,
      fits: (f: Facts | null) => boolean = () => true,
      settle = false,
    ): Facts | null => {
      const k = fold(file);
      if (read.has(k)) return null;
      read.add(k);
      const st = exists(file);
      if (st?.isFile()) live.push([file, st.mtimeMs, st.size]);
      const old = prev.get(file);
      const keep = old !== undefined && old[3] !== null && fits(old[3]);
      // a big or busy file keeps its last facts until it settles
      if (
        st?.isFile() &&
        keep &&
        settle &&
        (st.size > max || (now >= st.mtimeMs && now - st.mtimeMs < SETTLE_MS))
      ) {
        if (st.size <= max) exp = Math.min(exp, st.mtimeMs + SETTLE_MS);
        sigs.push(old);
        files.push(file);
        return old[3];
      }
      if (!st?.isFile() || st.size > max) {
        return null;
      }
      let facts: Facts | null;
      if (old && old[1] === st.mtimeMs && old[2] === st.size && fits(old[3])) facts = old[3];
      else {
        const v = readJson(file, max);
        facts = v ? parse(v) : null;
      }
      sigs.push([file, st.mtimeMs, st.size, facts]);
      if (facts) files.push(file);
      return facts;
    };

    const seen = new Set<string>();
    const md = (file: string): boolean => {
      const k = fold(file);
      if (seen.has(k) || !exists(file)?.isFile()) return false;
      seen.add(k);
      files.push(path.resolve(file));
      return true;
    };

    const managed = bases.flatMap((b) => managedFilesIn(b, listManaged)).map((f) => json(f));
    const user = json(path.join(cdir, 'settings.json'));
    const project = json(projectSettingsPath(launch, false));
    const local = json(projectSettingsPath(launch, true));
    const dirs = launchAncestors(launch, opts.stopAt);

    const { root, linked } = gitRoot(launch, opts.stopAt, exists);
    const main = linked ? mainCheckout(root) : null;
    const keys = [
      ...new Set([root, ...(main ? [main] : [])].flatMap((d) => [mcpProjectKey(d, platform), d])),
    ];
    const ci = platform === 'win32' || platform === 'darwin';
    const key = `${ci ? 'i' : ''}\n${keys.join('\n')}`;
    const cj = json(
      cjPath,
      (v) => claudeJsonFacts(v, keys, ci),
      MAX_CLAUDE_JSON,
      (f) => !f || f.k === key,
      true,
    );
    const projectMcp = dirs
      .filter((d) => path.dirname(d) !== d)
      .map((d) => json(path.join(d, '.mcp.json'), mcpFacts));
    const exclusive = bases
      .map((b) => json(path.join(b, 'managed-mcp.json'), mcpFacts))
      .filter((f) => f !== null);
    const added = managed.flatMap((f) => f?.s ?? []);
    const servers = new Set<string>(added);
    if (exclusive.length) for (const f of exclusive) for (const n of f.s ?? []) servers.add(n);
    else {
      const layers = [...managed, user, project, local, cj];
      const all = layers.some((f) => f?.a === true);
      const enabled = new Set(layers.flatMap((f) => f?.e ?? []));
      const disabled = new Set(layers.flatMap((f) => f?.x ?? []));
      for (const n of [...(cj?.s ?? []), ...(cj?.p ?? [])]) servers.add(n);
      for (const f of projectMcp) {
        for (const n of f?.s ?? []) if ((all || enabled.has(n)) && !disabled.has(n)) servers.add(n);
      }
    }

    let mHooks = 0;
    let mDisable: boolean | null = null;
    let mOnly = false;
    let mMode: string | null = null;
    for (const f of managed) {
      if (!f) continue;
      mHooks += f.h;
      if (f.d !== null) mDisable = f.d;
      if (f.m) mOnly = true;
      if (f.i !== null) mMode = f.i;
    }
    const mode = mMode ?? user?.i ?? 'claude-md-or-agents-md';

    const disable = [mDisable, local?.d, project?.d, user?.d].find((x) => typeof x === 'boolean') ?? false;
    let hooks: number;
    let hooksDisabled = false;
    if (disable) {
      hooks = mDisable === true ? 0 : mHooks;
      hooksDisabled = hooks === 0;
    } else hooks = mOnly ? mHooks : mHooks + (user?.h ?? 0) + (project?.h ?? 0) + (local?.h ?? 0);

    let claudeMd = 0;
    for (const b of bases) if (md(path.join(b, 'CLAUDE.md'))) claudeMd++;
    let agentsMd = 0;
    let rules = 0;
    let scan = cached?.rules ?? null;
    if (mode !== 'managed-only') {
      if (md(path.join(cdir, 'CLAUDE.md'))) claudeMd++;
      let projectMd = 0;
      for (const d of dirs) for (const n of MD_CLAUDE) if (md(path.join(d, n))) projectMd++;
      claudeMd += projectMd;
      if (mode === 'claude-md-and-agents-md' || (mode === 'claude-md-or-agents-md' && projectMd === 0)) {
        for (const d of dirs) for (const n of MD_AGENTS) if (md(path.join(d, n))) agentsMd++;
      }
      const roots = [
        path.join(cdir, 'rules'),
        path.join(projectRoot(launch, opts.stopAt, exists), '.claude', 'rules'),
      ];
      const fresh =
        scan &&
        now >= scan.at &&
        now - scan.at < RULE_TTL &&
        roots.every((r) => scan!.dirs.some((d) => d[0] === r)) &&
        scan.dirs.every(([d, m]) => (stat(d)?.mtimeMs ?? -1) === m);
      if (!fresh) {
        scan = scanRules(roots, now);
      }
      rules = scan!.count;
    }

    const counts: EnvCounts = { claudeMd, agentsMd, rules, mcp: servers.size, hooks, hooksDisabled, files };
    if (opts.persist !== false) {
      const rows: Group[] = [...groups].map(([d, names]) => [
        d,
        st0(d)?.mtimeMs ?? -1,
        strict.has(d) ? null : [...names].map((n) => [n, st0(path.join(d, n)) ? 1 : 0]),
      ]);
      for (const d of strict) if (!groups.has(d)) rows.push([d, st0(d)?.mtimeMs ?? -1, null]);
      for (const [d, m] of mode === 'managed-only' ? [] : (scan?.dirs ?? [])) rows.push([d, m, null]);
      const fast: Fast = { at: now, exp, key: fastKey, groups: rows, sigs: live, counts };
      writeCache(name, { v: VERSION, files: sigs, rules: scan, fast }, env);
    }
    return { ...counts, files: [...files] };
  } catch {
    return null;
  }
}
