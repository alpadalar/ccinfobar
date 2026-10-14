import path from 'node:path';
import type { Args } from '../cli/args.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { loadForUse } from '../core/load.js';
import { claudeSettingsPath, tildify } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { selfCommand } from '../data/update-state.js';
import { type DetectedTool, detectTool, type ImportSource } from '../importers/index.js';
import {
  currentStatusLine,
  ignoreLocally,
  install,
  projectLocalFile,
  projectOverride,
  projectSettingsPath,
  releaseProjects,
  setupCommand,
  takeOverProjects,
  uninstall,
} from './install.js';
import { runImport } from './manage.js';

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

export async function offerImport(tool: DetectedTool, args: Args, cfgFile: string): Promise<void> {
  if (!tool.importable) {
    console.log(
      `Found ${tool.name} as your current status line. Its settings cannot be imported automatically.`,
    );
    return;
  }
  if (args.flags.import === false) return;
  const yes =
    args.flags.import === true ||
    (await ask(`Found ${tool.name} as your current status line. Import its layout into ccinfobar?`, true));
  if (yes) runImport(tool.tool as ImportSource, { command: tool.command }, cfgFile);
}

export async function runInstall(args: Args, cfgFile: string): Promise<void> {
  let command: string | null = typeof args.flags.command === 'string' ? args.flags.command : null;
  const refresh = typeof args.flags.refresh === 'string' ? Number(args.flags.refresh) : undefined;
  let hint = selfCommand();
  if (!command) {
    const setup = setupCommand(VERSION, {
      global: args.flags.global !== false,
      log: (l) => console.log(l.replace(/\/[^\s`]+/g, (p) => tildify(p))),
    });
    command = setup.command;
    if (setup.onPath) hint = 'ccinfobar';
  }
  if (!command) {
    console.error(
      '✗ No ccinfobar install to point Claude Code at. Install it with: npm install -g ccinfobar',
    );
    process.exitCode = 1;
    return;
  }
  if (args.flags.project) {
    const shadowed = projectOverride(process.cwd());
    const root = shadowed ? path.dirname(path.dirname(shadowed.file)) : process.cwd();
    const file = projectSettingsPath(root);
    const userRefresh = (() => {
      try {
        return currentStatusLine()?.refreshInterval;
      } catch {
        return undefined;
      }
    })();
    const backup = install(command, refresh ?? userRefresh, file);
    ignoreLocally(file);
    if (!loadConfig(cfgFile).exists) saveConfig(loadForUse(cfgFile).config, cfgFile);
    console.log(`✓ statusLine set to "${command}" in ${tildify(file)}`);
    if (shadowed) console.log(`  It now wins over "${shadowed.command}" from ${tildify(shadowed.file)}.`);
    if (backup) console.log(`  Backup: ${tildify(backup)}`);
    console.log('  settings.local.json stays out of git; `ccinfobar uninstall --project` undoes it.');
    return;
  }
  const previous = (() => {
    try {
      return currentStatusLine();
    } catch {
      return null;
    }
  })();
  const tool = detectTool(previous?.command);
  if (tool) await offerImport(tool, args, cfgFile);
  const backup = install(command, refresh);
  if (!loadConfig(cfgFile).exists) saveConfig(loadForUse(cfgFile).config, cfgFile);
  console.log(`✓ statusLine set to "${command}" in ${tildify(claudeSettingsPath())}`);
  if (backup) console.log(`  Backup: ${tildify(backup)}`);
  console.log(`  Config: ${tildify(cfgFile)}`);
  if (tool) console.log(`  \`ccinfobar uninstall\` brings back ${tool.name}.`);
  const taken = takeOverProjects(command, currentStatusLine()?.refreshInterval);
  if (taken.length) {
    console.log(`✓ Also replaced GSD's status line in ${taken.length} project(s):`);
    for (const p of taken) console.log(`  ${tildify(p)}`);
  }
  const shadowed = projectOverride(process.cwd());
  if (shadowed) {
    console.log(`⚠ ${tildify(shadowed.file)} sets its own statusLine, which wins in this project.`);
    console.log(`  Run \`${selfCommand()} install --project\` here to use ccinfobar in it too.`);
  }
  console.log(`  Customize with \`${hint} edit\` (browser) or \`${hint} tui\` (terminal).`);
}

export function runUninstall(args: Args, _cfgFile: string): void {
  if (args.flags.project) {
    const res = uninstall(projectLocalFile(process.cwd()));
    console.log(
      res.removed ? '✓ Removed ccinfobar from this project' : 'ccinfobar is not set in this project',
    );
    return;
  }
  const released = releaseProjects();
  if (released.length) console.log(`✓ Gave ${released.length} project(s) their own status line back`);
  const res = uninstall();
  if (!res.removed) console.log('ccinfobar is not the active statusLine');
  else if (res.restored) console.log(`✓ Restored the previous statusLine: ${res.restored.command}`);
  else console.log('✓ Removed ccinfobar from Claude Code settings');
}
