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

const VERSION = 2;
const MAX_UP = 20;
const MAX_JSON = 1024 * 1024;
const MAX_CLAUDE_JSON = 50 * 1024 * 1024;
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

function claudeJsonFacts(v: Record<string, unknown>, key: string): Facts {
  const projects = v.projects;
  const entry = isObj(projects) && Object.hasOwn(projects, key) ? projects[key] : null;
  const p: Record<string, unknown> = isObj(entry) ? entry : {};
  return {
    ...withLists(
      NONE,
      { ...approvals(p), s: serverNames(v.mcpServers), p: serverNames(p.mcpServers) },
      p.enableAllProjectMcpServers === true,
    ),
    k: key,
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

function gitRoot(launch: string, stopAt?: string): string {
  for (const d of launchAncestors(launch, stopAt)) if (stat(path.join(d, '.git'))) return d;
  return launch;
}

function projectRoot(launch: string, stopAt?: string): string {
  for (const d of launchAncestors(launch, stopAt)) {
    if (stat(path.join(d, '.git')) || stat(path.join(d, '.claude'))?.isDirectory()) return d;
  }
  return launch;
}

const listManaged = (dir: string): string[] => {
  if (!stat(dir)?.isDirectory()) return [];
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const MD_CLAUDE = ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')];
const MD_AGENTS = ['AGENTS.md', path.join('.claude', 'AGENTS.md')];

export function envCacheName(projectDir: string, cwd: string): string {
  return `env-${cacheKey(path.resolve(projectDir), path.resolve(cwd))}.json`;
}

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
    const cached = fromCache(readCache<unknown>(name, env));
    const prev = new Map<string, Sig>((cached?.files ?? []).map((f) => [f[0], f]));
    let changed = !cached;
    const sigs: Sig[] = [];
    const files: string[] = [];

    const json = (
      file: string,
      parse: (v: Record<string, unknown>) => Facts = settingsFacts,
      max = MAX_JSON,
      fits: (f: Facts | null) => boolean = () => true,
    ): Facts | null => {
      const st = stat(file);
      if (!st?.isFile() || st.size > max) {
        if (prev.has(file)) changed = true;
        return null;
      }
      const old = prev.get(file);
      let facts: Facts | null;
      if (old && old[1] === st.mtimeMs && old[2] === st.size && fits(old[3])) facts = old[3];
      else {
        const v = readJson(file, max);
        facts = v ? parse(v) : null;
        changed = true;
      }
      sigs.push([file, st.mtimeMs, st.size, facts]);
      if (facts) files.push(file);
      return facts;
    };

    const seen = new Set<string>();
    const md = (file: string): boolean => {
      const resolved = path.resolve(file);
      const k = platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seen.has(k) || !stat(file)?.isFile()) return false;
      seen.add(k);
      files.push(resolved);
      return true;
    };

    const cdir = claudeDir(env);
    const bases = opts.managedDir ? [opts.managedDir] : managedDirs(platform, env);
    const managed = bases.flatMap((b) => managedFilesIn(b, listManaged)).map((f) => json(f));
    const user = json(path.join(cdir, 'settings.json'));
    const project = json(projectSettingsPath(launch, false));
    const local = json(projectSettingsPath(launch, true));
    const dirs = launchAncestors(launch, opts.stopAt);

    const key = mcpProjectKey(gitRoot(launch, opts.stopAt), platform);
    const cj = json(
      claudeJsonPath(env),
      (v) => claudeJsonFacts(v, key),
      MAX_CLAUDE_JSON,
      (f) => !f || f.k === key,
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
        path.join(projectRoot(launch, opts.stopAt), '.claude', 'rules'),
      ];
      const fresh =
        scan &&
        now >= scan.at &&
        now - scan.at < RULE_TTL &&
        roots.every((r) => scan!.dirs.some((d) => d[0] === r)) &&
        scan.dirs.every(([d, m]) => (stat(d)?.mtimeMs ?? -1) === m);
      if (!fresh) {
        scan = scanRules(roots, now);
        changed = true;
      }
      rules = scan!.count;
    }

    if (sigs.length !== prev.size) changed = true;
    if (changed && opts.persist !== false) writeCache(name, { v: VERSION, files: sigs, rules: scan }, env);
    return { claudeMd, agentsMd, rules, mcp: servers.size, hooks, hooksDisabled, files };
  } catch {
    return null;
  }
}
