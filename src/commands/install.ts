import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { claudeDir, claudeJsonPath, claudeSettingsPath, configDir } from '../core/paths.js';
import { HARDEN } from '../data/git.js';
import { type BuiltCommand, buildCommand, type CommandTarget } from './command.js';
import {
  classifyOwner,
  deepEqual,
  dropEntry,
  findStatusLineEntry,
  type Manifest,
  manifestFile,
  type Owner,
  type Restore,
  readManifest,
  realKey,
  recordGitExclude,
  recordStatusLine,
  type StatusLineEntry,
  writeManifest,
} from './manifest.js';
import {
  deleteSettingsFile,
  hashBytes,
  type PatchResult,
  patchSettings,
  readSettings,
  resolveReal,
  writeSettingsBytes,
} from './settings-file.js';
import {
  type InstallKind,
  installKind,
  installVersion,
  installVersionAsync,
  localPrefix,
  npmCommand,
} from './update.js';

export interface StatusLineSetting {
  type: 'command';
  command: string;
  padding?: number;
  refreshInterval?: number;
}

// npx puts its cache on PATH; that is not an install
export function isTransientBin(p: string): boolean {
  return /[\\/](_npx|node_modules[\\/]\.bin)[\\/]/.test(p);
}

export function globalBinary(): string | null {
  try {
    const win = process.platform === 'win32';
    const out = execFileSync(win ? 'where' : 'which', win ? ['ccinfobar'] : ['-a', 'ccinfobar'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
    });
    const hit = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !isTransientBin(l));
    return hit ?? null;
  } catch {
    return null;
  }
}

export function localBin(env: NodeJS.ProcessEnv = process.env): string {
  const bin = path.join(localPrefix(env), 'node_modules', '.bin');
  return path.join(bin, process.platform === 'win32' ? 'ccinfobar.cmd' : 'ccinfobar');
}

export function acceptCommand(built: BuiltCommand, log: (line: string) => void = () => {}): string | null {
  if (built.ok) return built.command;
  log(t('install.unsafePath', { path: built.path, chars: built.chars }));
  return null;
}

// never npx@latest: it runs whatever npm serves
function defaultTarget(kind: InstallKind): CommandTarget | null {
  const bin = globalBinary();
  if (bin) return { kind: 'bin', bin, onPath: true };
  if (fs.existsSync(localBin())) return { kind: 'bin', bin: localBin(), onPath: false };
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (kind !== 'npx' && entry && fs.existsSync(entry)) return { kind: 'script', script: entry };
  return null;
}

export function defaultCommand(
  kind: InstallKind = installKind(),
  log?: (line: string) => void,
): string | null {
  const target = defaultTarget(kind);
  return target ? acceptCommand(buildCommand(target), log) : null;
}

function statusLineOf(data: Record<string, unknown>): StatusLineSetting | null {
  const sl = data.statusLine;
  return sl && typeof sl === 'object' && !Array.isArray(sl) ? (sl as StatusLineSetting) : null;
}

export function currentStatusLine(file = claudeSettingsPath()): StatusLineSetting | null {
  return statusLineOf(readSettings(file).data);
}

const EMPTY: Manifest = { version: 1, entries: [] };
const NO_ORIGINAL = { original: false };

function openManifest(env: NodeJS.ProcessEnv = process.env): Manifest {
  const m = readManifest(env);
  if (m.readOnly) throw new Error(t('install.manifestReadOnly', { file: manifestFile(env) }));
  return m;
}

// defaultCommand() spawns, so only for the unclear case
function classify(m: Manifest, file: string, sl: StatusLineSetting | null, command: string | null): Owner {
  const owner = classifyOwner(m, file, sl, command);
  if (owner !== 'legacy-ask') return owner;
  const def = defaultCommand();
  return def && def !== command ? classifyOwner(m, file, sl, def) : owner;
}

const isMine = (o: Owner) => o === 'ours' || o === 'legacy-ours';

function legacyBackup(file: string): string | null {
  const candidates = [`${file}.ccinfobar-backup`];
  try {
    candidates.push(`${resolveReal(file)}.ccinfobar-backup`);
  } catch {}
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

function legacyPrevious(file: string, command: string | null): StatusLineSetting | null {
  const legacy = legacyBackup(file);
  if (!legacy) return null;
  try {
    const sl = statusLineOf(readSettings(legacy).data);
    if (!sl || typeof sl.command !== 'string') return null;
    return classifyOwner(EMPTY, file, sl, command) === 'legacy-ours' ? null : sl;
  } catch {
    return null;
  }
}

export function statusLineOwner(
  file = claudeSettingsPath(),
  command: string | null = null,
): { current: StatusLineSetting | null; owner: Owner } {
  const current = currentStatusLine(file);
  return { current, owner: classify(readManifest(), file, current, command) };
}

export interface InstallDiff {
  key: 'refreshInterval' | 'padding';
  current: number | null;
  proposed: number | null;
}

export interface InstallPlan {
  file: string;
  real: string;
  current: StatusLineSetting | null;
  proposed: StatusLineSetting;
  owner: Owner;
  changes: boolean;
  needsConfirm: boolean;
  diff: InstallDiff[];
}

export interface InstallResult {
  backup: string | null;
  written: StatusLineSetting;
  replaced: StatusLineSetting | null;
  changed: boolean;
}

export class InstallNeedsConfirmError extends Error {
  constructor(readonly plan: InstallPlan) {
    super(t('install.needsConfirm'));
    this.name = 'InstallNeedsConfirmError';
  }
}

function proposal(command: string, owner: Owner, current: StatusLineSetting | null, refresh?: number) {
  const statusLine: StatusLineSetting = { type: 'command', command, padding: 0 };
  const r = refresh ?? (isMine(owner) ? current?.refreshInterval : undefined);
  if (typeof r === 'number' && Number.isFinite(r) && r > 0) statusLine.refreshInterval = Math.floor(r);
  return statusLine;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function diffOf(current: StatusLineSetting | null, proposed: StatusLineSetting): InstallDiff[] {
  if (!current) return [];
  const out: InstallDiff[] = [];
  for (const key of ['refreshInterval', 'padding'] as const) {
    const a = num(current[key]);
    const b = num(proposed[key]);
    if (a !== b) out.push({ key, current: a, proposed: b });
  }
  return out;
}

// reads only
export function planInstall(opts: {
  file?: string;
  command: string;
  refresh?: number;
  env?: NodeJS.ProcessEnv;
}): InstallPlan {
  const env = opts.env ?? process.env;
  const file = opts.file ?? claudeSettingsPath(env);
  const m = openManifest(env);
  const current = statusLineOf(readSettings(file).data);
  const owner = classify(m, file, current, opts.command);
  const proposed = proposal(opts.command, owner, current, opts.refresh);
  return {
    file,
    real: realKey(file),
    current,
    proposed,
    owner,
    changes: !deepEqual(current, proposed),
    needsConfirm: owner === 'foreign' || owner === 'legacy-ask',
    diff: diffOf(current, proposed),
  };
}

export function applyInstall(
  plan: InstallPlan,
  opts: { confirmed: boolean; adoptLegacy?: boolean; env?: NodeJS.ProcessEnv },
): InstallResult {
  if (plan.needsConfirm && !opts.confirmed) throw new InstallNeedsConfirmError(plan);
  const env = opts.env ?? process.env;
  const { file, proposed } = plan;
  const command = proposed.command;
  const m = openManifest(env);
  const entry = findStatusLineEntry(m, file);
  const res = patchSettings(
    file,
    (settings) => {
      const current = statusLineOf(settings);
      if (!deepEqual(current, plan.current) || classify(m, file, current, command) !== plan.owner)
        throw new InstallNeedsConfirmError(plan);
      settings.statusLine = structuredClone(proposed);
    },
    { original: !entry, env },
  );
  const current = plan.current;
  const owner: Owner = plan.owner === 'legacy-ask' && opts.adoptLegacy ? 'legacy-ours' : plan.owner;
  const previous =
    owner === 'ours'
      ? (entry?.previous ?? null)
      : owner === 'legacy-ours'
        ? legacyPrevious(file, command)
        : current;
  let restore: Restore | null = null;
  if (entry) {
    if (res.beforeHash !== null && res.beforeHash === entry.writtenHash) restore = entry.restore;
  } else if (owner !== 'legacy-ours') {
    if (!res.existed) restore = { absent: true };
    else if (res.backup && res.beforeHash)
      restore = { backup: path.relative(configDir(env), res.backup), hash: res.beforeHash };
  }
  const fileExisted = entry
    ? entry.fileExisted
    : owner === 'legacy-ours'
      ? legacyBackup(file) !== null
      : res.existed;
  try {
    writeManifest(
      recordStatusLine(m, {
        file: res.real,
        value: structuredClone(proposed),
        previous,
        fileExisted,
        restore,
        writtenHash: res.afterHash,
      }),
      env,
    );
  } catch (err) {
    if (res.changed) rollback(file, res, env);
    throw err;
  }
  return { backup: res.backup, written: proposed, replaced: current, changed: res.changed };
}

// no manifest entry: undo our write unless someone changed it since
function rollback(file: string, res: PatchResult, env: NodeJS.ProcessEnv): void {
  try {
    const opts = { env, backup: false, ifHash: res.afterHash };
    if (!res.existed) deleteSettingsFile(file, opts);
    else if (readSettings(file).hash === res.afterHash) writeSettingsBytes(file, res.beforeBytes, opts);
  } catch {}
}

export type UninstallStatus =
  | 'restored-exact'
  | 'restored-previous'
  | 'removed'
  | 'deleted-file'
  | 'foreign'
  | 'gone-restored'
  | 'gone-nothing'
  | 'not-installed';

export interface UninstallResult {
  status: UninstallStatus;
  file: string;
  removed: boolean;
  restored: StatusLineSetting | null;
  current?: StatusLineSetting | null;
}

const REMOVED = new Set<UninstallStatus>([
  'restored-exact',
  'restored-previous',
  'removed',
  'deleted-file',
  'gone-restored',
]);

function backupBytes(restore: { backup: string; hash: string }): Buffer | null {
  try {
    const bytes = fs.readFileSync(path.resolve(configDir(), restore.backup));
    return hashBytes(bytes) === restore.hash ? bytes : null;
  } catch {
    return null;
  }
}

// only while the file is byte-identical to our last write
function restoreExact(file: string, entry: StatusLineEntry, hash: string | null): UninstallStatus | null {
  const r = entry.restore;
  if (!r || !hash || hash !== entry.writtenHash) return null;
  if ('absent' in r)
    return deleteSettingsFile(file, { ...NO_ORIGINAL, ifHash: hash }) ? 'deleted-file' : null;
  const bytes = backupBytes(r);
  if (!bytes) return null;
  writeSettingsBytes(file, bytes, NO_ORIGINAL);
  return 'restored-exact';
}

function restoreKey(
  file: string,
  data: Record<string, unknown>,
  ours: StatusLineSetting,
  previous: StatusLineSetting | null,
  fileExisted: boolean,
  hash: string | null,
): [UninstallStatus, StatusLineSetting | null] {
  const { statusLine: _, ...rest } = data;
  const empty = !previous && !fileExisted && Object.keys(rest).length === 0;
  if (empty && deleteSettingsFile(file, { ...NO_ORIGINAL, ifHash: hash })) return ['deleted-file', null];
  const state = { raced: false };
  patchSettings(
    file,
    (d) => {
      state.raced = !deepEqual(d.statusLine, ours);
      if (state.raced) return;
      if (previous) d.statusLine = previous;
      else delete d.statusLine;
    },
    NO_ORIGINAL,
  );
  if (state.raced) return ['foreign', null];
  return previous ? ['restored-previous', previous] : ['removed', null];
}

export function uninstall(
  file = claudeSettingsPath(),
  opts: { adoptLegacy?: boolean } = {},
): UninstallResult {
  const m = openManifest();
  const cur = readSettings(file);
  const sl = statusLineOf(cur.data);
  const entry = findStatusLineEntry(m, file);
  const done = (
    status: UninstallStatus,
    restored: StatusLineSetting | null = null,
    current?: StatusLineSetting | null,
  ): UninstallResult => {
    if (entry) writeManifest(dropEntry(m, file, 'statusLine'));
    const res: UninstallResult = { status, file, removed: REMOVED.has(status), restored };
    if (current !== undefined) res.current = current;
    return res;
  };
  if (entry) {
    if (!sl) {
      const prev = entry.previous;
      if (!prev) return done('gone-nothing', null, null);
      patchSettings(
        file,
        (d) => {
          if (!statusLineOf(d)) d.statusLine = prev;
        },
        NO_ORIGINAL,
      );
      return done('gone-restored', prev, null);
    }
    if (!deepEqual(sl, entry.value)) return done('foreign', null, sl);
    const exact = restoreExact(file, entry, cur.hash);
    if (exact) return done(exact, exact === 'restored-exact' ? entry.previous : null);
    return done(...restoreKey(file, cur.data, sl, entry.previous, entry.fileExisted, cur.hash));
  }
  if (!sl) return done('not-installed', null, null);
  const owner = classify(m, file, sl, null);
  if (owner === 'legacy-ours' || (owner === 'legacy-ask' && opts.adoptLegacy)) {
    const previous = legacyPrevious(file, null);
    return done(...restoreKey(file, cur.data, sl, previous, legacyBackup(file) !== null, cur.hash));
  }
  return done('foreign', null, sl);
}

export function projectSettingsPath(dir: string, local = true): string {
  return path.join(dir, '.claude', local ? 'settings.local.json' : 'settings.json');
}

function projectRoots(dir: string): string[] {
  const roots = [path.resolve(dir)];
  try {
    const top = execFileSync('git', [...HARDEN, 'rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 2000,
    }).trim();
    if (top && !roots.includes(path.resolve(top))) roots.push(path.resolve(top));
  } catch {}
  return roots;
}

// ours by the manifest, or a plain 0.6.x command
function ownedHere(m: Manifest, file: string, sl: StatusLineSetting | null): boolean {
  return isMine(classifyOwner(m, file, sl, null));
}

export function projectLocalFile(dir: string): string {
  const m = readManifest();
  for (const root of projectRoots(dir)) {
    const file = projectSettingsPath(root);
    try {
      if (ownedHere(m, file, currentStatusLine(file))) return file;
    } catch {}
  }
  return projectSettingsPath(dir);
}

export interface ProjectOverride {
  file: string;
  command: string;
}

// project settings beat ~/.claude/settings.json
export function projectOverride(dir: string): ProjectOverride | null {
  const m = readManifest();
  for (const root of projectRoots(dir)) {
    for (const file of [projectSettingsPath(root, true), projectSettingsPath(root, false)]) {
      let sl: StatusLineSetting | null = null;
      try {
        sl = currentStatusLine(file);
      } catch {}
      if (!sl || typeof sl.command !== 'string') continue;
      return ownedHere(m, file, sl) ? null : { file, command: sl.command };
    }
  }
  return null;
}

// keep settings.local.json out of git
export function ignoreLocally(file: string): boolean {
  const dir = path.dirname(file);
  const git = (args: string[]) =>
    execFileSync('git', [...HARDEN, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 2000,
    }).trim();
  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    return false;
  }
  try {
    git(['check-ignore', '-q', file]);
    return false;
  } catch {}
  try {
    const top = resolveReal(git(['rev-parse', '--show-toplevel']));
    const exclude = path.resolve(dir, git(['rev-parse', '--git-path', 'info/exclude']));
    const inRepo = path.relative(top, resolveReal(file));
    if (!inRepo || inRepo.startsWith('..') || path.isAbsolute(inRepo) || /[\r\n]/.test(inRepo)) return false;
    const rel = `/${inRepo.split(path.sep).join('/')}`.replace(/[\\*?[\]]| (?= *$)/g, '\\$&');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const prev = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    fs.appendFileSync(exclude, `${prev && !prev.endsWith('\n') ? '\n' : ''}${rel}\n`);
    try {
      const m = readManifest();
      if (!m.readOnly) writeManifest(recordGitExclude(m, exclude, rel));
    } catch {}
    return true;
  } catch {
    return false;
  }
}

export function knownProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const projects = (readSettings(claudeJsonPath(env)).data.projects ?? {}) as Record<string, unknown>;
    const own = path.resolve(claudeDir(env));
    return Object.keys(projects).filter((p) => path.resolve(p, '.claude') !== own);
  } catch {
    return [];
  }
}

function ownStatusLine(file: string): string | null {
  try {
    const cmd = currentStatusLine(file)?.command;
    return typeof cmd === 'string' ? cmd : null;
  } catch {
    return null;
  }
}

// GSD's per-project status line
export function gsdProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  return knownProjects(env).filter((root) => {
    const local = ownStatusLine(projectSettingsPath(root));
    if (local !== null) return /gsd-statusline/.test(local);
    return /gsd-statusline/.test(ownStatusLine(projectSettingsPath(root, false)) ?? '');
  });
}

export function takeOverProjects(
  command: string,
  refreshInterval?: number,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const done: string[] = [];
  for (const root of gsdProjects(env)) {
    try {
      const file = projectSettingsPath(root);
      applyInstall(planInstall({ file, command, refresh: refreshInterval, env }), { confirmed: true, env });
      ignoreLocally(file);
      done.push(root);
    } catch {}
  }
  return done;
}

export function releaseProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  const done: string[] = [];
  const m = readManifest();
  for (const root of knownProjects(env)) {
    const file = projectSettingsPath(root);
    try {
      if (!ownedHere(m, file, currentStatusLine(file))) continue;
      if (uninstall(file).removed) done.push(root);
    } catch {}
  }
  return done;
}

export function npmGlobalBin(): string | null {
  try {
    const npm = npmCommand();
    const prefix = execFileSync(npm.file, [...npm.args, 'prefix', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 15_000,
      shell: npm.shell,
    }).trim();
    const bin =
      process.platform === 'win32'
        ? path.join(prefix, 'ccinfobar.cmd')
        : path.join(prefix, 'bin', 'ccinfobar');
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export type GlobalInstall = { ok: true; bin: string; onPath: boolean } | { ok: false; error: string };

// one npm install, run by a sync or async driver
type NpmStep = { version: string; prefix?: string };
type Steps<T> = Generator<NpmStep, T, void>;

function runSync<T>(g: Steps<T>): T {
  for (let r = g.next(); ; ) {
    if (r.done) return r.value;
    let failed: unknown = null;
    try {
      installVersion(r.value.version, r.value.prefix);
    } catch (err) {
      failed = err ?? new Error('npm install failed');
    }
    r = failed ? g.throw(failed) : g.next();
  }
}

async function runAsync<T>(g: Steps<T>): Promise<T> {
  for (let r = g.next(); ; ) {
    if (r.done) return r.value;
    let failed: unknown = null;
    try {
      await installVersionAsync(r.value.version, r.value.prefix);
    } catch (err) {
      failed = err ?? new Error('npm install failed');
    }
    r = failed ? g.throw(failed) : g.next();
  }
}

function* globalSteps(version: string): Steps<GlobalInstall> {
  try {
    yield { version };
  } catch (err) {
    const msg = (err as Error).message;
    return {
      ok: false,
      error: /EACCES|EPERM/.test(msg) ? "no permission to write to npm's global folder (EACCES)" : msg,
    };
  }
  const onPath = globalBinary();
  if (onPath) return { ok: true, bin: onPath, onPath: true };
  const bin = npmGlobalBin();
  return bin
    ? { ok: true, bin, onPath: false }
    : { ok: false, error: 'npm finished but ccinfobar was not found' };
}

// npx runs from a cache; keep a real copy
export function installGlobal(version: string): GlobalInstall {
  return runSync(globalSteps(version));
}

export interface Setup {
  command: string | null;
  onPath: boolean;
}

function setup(command: string | null, onPath: boolean): Setup {
  return { command, onPath: !!command && onPath };
}

export interface SetupOptions {
  global?: boolean;
  log?: (line: string) => void;
}

function* setupSteps(version: string, opts: SetupOptions): Steps<Setup> {
  const log = opts.log ?? (() => {});
  if (installKind() !== 'npx') return setup(defaultCommand(undefined, log), !!globalBinary());
  const existing = globalBinary();
  if (existing)
    return setup(acceptCommand(buildCommand({ kind: 'bin', bin: existing, onPath: true }), log), true);
  if (opts.global !== false) {
    log(`Installing ccinfobar ${version} globally (skip with --no-global) ...`);
    const g = yield* globalSteps(version);
    if (g.ok) {
      log(`✓ Installed ${g.bin}`);
      if (!g.onPath)
        log(`  ${path.dirname(g.bin)} is not on your PATH; add it to type \`ccinfobar\` directly.`);
      return setup(acceptCommand(buildCommand({ kind: 'bin', bin: g.bin, onPath: g.onPath }), log), g.onPath);
    }
    log(`⚠ Global install failed: ${g.error}`);
  }
  log(`Installing a pinned copy of ccinfobar ${version} in ${localPrefix()} ...`);
  try {
    yield { version, prefix: localPrefix() };
  } catch (err) {
    log(`✗ Could not install ccinfobar: ${(err as Error).message}`);
    return { command: null, onPath: false };
  }
  if (!fs.existsSync(localBin())) {
    log('✗ npm finished but ccinfobar was not found');
    return { command: null, onPath: false };
  }
  log(`✓ Installed ${localBin()}`);
  return setup(acceptCommand(buildCommand({ kind: 'bin', bin: localBin(), onPath: false }), log), false);
}

// npx: global command, else a pinned copy under the config dir
export function setupCommand(version: string, opts: SetupOptions = {}): Setup {
  return runSync(setupSteps(version, opts));
}

export function setupCommandAsync(version: string, opts: SetupOptions = {}): Promise<Setup> {
  return runAsync(setupSteps(version, opts));
}
