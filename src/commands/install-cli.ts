import path from 'node:path';
import type { Args } from '../cli/args.js';
import { applyLanguage } from '../cli/lang.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { refreshReasons, timeRuleFeed } from '../core/edit.js';
import { type MessageId, t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { titleWidgets } from '../core/panel.js';
import { claudeSettingsPath, tildify } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import { VERSION } from '../core/version.js';
import type { HookEvent } from '../data/hooks.js';
import { progressChannel, progressSeq } from '../data/progress.js';
import { requestClear } from '../data/progress-clear.js';
import { selfCommand } from '../data/update-state.js';
import { type DetectedTool, detectTool, type ImportSource, sniffTool } from '../importers/index.js';
import { getWidget } from '../widgets/index.js';
import {
  detectClaudeCode,
  eventFloor,
  HOOK_FLOOR,
  type HookAction,
  type HookPlan,
  type HookPlanItem,
  hookEventsFor,
  hookKey,
  planHookRewrites,
  planHooks,
  type RemovedHooks,
  uninstallHooks,
} from './hooks-install.js';
import {
  applyInstall,
  currentStatusLine,
  defaultCommand,
  gsdProjects,
  InstallNeedsConfirmError,
  type InstallPlan,
  type InstallResult,
  ignoreLocally,
  planInstall,
  projectLocalFile,
  projectOverride,
  projectSettingsPath,
  releaseProjects,
  setupCommand,
  statusLineOwner,
  takeOverProjects,
  type UninstallResult,
  uninstall,
} from './install.js';
import { ask } from './io.js';
import { runImport } from './manage.js';
import { findHookEntries, readManifest } from './manifest.js';
import { readSettings } from './settings-file.js';
import { installKind } from './update.js';

export { ask, isYes, promptMarker } from './io.js';

export interface InstallIo {
  tty: boolean;
  ask(question: string, fallback: boolean): Promise<boolean>;
  log(line: string): void;
  error(line: string): void;
  setup: typeof setupCommand;
  claudeVersion?: () => string | null;
  write?: (raw: string) => void;
}

export function defaultIo(): InstallIo {
  return {
    tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
    ask,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    setup: setupCommand,
    write: (raw) => {
      process.stdout.write(raw);
    },
  };
}

const show = (c: unknown) => sanitizeText(typeof c === 'string' ? c : String(JSON.stringify(c)));

export async function offerImport(
  tool: DetectedTool,
  args: Args,
  cfgFile: string,
  io: InstallIo = defaultIo(),
  program = selfCommand(),
): Promise<void> {
  if (!tool.importable) {
    io.log(t('install.importManual', { tool: tool.name }));
    return;
  }
  if (args.flags.import === false) return;
  const yes =
    args.flags.import === true ||
    args.flags.yes === true ||
    (await io.ask(t('install.importPrompt', { tool: tool.name }), true));
  if (!yes) return;
  const flags = {
    allowCommands: args.flags['allow-commands'] === true,
    yes: args.flags.yes === true,
    dryRun: false,
  };
  await runImport(tool.tool as ImportSource, { command: tool.command, flags, program }, cfgFile, io);
}

function showPlan(io: InstallIo, plan: InstallPlan): void {
  if (plan.needsConfirm) io.log(t('install.foreignHeader', { file: tildify(plan.file) }));
  if (plan.current) io.log(t('install.current', { command: show(plan.current.command) }));
  io.log(t('install.proposed', { command: show(plan.proposed.command) }));
  const unset = t('install.unset');
  for (const d of plan.diff) {
    const params = { current: d.current ?? unset, proposed: d.proposed ?? unset };
    io.log(t(d.key === 'padding' ? 'install.paddingDiff' : 'install.refreshDiff', params));
  }
}

// mirrors applyInstall's hook step; reads only
function previewHooks(
  file: string,
  command: string,
  events: HookEvent[],
  claudeCode: string | null,
  progress: boolean,
): HookPlan | null {
  const settings = readSettings(file).data;
  const manifest = readManifest();
  const asked =
    events.length || progress
      ? planHooks({ settings, manifest, file, command, claudeCode, events, progress })
      : null;
  const covered = new Set(asked?.items.map(hookKey));
  const rewrites = planHookRewrites(settings, manifest, file, command).filter(
    (i) => !covered.has(hookKey(i)),
  );
  if (!asked && !rewrites.length) return null;
  const base = asked ?? { claudeCode: null, refused: null, asyncOmitted: false };
  return { ...base, items: [...(asked?.items ?? []), ...rewrites] };
}

const hookCommand = (i: HookPlanItem | undefined, from = false) =>
  show((from ? i?.from : i?.group)?.hooks[0]?.command ?? '');

const floorOf = (i: HookPlanItem) => eventFloor(i.event) ?? HOOK_FLOOR.core;
const labelOf = (i: HookPlanItem) => (i.role ? `${i.event} (progress)` : i.event);

function dryHookLine(i: HookPlanItem): string {
  const event = labelOf(i);
  switch (i.action) {
    case 'add':
      if (i.role) return t('progress.dry.add', { event: i.event, command: hookCommand(i) });
      return t('hooks.dry.add', { event, command: hookCommand(i) });
    case 'keep':
      return t('hooks.dry.keep', { event });
    case 'rewrite':
      return t('hooks.dry.rewrite', { event, from: hookCommand(i, true), command: hookCommand(i) });
    case 'skip-unmanaged':
      return t('hooks.dry.skipUnmanaged', { event });
    case 'skip-version':
      return t('hooks.dry.skipVersion', { event, floor: floorOf(i) });
  }
}

// a package runner per hook event is slow and may hit the network
export function isRunnerCommand(command: string): boolean {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(\S+))?/.exec(command);
  if (!m) return false;
  const first = path
    .basename((m[1] ?? m[2] ?? m[3] ?? '').replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.(cmd|exe|ps1)$/, '');
  return (
    ['npx', 'pnpx', 'bunx'].includes(first) || (['pnpm', 'yarn', 'bun'].includes(first) && m[4] === 'dlx')
  );
}

function asyncNote(io: InstallIo, p: HookPlan): void {
  if (p.asyncOmitted) io.log(`  ${t('hooks.asyncOmitted', { version: p.claudeCode ?? '' })}`);
  const cmd = p.items.find((i) => i.action !== 'skip-unmanaged' && i.action !== 'skip-version')?.group
    .hooks[0]?.command;
  if (cmd && isRunnerCommand(cmd)) io.log(`⚠ ${t('hooks.runnerCommand')}`);
}

function progressRefusal(p: HookPlan): string | null {
  const floor = HOOK_FLOOR.terminalSequence;
  if (p.progressRefused === 'unknown-version') return t('progress.refused.unknownVersion', { floor });
  if (p.progressRefused === 'old-version')
    return t('progress.refused.oldVersion', { floor, version: p.claudeCode ?? '' });
  return null;
}

function showDryHooks(io: InstallIo, p: HookPlan, hooksAsked: boolean): void {
  const floor = HOOK_FLOOR.core;
  if (hooksAsked && p.refused === 'unknown-version') io.log(t('hooks.dry.unknownVersion', { floor }));
  if (hooksAsked && p.refused === 'old-version')
    io.log(t('hooks.dry.oldVersion', { floor, version: p.claudeCode ?? '' }));
  const refusal = progressRefusal(p);
  if (refusal) io.log(`  - ${refusal}`);
  for (const i of p.items) io.log(dryHookLine(i));
  asyncNote(io, p);
}

const REPORT: Array<[HookAction, MessageId]> = [
  ['add', 'hooks.added'],
  ['rewrite', 'hooks.rewritten'],
  ['keep', 'hooks.kept'],
  ['skip-unmanaged', 'hooks.skippedUnmanaged'],
  ['skip-version', 'hooks.skippedVersion'],
];

function reportHooks(io: InstallIo, p: HookPlan, hooksAsked: boolean): void {
  const added = p.items.filter((i) => i.role && i.action === 'add').map((i) => i.event);
  for (const [action, id] of REPORT) {
    const events = p.items.filter((i) => i.action === action && !(i.role && action === 'add')).map(labelOf);
    if (events.length) io.log(t(id, { events: events.join(', ') }));
  }
  if (added.length) io.log(t('progress.added', { events: added.join(', ') }));
  const floor = HOOK_FLOOR.core;
  if (hooksAsked && p.refused === 'unknown-version')
    io.log(`⚠ ${t('hooks.refused.unknownVersion', { floor })}`);
  if (hooksAsked && p.refused === 'old-version')
    io.log(`⚠ ${t('hooks.refused.oldVersion', { floor, version: p.claudeCode ?? '' })}`);
  const refusal = progressRefusal(p);
  if (refusal) io.log(`⚠ ${refusal}`);
  if (p.progressRefused === null) io.log(`  ${t('progress.tip')}`);
  asyncNote(io, p);
}

const hooksChanged = (p: HookPlan | null) =>
  !!p?.items.some((i) => i.action === 'add' || i.action === 'rewrite');

// D-16: install persists the GSD migration
function persistConfig(cfgFile: string): void {
  if (!loadConfig(cfgFile).exists) saveConfig(loadForUse(cfgFile).config, cfgFile);
  else loadForUse(cfgFile, undefined, { persist: true });
}

// returns whether progress was on; refuses on a broken config
function setProgress(io: InstallIo, cfgFile: string, on: boolean): boolean {
  const loaded = loadConfig(cfgFile);
  const was = loaded.config.progress?.enabled === true;
  if (was === on || (!loaded.exists && !on)) return was;
  if (loaded.error) {
    io.error(`✗ ${t('config.refuseBroken', { file: tildify(cfgFile) })}`);
    process.exitCode = 1;
    return was;
  }
  saveConfig({ ...loaded.config, progress: { ...loaded.config.progress, enabled: on } }, cfgFile);
  return was;
}

// OSC 9;4;0 clears the tab bar
function clearProgress(io: InstallIo): void {
  if (io.tty) io.write?.(progressSeq(0, 0));
}

// D-25: suggest only, never write refreshInterval
function refreshNotes(io: InstallIo, cfgFile: string, refresh: number | undefined, plan: InstallPlan): void {
  if (refresh === 1) io.log(t('install.refreshOne'));
  if (refresh !== undefined || plan.proposed.refreshInterval !== undefined) return;
  let why = { widgets: [] as string[], rules: [] as string[] };
  try {
    const { config } = loadForUse(cfgFile);
    const extra = config.tui ? titleWidgets(config.tui) : [];
    why = refreshReasons(config, (type) => getWidget(type)?.timeBased === true, [timeRuleFeed], extra);
  } catch {}
  if (why.widgets.length) io.log(t('install.refreshHint', { widgets: why.widgets.join(', ') }));
  if (why.rules.length) io.log(t('install.refreshHintRules', { items: sanitizeText(why.rules.join(', ')) }));
}

function userRefresh(): number | undefined {
  try {
    return currentStatusLine()?.refreshInterval;
  } catch {
    return undefined;
  }
}

// `--hooks permission` would otherwise drop the value silently
function badPositional(args: Args, io: InstallIo): boolean {
  // --project takes a value only for report
  const arg = args.positional[0] ?? (typeof args.flags.project === 'string' ? args.flags.project : undefined);
  if (arg === undefined) return false;
  io.error(t('hooks.badArg', { arg: sanitizeText(arg).slice(0, 64) }));
  process.exitCode = 1;
  return true;
}

function configLanguage(cfgFile: string): void {
  const loaded = loadConfig(cfgFile);
  if (!loaded.issue) applyLanguage(loaded.config);
}

export async function runInstall(args: Args, cfgFile: string, io: InstallIo = defaultIo()): Promise<void> {
  configLanguage(cfgFile);
  if (badPositional(args, io)) return;
  const dryRun = args.flags['dry-run'] === true;
  const project = !!args.flags.project;
  let events = hookEventsFor(args.flags.hooks);
  if (!events) {
    io.error(t('hooks.badFlag'));
    process.exitCode = 1;
    return;
  }
  if (args.flags.progress !== undefined && typeof args.flags.progress !== 'boolean') {
    io.error(t('progress.badFlag'));
    process.exitCode = 1;
    return;
  }
  let progress = args.flags.progress === true;
  if (progress && !project && !dryRun && loadConfig(cfgFile).error) {
    io.error(`✗ ${t('config.refuseBroken', { file: tildify(cfgFile) })}`);
    process.exitCode = 1;
    return;
  }
  io.log(t('install.installing', { version: VERSION }));
  let command: string | null = typeof args.flags.command === 'string' ? args.flags.command : null;
  const refresh = typeof args.flags.refresh === 'string' ? Number(args.flags.refresh) : undefined;
  let hint = selfCommand();
  if (!command && dryRun) {
    command = defaultCommand(undefined, io.log);
    if (!command && installKind() === 'npx') {
      io.log(t('install.dryRunGlobal', { version: VERSION }));
      command = 'ccinfobar';
    }
  } else if (!command) {
    const setup = io.setup(VERSION, {
      global: args.flags.global !== false,
      log: (l) => io.log(l.replace(/\/[^\s`]+/g, (p) => tildify(p))),
    });
    command = setup.command;
    if (setup.onPath) hint = 'ccinfobar';
  }
  if (!command) {
    io.error(t('install.noCommand'));
    process.exitCode = 1;
    return;
  }
  const shadowed = project ? projectOverride(process.cwd()) : null;
  const file = project
    ? projectSettingsPath(shadowed ? path.dirname(path.dirname(shadowed.file)) : process.cwd())
    : claudeSettingsPath();
  const plan = planInstall({ file, command, refresh: project ? (refresh ?? userRefresh()) : refresh });
  // D-17: hooks live in user settings only
  if (events.length && project) {
    io.log(t('hooks.projectIgnored'));
    events = [];
  }
  if (progress && project) {
    io.log(t('progress.projectIgnored'));
    progress = false;
  }
  const hooksAsked = events.length > 0;
  // WR-02: the tty channel writes from the status line, so no handlers
  const tty =
    progress && !project && progressChannel(loadConfig(cfgFile).config.progress, process.platform) === 'tty';
  const handlers = progress && !tty;
  let claudeCode: string | null = null;
  if (hooksAsked || handlers) {
    claudeCode = (io.claudeVersion ?? detectClaudeCode)();
    if (claudeCode) io.log(t('hooks.detected', { version: claudeCode }));
  }

  if (dryRun) {
    if (!plan.needsConfirm) io.log(t('install.dryRunFile', { file: tildify(file) }));
    showPlan(io, plan);
    const hookPlan = project ? null : previewHooks(file, command, events, claudeCode, handlers);
    if (tty) io.log(t('progress.tty'));
    if (!plan.changes && !hooksChanged(hookPlan)) io.log(t('install.unchanged'));
    if (hookPlan) showDryHooks(io, hookPlan, hooksAsked);
    if (!project) {
      const gsd = gsdProjects();
      if (gsd.length) io.log(t('install.dryRunProjects', { count: gsd.length }));
      for (const p of gsd) io.log(`  ${tildify(p)}`);
    }
    refreshNotes(io, cfgFile, refresh, plan);
    io.log(t('install.dryRun'));
    return;
  }

  let adoptLegacy = false;
  if (plan.needsConfirm && args.flags.yes !== true && io.tty) {
    showPlan(io, plan);
    const legacy = plan.owner === 'legacy-ask';
    const question = legacy
      ? t('install.legacyPrompt', { command: show(plan.current?.command) })
      : t('install.replacePrompt');
    if (!(await io.ask(question, false))) {
      io.log(t('install.kept'));
      return;
    }
    adoptLegacy = legacy;
  }

  const found = project ? null : detectTool(plan.current?.command);
  const tool =
    found?.tool === 'unknown'
      ? (sniffTool(found.command, { env: process.env, cwd: process.cwd() }) ?? found)
      : found;
  if (tool) await offerImport(tool, args, cfgFile, io, hint);
  let res: InstallResult;
  try {
    const hooks = hooksAsked || handlers ? { events, claudeCode, progress: handlers } : undefined;
    res = applyInstall(plan, { confirmed: true, adoptLegacy, hooks });
  } catch (e) {
    if (!(e instanceof InstallNeedsConfirmError)) throw e;
    io.error(t('install.stale', { file: tildify(file) }));
    process.exitCode = 1;
    return;
  }
  if (project) ignoreLocally(file);
  persistConfig(cfgFile);
  if (tty || (handlers && res.hooks?.progressRefused === null)) setProgress(io, cfgFile, true);
  const ttyRemoved =
    tty && hasProgressHandlers(file) ? uninstallHooks(file, undefined, undefined, 'progress') : null;
  if (plan.changes) io.log(t('install.wrote', { command: show(command), file: tildify(file) }));
  else if (!hooksChanged(res.hooks)) io.log(t('install.unchanged'));
  if (plan.needsConfirm && !adoptLegacy && plan.current)
    io.log(t('install.replaced', { command: show(plan.current.command) }));
  if (res.hooks) reportHooks(io, res.hooks, hooksAsked);
  if (tty) io.log(t('progress.tty'));
  if (ttyRemoved) hooksRemoved(io, ttyRemoved);
  if (res.backup) io.log(t('install.backup', { file: tildify(res.backup) }));
  else if (ttyRemoved?.backup) io.log(t('install.backup', { file: tildify(ttyRemoved.backup) }));
  refreshNotes(io, cfgFile, refresh, plan);

  if (project) {
    if (shadowed)
      io.log(t('install.projectWins', { command: show(shadowed.command), file: tildify(shadowed.file) }));
    io.log(t('install.projectLocal'));
    return;
  }
  io.log(t('install.config', { file: tildify(cfgFile) }));
  if (tool) io.log(t('install.bringsBack', { tool: tool.name }));
  const taken = takeOverProjects(command, userRefresh());
  if (taken.length) {
    io.log(t('install.projectsTaken', { count: taken.length }));
    for (const p of taken) io.log(`  ${tildify(p)}`);
  }
  const other = projectOverride(process.cwd());
  if (other) {
    io.log(t('install.projectOwn', { file: tildify(other.file) }));
    io.log(t('install.projectHint', { command: selfCommand() }));
  }
  io.log(t('install.customize', { command: hint }));
}

export function uninstallMessage(res: UninstallResult): string {
  const file = tildify(res.file);
  const command = show(res.restored?.command ?? res.current?.command ?? '');
  switch (res.status) {
    case 'restored-exact':
      return t('uninstall.restoredExact', { file });
    case 'restored-previous':
      return t('uninstall.restoredPrevious', { command });
    case 'removed':
      return t('uninstall.removed', { file });
    case 'deleted-file':
      return t('uninstall.deletedFile', { file });
    case 'foreign':
      return t('uninstall.foreign', { file, command });
    case 'gone-restored':
      return t('uninstall.goneRestored', { file, command });
    case 'gone-nothing':
      return t('uninstall.goneNothing', { file });
    case 'not-installed':
      return t('uninstall.notInstalled', { file });
  }
}

// D-10: a TTY asks once about an unrecorded ccinfobar-looking statusLine
async function uninstallAsking(file: string, io: InstallIo): Promise<UninstallResult> {
  const { current, owner } = statusLineOwner(file);
  const adoptLegacy =
    owner === 'legacy-ask' && io.tty
      ? await io.ask(t('install.legacyPrompt', { command: show(current?.command) }), false)
      : false;
  return uninstall(file, { adoptLegacy });
}

function hooksRemoved(io: InstallIo, hooks: RemovedHooks): void {
  if (hooks.removed.length) io.log(t('hooks.removed', { events: hooks.removed.join(', ') }));
  if (hooks.kept.length) io.log(t('hooks.leftEdited', { events: hooks.kept.join(', ') }));
  const p = hooks.progress;
  if (p?.removed.length) io.log(t('progress.removed'));
  if (p?.kept.length)
    io.log(t('hooks.leftEdited', { events: p.kept.map((e) => `${e} (progress)`).join(', ') }));
}

// D-36: config off, every bar wants state 0; returns hook bars only a prompt can clear
function progressOff(io: InstallIo, cfgFile: string, handlers: boolean): number {
  const was = setProgress(io, cfgFile, false);
  const pending = requestClear(process.env);
  if (handlers || was) clearProgress(io);
  return handlers ? pending : 0;
}

const hasProgressHandlers = (file: string) =>
  findHookEntries(readManifest(), file).some((e) => e.role === 'progress');

export async function runUninstall(args: Args, cfgFile: string, io: InstallIo = defaultIo()): Promise<void> {
  configLanguage(cfgFile);
  if (badPositional(args, io)) return;
  const hooksOnly = args.flags.hooks !== undefined && args.flags.hooks !== false;
  const progressOnly = args.flags.progress === true;
  if (args.flags.project) {
    if (hooksOnly) io.log(t('hooks.uninstallProject'));
    if (progressOnly) io.log(t('progress.uninstallProject'));
    io.log(uninstallMessage(await uninstallAsking(projectLocalFile(process.cwd()), io)));
    return;
  }
  if (hooksOnly || progressOnly) {
    const file = claudeSettingsPath();
    // the next hook event sends the clear, so the handlers wait for it once
    const held = progressOnly && progressOff(io, cfgFile, hasProgressHandlers(file)) > 0;
    const role = !progressOnly || held ? 'hooks' : hooksOnly ? 'all' : 'progress';
    const res =
      held && !hooksOnly
        ? { removed: [], kept: [], backup: null, changed: false }
        : uninstallHooks(file, undefined, undefined, role);
    if (hooksOnly && !res.removed.length && !res.kept.length)
      io.log(t('hooks.none', { file: tildify(file) }));
    if (progressOnly && !held && !res.progress) io.log(t('progress.none', { file: tildify(file) }));
    hooksRemoved(io, res);
    if (held) io.log(t('progress.held'));
    if (res.backup) io.log(t('install.backup', { file: tildify(res.backup) }));
    return;
  }
  const released = releaseProjects();
  if (released.length) io.log(t('uninstall.releasedProjects', { count: released.length }));
  const res = await uninstallAsking(claudeSettingsPath(), io);
  io.log(uninstallMessage(res));
  hooksRemoved(io, res.hooks);
  progressOff(io, cfgFile, !!res.hooks.progress?.removed.length);
}
