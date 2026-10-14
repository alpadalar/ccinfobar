import path from 'node:path';
import type { Args } from '../cli/args.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { type MessageId, t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { claudeSettingsPath, tildify } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import { VERSION } from '../core/version.js';
import type { HookEvent } from '../data/hooks.js';
import { selfCommand } from '../data/update-state.js';
import { type DetectedTool, detectTool, type ImportSource } from '../importers/index.js';
import {
  detectClaudeCode,
  HOOK_FLOOR,
  type HookAction,
  type HookPlan,
  type HookPlanItem,
  hookEventsFor,
  planHookRewrites,
  planHooks,
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
import { runImport } from './manage.js';
import { readManifest } from './manifest.js';
import { readSettings } from './settings-file.js';
import { installKind } from './update.js';

export async function ask(question: string, fallback: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    return answer === '' ? fallback : answer.startsWith('y') || answer.startsWith('e');
  } finally {
    rl.close();
  }
}

export interface InstallIo {
  tty: boolean;
  ask(question: string, fallback: boolean): Promise<boolean>;
  log(line: string): void;
  error(line: string): void;
  setup: typeof setupCommand;
  claudeVersion?: () => string | null;
}

export function defaultIo(): InstallIo {
  return {
    tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
    ask,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    setup: setupCommand,
  };
}

const show = (c: unknown) => sanitizeText(typeof c === 'string' ? c : String(JSON.stringify(c)));

export async function offerImport(
  tool: DetectedTool,
  args: Args,
  cfgFile: string,
  io: InstallIo = defaultIo(),
): Promise<void> {
  if (!tool.importable) {
    io.log(`Found ${tool.name} as your current status line. Its settings cannot be imported automatically.`);
    return;
  }
  if (args.flags.import === false) return;
  const yes =
    args.flags.import === true ||
    args.flags.yes === true ||
    (await io.ask(`Found ${tool.name} as your current status line. Import its layout into ccinfobar?`, true));
  if (yes) runImport(tool.tool as ImportSource, { command: tool.command }, cfgFile);
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
): HookPlan | null {
  const settings = readSettings(file).data;
  const manifest = readManifest();
  const asked = events.length ? planHooks({ settings, manifest, file, command, claudeCode, events }) : null;
  const covered = new Set(asked?.items.map((i) => i.event));
  const rewrites = planHookRewrites(settings, manifest, file, command).filter((i) => !covered.has(i.event));
  if (!asked && !rewrites.length) return null;
  const base = asked ?? { claudeCode: null, refused: null, asyncOmitted: false };
  return { ...base, items: [...(asked?.items ?? []), ...rewrites] };
}

const hookCommand = (i: HookPlanItem | undefined, from = false) =>
  show((from ? i?.from : i?.group)?.hooks[0]?.command ?? '');

const eventFloor = (i: HookPlanItem) =>
  i.event === 'PermissionRequest'
    ? HOOK_FLOOR.PermissionRequest
    : i.event === 'Notification'
      ? HOOK_FLOOR.notificationMatcher
      : HOOK_FLOOR.core;

function dryHookLine(i: HookPlanItem): string {
  const event = i.event;
  switch (i.action) {
    case 'add':
      return t('hooks.dry.add', { event, command: hookCommand(i) });
    case 'keep':
      return t('hooks.dry.keep', { event });
    case 'rewrite':
      return t('hooks.dry.rewrite', { event, from: hookCommand(i, true), command: hookCommand(i) });
    case 'skip-unmanaged':
      return t('hooks.dry.skipUnmanaged', { event });
    case 'skip-version':
      return t('hooks.dry.skipVersion', { event, floor: eventFloor(i) });
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

function showDryHooks(io: InstallIo, p: HookPlan): void {
  const floor = HOOK_FLOOR.core;
  if (p.refused === 'unknown-version') io.log(t('hooks.dry.unknownVersion', { floor }));
  if (p.refused === 'old-version') io.log(t('hooks.dry.oldVersion', { floor, version: p.claudeCode ?? '' }));
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

function reportHooks(io: InstallIo, p: HookPlan): void {
  for (const [action, id] of REPORT) {
    const events = p.items.filter((i) => i.action === action).map((i) => i.event);
    if (events.length) io.log(t(id, { events: events.join(', ') }));
  }
  const floor = HOOK_FLOOR.core;
  if (p.refused === 'unknown-version') io.log(`⚠ ${t('hooks.refused.unknownVersion', { floor })}`);
  if (p.refused === 'old-version')
    io.log(`⚠ ${t('hooks.refused.oldVersion', { floor, version: p.claudeCode ?? '' })}`);
  asyncNote(io, p);
}

const hooksChanged = (p: HookPlan | null) =>
  !!p?.items.some((i) => i.action === 'add' || i.action === 'rewrite');

// D-16: install persists the GSD migration
function persistConfig(cfgFile: string): void {
  if (!loadConfig(cfgFile).exists) saveConfig(loadForUse(cfgFile).config, cfgFile);
  else loadForUse(cfgFile, undefined, { persist: true });
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
  const arg = args.positional[0];
  if (arg === undefined) return false;
  io.error(t('hooks.badArg', { arg: sanitizeText(arg).slice(0, 64) }));
  process.exitCode = 1;
  return true;
}

export async function runInstall(args: Args, cfgFile: string, io: InstallIo = defaultIo()): Promise<void> {
  if (badPositional(args, io)) return;
  const dryRun = args.flags['dry-run'] === true;
  const project = !!args.flags.project;
  let events = hookEventsFor(args.flags.hooks);
  if (!events) {
    io.error(t('hooks.badFlag'));
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
    io.error('✗ No ccinfobar install to point Claude Code at. Install it with: npm install -g ccinfobar');
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
  let claudeCode: string | null = null;
  if (events.length) {
    claudeCode = (io.claudeVersion ?? detectClaudeCode)();
    if (claudeCode) io.log(t('hooks.detected', { version: claudeCode }));
  }

  if (dryRun) {
    if (!plan.needsConfirm) io.log(t('install.dryRunFile', { file: tildify(file) }));
    showPlan(io, plan);
    const hookPlan = project ? null : previewHooks(file, command, events, claudeCode);
    if (!plan.changes && !hooksChanged(hookPlan)) io.log(t('install.unchanged'));
    if (hookPlan) showDryHooks(io, hookPlan);
    if (!project) {
      const gsd = gsdProjects();
      if (gsd.length) io.log(t('install.dryRunProjects', { count: gsd.length }));
      for (const p of gsd) io.log(`  ${tildify(p)}`);
    }
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

  const tool = project ? null : detectTool(plan.current?.command);
  if (tool) await offerImport(tool, args, cfgFile, io);
  let res: InstallResult;
  try {
    const hooks = events.length ? { events, claudeCode } : undefined;
    res = applyInstall(plan, { confirmed: true, adoptLegacy, hooks });
  } catch (e) {
    if (!(e instanceof InstallNeedsConfirmError)) throw e;
    io.error(t('install.stale', { file: tildify(file) }));
    process.exitCode = 1;
    return;
  }
  if (project) ignoreLocally(file);
  persistConfig(cfgFile);
  if (plan.changes) io.log(t('install.wrote', { command: show(command), file: tildify(file) }));
  else if (!hooksChanged(res.hooks)) io.log(t('install.unchanged'));
  if (plan.needsConfirm && !adoptLegacy && plan.current)
    io.log(t('install.replaced', { command: show(plan.current.command) }));
  if (res.hooks) reportHooks(io, res.hooks);
  if (res.backup) io.log(t('install.backup', { file: tildify(res.backup) }));

  if (project) {
    if (shadowed) io.log(`  It now wins over "${show(shadowed.command)}" from ${tildify(shadowed.file)}.`);
    io.log('  settings.local.json stays out of git; `ccinfobar uninstall --project` undoes it.');
    return;
  }
  io.log(`  Config: ${tildify(cfgFile)}`);
  if (tool) io.log(`  \`ccinfobar uninstall\` brings back ${tool.name}.`);
  const taken = takeOverProjects(command, userRefresh());
  if (taken.length) {
    io.log(t('install.projectsTaken', { count: taken.length }));
    for (const p of taken) io.log(`  ${tildify(p)}`);
  }
  const other = projectOverride(process.cwd());
  if (other) {
    io.log(`⚠ ${tildify(other.file)} sets its own statusLine, which wins in this project.`);
    io.log(`  Run \`${selfCommand()} install --project\` here to use ccinfobar in it too.`);
  }
  io.log(`  Customize with \`${hint} edit\` (browser) or \`${hint} tui\` (terminal).`);
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

function hooksRemoved(io: InstallIo, hooks: { removed: string[]; kept: string[] }): void {
  if (hooks.removed.length) io.log(t('hooks.removed', { events: hooks.removed.join(', ') }));
  if (hooks.kept.length) io.log(t('hooks.leftEdited', { events: hooks.kept.join(', ') }));
}

export async function runUninstall(args: Args, _cfgFile: string, io: InstallIo = defaultIo()): Promise<void> {
  if (badPositional(args, io)) return;
  const hooksOnly = args.flags.hooks !== undefined && args.flags.hooks !== false;
  if (args.flags.project) {
    if (hooksOnly) io.log(t('hooks.uninstallProject'));
    io.log(uninstallMessage(await uninstallAsking(projectLocalFile(process.cwd()), io)));
    return;
  }
  if (hooksOnly) {
    const file = claudeSettingsPath();
    const res = uninstallHooks(file);
    if (!res.removed.length && !res.kept.length) io.log(t('hooks.none', { file: tildify(file) }));
    hooksRemoved(io, res);
    if (res.backup) io.log(t('install.backup', { file: tildify(res.backup) }));
    return;
  }
  const released = releaseProjects();
  if (released.length) io.log(`✓ Gave ${released.length} project(s) their own status line back`);
  const res = await uninstallAsking(claudeSettingsPath(), io);
  io.log(uninstallMessage(res));
  hooksRemoved(io, res.hooks);
}
