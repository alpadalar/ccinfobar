import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { titleWidgets } from '../core/panel.js';
import { claudeJsonPath, claudeSettingsPath, configDir, projectSettingsPath } from '../core/paths.js';
import type { Config } from '../core/types.js';
import { HARDEN } from '../data/git.js';
import type { HookEvent } from '../data/hooks.js';
import { installVersion } from '../data/self-update.js';
import { safeCwd } from '../data/update-state.js';
import { binary } from '../data/which.js';
import { buildCommand, jsForWinBin } from './command.js';
import {
  appliedItems,
  type HookFloor,
  type HookPlan,
  type HookPlanItem,
  hookKey,
  mutateHooks,
  planHookRewrites,
  planHooks,
  recordHooks,
} from './hooks-install.js';
import {
  classify,
  isMine,
  legacyBackup,
  legacyPrevious,
  openManifest,
  type SubagentOwner,
  type SubagentPlan,
  type SubagentSetting,
  statusLineOf,
  subagentCommand,
  subagentOf,
} from './install-owner.js';
import { gsdProjects } from './install-projects.js';
import {
  acceptCommand,
  defaultCommand,
  globalBinary,
  localBin,
  type StatusLineSetting,
} from './install-target.js';
import {
  deepEqual,
  findStatusLineEntry,
  findSubagentLineEntry,
  type Manifest,
  type Owner,
  ownedEqual,
  type Restore,
  realKey,
  recordGitExclude,
  recordStatusLine,
  recordSubagentLine,
  refreshWrittenHash,
  updateManifest,
} from './manifest.js';
import { patchSettings, readSettings, resolveReal, rollbackPatch } from './settings-file.js';
import { compareVersions, installKind, installVersionAsync, localPrefix, npmCommand } from './update.js';

export {
  currentStatusLine,
  currentSubagentLine,
  type SubagentOwner,
  type SubagentPlan,
  type SubagentSetting,
  statusLineOwner,
  subagentCommand,
} from './install-owner.js';
export {
  acceptCommand,
  defaultCommand,
  globalBinary,
  isTransientBin,
  localBin,
  type StatusLineSetting,
  type TargetDeps,
} from './install-target.js';

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
  subagent?: SubagentPlan;
}

export interface InstallResult {
  backup: string | null;
  written: StatusLineSetting;
  replaced: StatusLineSetting | null;
  changed: boolean;
  hooks: HookPlan | null;
  subagent: 'added' | 'rewritten' | 'replaced' | null;
}

export interface InstallHooks {
  events: readonly HookEvent[];
  claudeCode: string | null;
  progress?: boolean;
  floor?: HookFloor;
}

export class InstallNeedsConfirmError extends Error {
  constructor(readonly plan: InstallPlan) {
    super(t('install.needsConfirm'));
    this.name = 'InstallNeedsConfirmError';
  }
}

function proposal(
  command: string,
  owner: Owner,
  current: StatusLineSetting | null,
  refresh?: number,
  hideVim?: boolean,
) {
  const statusLine: StatusLineSetting = { ...(current ?? {}), type: 'command', command, padding: 0 };
  const r = refresh ?? (isMine(owner) ? current?.refreshInterval : undefined);
  if (typeof r === 'number' && Number.isFinite(r) && r > 0) statusLine.refreshInterval = Math.floor(r);
  else delete statusLine.refreshInterval;
  if (hideVim === true) statusLine.hideVimModeIndicator = true;
  else if (hideVim === false) delete statusLine.hideVimModeIndicator;
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

function planSubagent(
  m: Manifest,
  file: string,
  settings: Record<string, unknown>,
  command: string,
  asked: boolean,
): SubagentPlan | undefined {
  const current = subagentOf(settings);
  const entry = findSubagentLineEntry(m, file);
  const owner: SubagentOwner =
    current === null ? 'none' : entry && ownedEqual(current, entry.value) ? 'ours' : 'foreign';
  if (!asked && owner !== 'ours') return undefined;
  const base = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
  const proposed: SubagentSetting = { ...base, type: 'command', command: subagentCommand(command) };
  return { current, owner, proposed, changes: !deepEqual(current, proposed), asked };
}

export function hasVimWidget(config: Config): boolean {
  return (
    config.lines.flat().some((w) => w.type === 'vim-mode') ||
    (config.tui ? titleWidgets(config.tui).has('vim-mode') : false)
  );
}

// reads only
export function planInstall(opts: {
  file?: string;
  command: string;
  refresh?: number;
  subagents?: boolean;
  hideVim?: boolean;
  env?: NodeJS.ProcessEnv;
}): InstallPlan {
  const env = opts.env ?? process.env;
  const file = opts.file ?? claudeSettingsPath(env);
  const m = openManifest(env);
  const settings = readSettings(file).data;
  const current = statusLineOf(settings);
  const owner = classify(m, file, current, opts.command);
  const proposed = proposal(opts.command, owner, current, opts.refresh, opts.hideVim);
  const subagent = planSubagent(m, file, settings, opts.command, opts.subagents === true);
  return {
    file,
    real: realKey(file),
    current,
    proposed,
    owner,
    changes: !deepEqual(current, proposed),
    needsConfirm:
      owner === 'foreign' || owner === 'legacy-ask' || (!!subagent?.asked && subagent.owner === 'foreign'),
    diff: diffOf(current, proposed),
    ...(subagent ? { subagent } : {}),
  };
}

export function applyInstall(
  plan: InstallPlan,
  opts: { confirmed: boolean; adoptLegacy?: boolean; env?: NodeJS.ProcessEnv; hooks?: InstallHooks },
): InstallResult {
  if (plan.needsConfirm && !opts.confirmed) throw new InstallNeedsConfirmError(plan);
  const env = opts.env ?? process.env;
  const { file, proposed } = plan;
  const command = proposed.command;
  const m = openManifest(env);
  const entry = findStatusLineEntry(m, file);
  // D-17: also guards takeOverProjects
  const userFile = realKey(file) === realKey(claudeSettingsPath(env));
  const hooks = {
    plan: null as HookPlan | null,
    planned: [] as HookPlanItem[],
    applied: [] as HookPlanItem[],
  };
  let subApplied = false;
  const res = patchSettings(
    file,
    (settings) => {
      subApplied = false;
      const current = statusLineOf(settings);
      if (!deepEqual(current, plan.current) || classify(m, file, current, command) !== plan.owner)
        throw new InstallNeedsConfirmError(plan);
      settings.statusLine = structuredClone(proposed);
      hooks.plan = null;
      hooks.planned = [];
      hooks.applied = [];
      if (!userFile) return;
      const asked = opts.hooks ? planHooks({ settings, manifest: m, file, command, ...opts.hooks }) : null;
      const covered = new Set(asked?.items.map(hookKey));
      const rewrites = planHookRewrites(settings, m, file, command).filter((i) => !covered.has(hookKey(i)));
      hooks.planned = [...(asked?.items ?? []), ...rewrites];
      hooks.applied = mutateHooks(settings, hooks.planned);
      if (asked || rewrites.length)
        hooks.plan = { ...(asked ?? { claudeCode: null, refused: null, asyncOmitted: false }), items: [] };
      const sub = plan.subagent;
      if (sub?.changes) {
        if (!deepEqual(subagentOf(settings), sub.current)) throw new InstallNeedsConfirmError(plan);
        settings.subagentStatusLine = structuredClone(sub.proposed);
        subApplied = true;
      }
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
  const claudeCode = hooks.plan?.claudeCode ?? null;
  const sub = plan.subagent;
  const withSubagent = (cur: Manifest): Manifest =>
    subApplied && sub
      ? recordSubagentLine(cur, {
          file: res.real,
          value: { type: sub.proposed.type, command: sub.proposed.command },
          previous: sub.owner === 'ours' ? (findSubagentLineEntry(cur, file)?.previous ?? null) : sub.current,
          writtenHash: res.afterHash,
        })
      : cur;
  try {
    updateManifest(env, (cur) =>
      // D-19: one write, every entry of the file refreshed
      refreshWrittenHash(
        recordHooks(
          withSubagent(
            recordStatusLine(cur, {
              file: res.real,
              value: structuredClone(proposed),
              previous,
              fileExisted,
              restore,
              writtenHash: res.afterHash,
            }),
          ),
          res.real,
          hooks.applied,
          claudeCode,
          res.afterHash,
        ),
        res.real,
        res.afterHash,
      ),
    );
  } catch (err) {
    if (res.changed) rollbackPatch(file, res, env);
    throw err;
  }
  const hookPlan = hooks.plan ? { ...hooks.plan, items: appliedItems(hooks.planned, hooks.applied) } : null;
  const subagent =
    subApplied && sub
      ? ({ none: 'added', ours: 'rewritten', foreign: 'replaced' } as const)[sub.owner]
      : null;
  return {
    backup: res.backup,
    written: proposed,
    replaced: current,
    changed: res.changed,
    hooks: hookPlan,
    subagent,
  };
}

export {
  gsdProjects,
  knownProjects,
  type ProjectOverride,
  projectLocalFile,
  projectOverride,
  releaseProjects,
} from './install-projects.js';
export {
  type SubagentOut,
  type UninstallResult,
  type UninstallStatus,
  uninstall,
  uninstallSubagentLine,
} from './uninstall.js';

export { claudeJsonPath, projectSettingsPath };

// keep settings.local.json out of git
export function ignoreLocally(file: string): boolean {
  const dir = path.dirname(file);
  const bin = binary('git');
  if (bin === null) return false;
  const git = (args: string[]) =>
    execFileSync(bin, [...HARDEN, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10_000,
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
      updateManifest(process.env, (cur) => recordGitExclude(cur, exclude, rel));
    } catch {}
    return true;
  } catch {
    return false;
  }
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

export function npmGlobalBin(): string | null {
  try {
    const npm = npmCommand();
    const prefix = execFileSync(npm.file, [...npm.args, 'prefix', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 60_000,
      shell: npm.shell,
      ...(npm.shell ? { cwd: safeCwd() } : {}),
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
      failed = err ?? new Error(t('install.setup.npmFailed'));
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
      failed = err ?? new Error(t('install.setup.npmFailed'));
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
      error: /EACCES|EPERM/.test(msg) ? t('install.setup.noPermission') : msg,
    };
  }
  const onPath = globalBinary();
  // an older copy earlier on PATH shadows the one npm just wrote
  const shadow = onPath ? binVersion(onPath) : null;
  if (onPath && !(shadow && compareVersions(shadow, version) < 0))
    return { ok: true, bin: onPath, onPath: true };
  const bin = npmGlobalBin();
  return bin ? { ok: true, bin, onPath: false } : { ok: false, error: t('install.setup.notFound') };
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

export interface BinState {
  version: string | null;
  missing: boolean;
}

// version null: a shim we cannot follow; missing: the bin or what it runs is gone
export function binState(bin: string): BinState {
  const unknown = { version: null, missing: false };
  let js: string;
  try {
    if (process.platform === 'win32') {
      if (!fs.existsSync(bin)) return { version: null, missing: true };
      js = jsForWinBin(bin);
      // an npm layout without the package is an orphan shim
      if (!fs.existsSync(js)) return { version: null, missing: fs.existsSync(path.resolve(js, '../../..')) };
    } else js = fs.realpathSync(bin);
  } catch (err) {
    return { version: null, missing: (err as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  if (!/[\\/]dist[\\/]ccinfobar\.js$/.test(js)) return unknown;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(js, '../../package.json'), 'utf8'));
    const ok = pkg?.name === 'ccinfobar' && typeof pkg.version === 'string';
    return ok ? { version: pkg.version, missing: false } : unknown;
  } catch {
    return unknown;
  }
}

export function binVersion(bin: string): string | null {
  return binState(bin).version;
}

function* setupSteps(version: string, opts: SetupOptions): Steps<Setup> {
  const log = opts.log ?? (() => {});
  if (installKind() !== 'npx') return setup(defaultCommand(undefined, log), !!globalBinary());
  const existing = globalBinary();
  const useExisting = (bin: string) =>
    setup(acceptCommand(buildCommand({ kind: 'bin', bin, onPath: true }), log), true);
  // an older or broken global copy would run the status line and hooks
  const state = existing ? binState(existing) : null;
  const old = state?.version ?? null;
  const missing = !!state?.missing;
  const stale = !!old && compareVersions(old, version) < 0;
  if (existing && !stale && !missing) return useExisting(existing);
  // --no-global never falls back to a stale copy, nothing to a broken one
  const reuse = opts.global !== false && !missing ? existing : null;
  if (opts.global === false && stale) log(t('install.setup.staleGlobal', { old: old ?? '', version }));
  if (opts.global === false && missing) log(t('install.setup.missingGlobal', { bin: existing ?? '' }));
  if (opts.global !== false) {
    log(
      stale
        ? t('install.setup.updating', { old: old ?? '', version })
        : t('install.setup.global', { version }),
    );
    const g = yield* globalSteps(version);
    if (g.ok) {
      log(t('install.setup.installed', { bin: g.bin }));
      if (!g.onPath) log(t('install.setup.notOnPath', { dir: path.dirname(g.bin) }));
      return setup(acceptCommand(buildCommand({ kind: 'bin', bin: g.bin, onPath: g.onPath }), log), g.onPath);
    }
    log(
      stale
        ? t('install.setup.updateFailed', { old: old ?? '', error: g.error })
        : t('install.setup.globalFailed', { error: g.error }),
    );
  }
  log(t('install.setup.pinned', { version, dir: localPrefix() }));
  try {
    yield { version, prefix: localPrefix() };
  } catch (err) {
    log(t('install.setup.failed', { error: (err as Error).message }));
    if (reuse) return useExisting(reuse);
    return { command: null, onPath: false };
  }
  if (!fs.existsSync(localBin())) {
    log(`✗ ${t('install.setup.notFound')}`);
    if (reuse) return useExisting(reuse);
    return { command: null, onPath: false };
  }
  log(t('install.setup.installed', { bin: localBin() }));
  return setup(acceptCommand(buildCommand({ kind: 'bin', bin: localBin(), onPath: false }), log), false);
}

// npx: global command, else a pinned copy under the config dir
export function setupCommand(version: string, opts: SetupOptions = {}): Setup {
  return runSync(setupSteps(version, opts));
}

export function setupCommandAsync(version: string, opts: SetupOptions = {}): Promise<Setup> {
  return runAsync(setupSteps(version, opts));
}
