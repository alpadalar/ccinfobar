import path from 'node:path';
import type { Args } from '../cli/args.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { claudeSettingsPath, tildify } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import { VERSION } from '../core/version.js';
import { selfCommand } from '../data/update-state.js';
import { type DetectedTool, detectTool, type ImportSource } from '../importers/index.js';
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

export async function runInstall(args: Args, cfgFile: string, io: InstallIo = defaultIo()): Promise<void> {
  const dryRun = args.flags['dry-run'] === true;
  const project = !!args.flags.project;
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

  if (dryRun) {
    io.log(t('install.dryRunFile', { file: tildify(file) }));
    showPlan(io, plan);
    if (!plan.changes) io.log(t('install.unchanged'));
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
    res = applyInstall(plan, { confirmed: true, adoptLegacy });
  } catch (e) {
    if (!(e instanceof InstallNeedsConfirmError)) throw e;
    io.error(t('install.stale', { file: tildify(file) }));
    process.exitCode = 1;
    return;
  }
  if (project) ignoreLocally(file);
  persistConfig(cfgFile);
  io.log(
    plan.changes
      ? t('install.wrote', { command: show(command), file: tildify(file) })
      : t('install.unchanged'),
  );
  if (plan.needsConfirm && !adoptLegacy && plan.current)
    io.log(t('install.replaced', { command: show(plan.current.command) }));
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

export async function runUninstall(args: Args, _cfgFile: string, io: InstallIo = defaultIo()): Promise<void> {
  if (args.flags.project) {
    io.log(uninstallMessage(await uninstallAsking(projectLocalFile(process.cwd()), io)));
    return;
  }
  const released = releaseProjects();
  if (released.length) io.log(`✓ Gave ${released.length} project(s) their own status line back`);
  io.log(uninstallMessage(await uninstallAsking(claudeSettingsPath(), io)));
}
