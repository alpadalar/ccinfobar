import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { titleWidgets } from '../core/panel.js';
import {
  claudeDir,
  claudeJsonPath,
  claudeSettingsPath,
  configDir,
  projectSettingsPath,
} from '../core/paths.js';
import type { Config } from '../core/types.js';
import { HARDEN } from '../data/git.js';
import type { HookEvent } from '../data/hooks.js';
import { installVersion } from '../data/self-update.js';
import { safeCwd } from '../data/update-state.js';
import { binary } from '../data/which.js';
import { type BuiltCommand, buildCommand, type CommandTarget, jsForWinBin } from './command.js';
import {
  appliedItems,
  type HookFloor,
  type HookPlan,
  type HookPlanItem,
  hookKey,
  mutateHooks,
  planHookRewrites,
  planHooks,
  type RemovedHooks,
  recordHooks,
  removedLists,
  removeOwnedHooks,
} from './hooks-install.js';
import {
  classifyOwner,
  deepEqual,
  dropEntry,
  dropHookEntry,
  findHookEntries,
  findStatusLineEntry,
  findSubagentLineEntry,
  type HookEntry,
  type Manifest,
  manifestFile,
  noteWrite,
  type Owner,
  ownedEqual,
  type Restore,
  readManifest,
  realKey,
  recordGitExclude,
  recordStatusLine,
  recordSubagentLine,
  refreshWrittenHash,
  type StatusLineEntry,
  type SubagentLineEntry,
  updateManifest,
} from './manifest.js';
import {
  deleteSettingsFile,
  hashBytes,
  patchSettings,
  readSettings,
  resolveReal,
  rollbackPatch,
  writeSettingsBytes,
} from './settings-file.js';
import {
  brewPrefix,
  compareVersions,
  type InstallKind,
  installKind,
  installVersionAsync,
  localPrefix,
  npmCommand,
} from './update.js';

export interface StatusLineSetting {
  type: 'command';
  command: string;
  padding?: number;
  refreshInterval?: number;
  hideVimModeIndicator?: boolean;
  [key: string]: unknown;
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
      timeout: 10_000,
      // Windows looks up where in the cwd first
      ...(win ? { cwd: safeCwd() } : {}),
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

export interface TargetDeps {
  globalBinary?: () => string | null;
  entry?: string;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
}

const slash = (p: string) => p.replace(/\\/g, '/');
const inCellar = (p: string) => slash(p).includes('/Cellar/');

// an npm copy can own <prefix>/bin/ccinfobar
function ownsKeg(p: string, prefix: string | null, realpath: (p: string) => string): boolean {
  try {
    const real = slash(realpath(p));
    return prefix
      ? real.startsWith(`${slash(prefix)}/Cellar/ccinfobar/`)
      : real.includes('/Cellar/ccinfobar/');
  } catch {
    return false;
  }
}

// the prefix bin and opt link survive brew upgrade, Cellar paths do not
function brewTarget(deps: TargetDeps): CommandTarget | null {
  const exists = deps.exists ?? fs.existsSync;
  const realpath = deps.realpath ?? fs.realpathSync;
  const prefix = brewPrefix(deps.entry);
  const candidates: CommandTarget[] = prefix
    ? [
        { kind: 'bin', bin: path.join(prefix, 'bin', 'ccinfobar'), onPath: true },
        { kind: 'bin', bin: path.join(prefix, 'opt', 'ccinfobar', 'bin', 'ccinfobar'), onPath: false },
      ]
    : [];
  const hit = (deps.globalBinary ?? globalBinary)();
  if (hit && !inCellar(hit)) candidates.push({ kind: 'bin', bin: hit, onPath: true });
  return (
    candidates.find((c) => c.kind === 'bin' && exists(c.bin) && ownsKeg(c.bin, prefix, realpath)) ?? null
  );
}

// never npx@latest: it runs whatever npm serves
function defaultTarget(kind: InstallKind, deps: TargetDeps = {}): CommandTarget | null {
  if (kind === 'brew') return brewTarget(deps);
  const exists = deps.exists ?? fs.existsSync;
  const bin = (deps.globalBinary ?? globalBinary)();
  if (bin) return { kind: 'bin', bin, onPath: true };
  if (exists(localBin())) return { kind: 'bin', bin: localBin(), onPath: false };
  const raw = deps.entry ?? process.argv[1];
  const entry = raw ? path.resolve(raw) : null;
  if (kind !== 'npx' && entry && exists(entry)) return { kind: 'script', script: entry };
  return null;
}

export function defaultCommand(
  kind: InstallKind = installKind(),
  log?: (line: string) => void,
  deps?: TargetDeps,
): string | null {
  const target = defaultTarget(kind, deps);
  const command = target ? acceptCommand(buildCommand(target), log) : null;
  return kind === 'brew' && command && inCellar(command) ? null : command;
}

function statusLineOf(data: Record<string, unknown>): StatusLineSetting | null {
  const sl = data.statusLine;
  return sl && typeof sl === 'object' && !Array.isArray(sl) ? (sl as StatusLineSetting) : null;
}

export interface SubagentSetting {
  type: 'command';
  command: string;
  [k: string]: unknown;
}

export const subagentCommand = (command: string) => `${command} subagent-line`;

function subagentOf(data: Record<string, unknown>): unknown | null {
  const v = data.subagentStatusLine;
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

export type SubagentOwner = 'none' | 'ours' | 'foreign';

export interface SubagentPlan {
  current: unknown | null;
  owner: SubagentOwner;
  proposed: SubagentSetting;
  changes: boolean;
  asked: boolean;
}

export function currentSubagentLine(
  file = claudeSettingsPath(),
  env: NodeJS.ProcessEnv = process.env,
): { command: string; owned: boolean } | null {
  const cur = subagentOf(readSettings(file).data) as Record<string, unknown> | null;
  if (!cur) return null;
  const entry = findSubagentLineEntry(openManifest(env), file);
  return {
    command: typeof cur.command === 'string' ? cur.command : '',
    owned: !!entry && ownedEqual(cur, entry.value),
  };
}

export function currentStatusLine(file = claudeSettingsPath()): StatusLineSetting | null {
  return statusLineOf(readSettings(file).data);
}

const EMPTY: Manifest = { version: 1, entries: [] };
const noOriginal = (env: NodeJS.ProcessEnv) => ({ original: false, env });

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

export type UninstallStatus =
  | 'restored-exact'
  | 'restored-previous'
  | 'removed'
  | 'deleted-file'
  | 'foreign'
  | 'gone-restored'
  | 'gone-nothing'
  | 'not-installed';

export type SubagentOut = 'removed' | 'restored' | 'kept' | null;

export interface UninstallResult {
  status: UninstallStatus;
  file: string;
  removed: boolean;
  restored: StatusLineSetting | null;
  current?: StatusLineSetting | null;
  hooks: RemovedHooks;
  subagent: SubagentOut;
}

type HooksOut = UninstallResult['hooks'];

const REMOVED = new Set<UninstallStatus>([
  'restored-exact',
  'restored-previous',
  'removed',
  'deleted-file',
  'gone-restored',
]);

function backupBytes(restore: { backup: string; hash: string }, env: NodeJS.ProcessEnv): Buffer | null {
  try {
    const bytes = fs.readFileSync(path.resolve(configDir(env), restore.backup));
    return hashBytes(bytes) === restore.hash ? bytes : null;
  } catch {
    return null;
  }
}

function removeOwnedSubagent(d: Record<string, unknown>, entry: SubagentLineEntry | null): SubagentOut {
  if (!entry) return null;
  if (!ownedEqual(d.subagentStatusLine, entry.value)) return 'kept';
  const prev = entry.previous;
  if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
    d.subagentStatusLine = prev;
    return 'restored';
  }
  delete d.subagentStatusLine;
  return 'removed';
}

// only while the file is byte-identical to our last write
function restoreExact(
  file: string,
  entry: StatusLineEntry,
  hash: string | null,
  env: NodeJS.ProcessEnv,
): UninstallStatus | null {
  const r = entry.restore;
  const opts = noOriginal(env);
  if (!r || !hash || hash !== entry.writtenHash) return null;
  if ('absent' in r) return deleteSettingsFile(file, { ...opts, ifHash: hash }) ? 'deleted-file' : null;
  const bytes = backupBytes(r, env);
  if (!bytes) return null;
  writeSettingsBytes(file, bytes, opts);
  return 'restored-exact';
}

// D-41: one write for statusLine and owned hooks
function restoreKey(
  file: string,
  data: Record<string, unknown>,
  ours: StatusLineSetting,
  previous: StatusLineSetting | null,
  fileExisted: boolean,
  hash: string | null,
  hookEntries: HookEntry[],
  subEntry: SubagentLineEntry | null,
  env: NodeJS.ProcessEnv,
): [UninstallStatus, StatusLineSetting | null, undefined, HooksOut, SubagentOut] {
  const opts = noOriginal(env);
  const { statusLine: _, ...rest } = structuredClone(data);
  const left = removeOwnedHooks(rest, hookEntries);
  const subLeft = removeOwnedSubagent(rest, subEntry);
  const empty = !previous && !fileExisted && Object.keys(rest).length === 0;
  if (empty && deleteSettingsFile(file, { ...opts, ifHash: hash }))
    return ['deleted-file', null, undefined, left, subLeft];
  const state = { raced: false, hooks: left, sub: subLeft };
  patchSettings(
    file,
    (d) => {
      state.hooks = removeOwnedHooks(d, hookEntries);
      state.sub = removeOwnedSubagent(d, subEntry);
      state.raced = !deepEqual(d.statusLine, ours);
      if (state.raced) return;
      if (previous) d.statusLine = previous;
      else delete d.statusLine;
    },
    opts,
  );
  if (state.raced) return ['foreign', null, undefined, state.hooks, state.sub];
  return [previous ? 'restored-previous' : 'removed', previous, undefined, state.hooks, state.sub];
}

export function uninstall(
  file?: string,
  opts: { adoptLegacy?: boolean; env?: NodeJS.ProcessEnv } = {},
): UninstallResult {
  const env = opts.env ?? process.env;
  const target = file ?? claudeSettingsPath(env);
  const m = openManifest(env);
  const cur = readSettings(target);
  const sl = statusLineOf(cur.data);
  const entry = findStatusLineEntry(m, target);
  const hookEntries = findHookEntries(m, target);
  const subEntry = findSubagentLineEntry(m, target);
  const none: HooksOut = { removed: [], kept: [] };
  const patchOpts = noOriginal(env);
  // D-41: owned hooks go on every branch
  let subOut: SubagentOut = null;
  const hooksOnly = (): HooksOut => {
    if (!hookEntries.length && !subEntry) return none;
    let out = none;
    patchSettings(
      target,
      (d) => {
        out = removeOwnedHooks(d, hookEntries);
        subOut = removeOwnedSubagent(d, subEntry);
      },
      patchOpts,
    );
    return out;
  };
  const done = (
    status: UninstallStatus,
    restored: StatusLineSetting | null = null,
    current?: StatusLineSetting | null,
    hooks: HooksOut = none,
    subagent: SubagentOut = subOut,
  ): UninstallResult => {
    if (entry || hookEntries.length || subEntry)
      updateManifest(env, (cur) => {
        let next = entry ? dropEntry(cur, target, 'statusLine') : cur;
        if (subEntry) next = dropEntry(next, target, 'subagentStatusLine');
        for (const h of hookEntries) next = dropHookEntry(next, target, h.event, h.role);
        return next;
      });
    const res: UninstallResult = {
      status,
      file: target,
      removed: REMOVED.has(status),
      restored,
      hooks,
      subagent,
    };
    if (current !== undefined) res.current = current;
    return res;
  };
  if (entry) {
    if (!sl) {
      const prev = entry.previous;
      if (!prev) return done('gone-nothing', null, null, hooksOnly());
      let out = none;
      patchSettings(
        target,
        (d) => {
          out = removeOwnedHooks(d, hookEntries);
          subOut = removeOwnedSubagent(d, subEntry);
          if (!statusLineOf(d)) d.statusLine = prev;
        },
        patchOpts,
      );
      return done('gone-restored', prev, null, out);
    }
    if (!ownedEqual(sl, entry.value)) return done('foreign', null, sl, hooksOnly());
    const exact = restoreExact(target, entry, cur.hash, env);
    // the restore point predates every owned hook
    const all = removedLists(hookEntries);
    const subExact: SubagentOut = subEntry ? (subEntry.previous ? 'restored' : 'removed') : null;
    if (exact)
      return done(exact, exact === 'restored-exact' ? entry.previous : null, undefined, all, subExact);
    return done(
      ...restoreKey(
        target,
        cur.data,
        sl,
        entry.previous,
        entry.fileExisted,
        cur.hash,
        hookEntries,
        subEntry,
        env,
      ),
    );
  }
  if (!sl) return done('not-installed', null, null, hooksOnly());
  const owner = classify(m, target, sl, null);
  if (owner === 'legacy-ours' || (owner === 'legacy-ask' && opts.adoptLegacy)) {
    const previous = legacyPrevious(target, null);
    const existed = legacyBackup(target) !== null;
    return done(...restoreKey(target, cur.data, sl, previous, existed, cur.hash, hookEntries, subEntry, env));
  }
  return done('foreign', null, sl, hooksOnly());
}

export function uninstallSubagentLine(
  file = claudeSettingsPath(),
  env: NodeJS.ProcessEnv = process.env,
): { subagent: SubagentOut; backup: string | null; changed: boolean } {
  const entry = findSubagentLineEntry(openManifest(env), file);
  if (!entry) return { subagent: null, backup: null, changed: false };
  let out: SubagentOut = null;
  const res = patchSettings(
    file,
    (d) => {
      out = removeOwnedSubagent(d, entry);
    },
    noOriginal(env),
  );
  updateManifest(env, (cur) => {
    const next = dropEntry(cur, file, 'subagentStatusLine');
    return res.changed ? noteWrite(next, file, res.beforeHash, res.afterHash) : next;
  });
  return { subagent: out, backup: res.backup, changed: res.changed };
}

export { claudeJsonPath, projectSettingsPath };

function projectRoots(dir: string): string[] {
  const roots = [path.resolve(dir)];
  const bin = binary('git');
  if (bin === null) return roots;
  try {
    const top = execFileSync(bin, [...HARDEN, 'rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10_000,
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

const fileKey = (f: string) => (process.platform === 'win32' ? realKey(f).toLowerCase() : realKey(f));

// --project installs in folders .claude.json does not list, the home folder too
function recordedProjects(m: Manifest, env: NodeJS.ProcessEnv): string[] {
  const user = fileKey(claudeSettingsPath(env));
  return m.entries.flatMap((e) => {
    if (e.kind !== 'statusLine' || typeof e.file !== 'string') return [];
    const dir = path.dirname(e.file);
    const local = path.basename(e.file) === 'settings.local.json' && path.basename(dir) === '.claude';
    return local && fileKey(e.file) !== user ? [path.dirname(dir)] : [];
  });
}

export function releaseProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  const done: string[] = [];
  const m = readManifest(env);
  const seen = new Set<string>();
  for (const root of [...knownProjects(env), ...recordedProjects(m, env)]) {
    const file = projectSettingsPath(root);
    const key = fileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!ownedHere(m, file, currentStatusLine(file))) continue;
      if (uninstall(file, { env }).removed) done.push(root);
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
