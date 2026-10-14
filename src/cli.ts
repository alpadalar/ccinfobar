import fs from 'node:fs';
import path from 'node:path';
import { type Args, parseArgs } from './cli/args.js';
import { printWidgetReport } from './commands/doctor.js';
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
} from './commands/install.js';
import { runUpdate } from './commands/update.js';
import { detectLevel, style, visibleWidth } from './core/ansi.js';
import { loadConfig, saveConfig } from './core/config.js';
import { createContext } from './core/context.js';
import { loadForUse } from './core/load.js';
import { cacheDir, claudeSettingsPath, configPath, lastPayloadPath, tildify } from './core/paths.js';
import { forGsd, listPresets, PRESETS } from './core/presets.js';
import { readLastPayload, renderPreview } from './core/preview.js';
import { finalizeLine, render } from './core/renderer.js';
import { listThemes, resolveTheme, saveUserTheme, themesDir, themeToInput } from './core/themes.js';
import type { Config, StatusPayload } from './core/types.js';
import { VERSION } from './core/version.js';
import { gsdInstalled } from './data/gsd.js';
import { writeAtomic } from './data/store.js';
import { terminalWidth } from './data/terminal.js';
import {
  availableUpdate,
  installKind,
  readUpdateState,
  scheduleCheck,
  selfCommand,
  updateNotice,
  updatesDisabled,
} from './data/update-state.js';
import {
  fetchUsage,
  mergeUsage,
  needsUsage,
  readUsageCache,
  scheduleUsage,
  usageApiDisabled,
  usageDue,
} from './data/usage.js';
import { type DetectedTool, detectTool, type ImportSource, importFrom, toConfig } from './importers/index.js';
import { ALL_WIDGETS, CATEGORIES } from './widgets/index.js';

const DEMO_LINE = ['model', 'cwd', 'git-branch', 'context-bar', 'gsd-phase', 'gsd-plans', 'session-cost'].map(
  (type) => ({
    id: type,
    type,
  }),
);

export { VERSION };

const HELP = `ccinfobar ${VERSION}
A customizable, GSD-aware status line for Claude Code

Usage
  ccinfobar                      Render the status line (reads Claude Code JSON from stdin)
  ccinfobar edit                 Open the drag-and-drop editor in your browser
  ccinfobar tui                  Open the terminal editor
  ccinfobar install              Point Claude Code's statusLine at ccinfobar
  ccinfobar install --project    Also win over this project's own statusLine (e.g. GSD's)
  ccinfobar install --no-global  With npx: do not install the ccinfobar command globally
  ccinfobar uninstall            Remove ccinfobar and restore your previous status line
  ccinfobar import <tool>        Import a ccstatusline or claude-powerline layout
  ccinfobar themes               Preview every theme
  ccinfobar theme <id>           Switch theme
  ccinfobar theme new <id>       Create your own theme (--from <theme>)
  ccinfobar init [preset]        Write a preset config (${PRESETS.map((p) => p.id).join(', ')})
  ccinfobar preview              Print the status line with sample data
  ccinfobar update               Update to the latest release (--check to only look)
  ccinfobar usage                Fetch your plan usage from Claude now
  ccinfobar widgets              List all widgets
  ccinfobar doctor               Check the setup

Options
  --config <file>                Use a specific config file
  --payload <file>               Render using a JSON payload file
  --width <n>                    Override the detected terminal width
  --refresh <seconds>            install: also set statusLine.refreshInterval
  --project                      install/uninstall: use .claude/settings.local.json here
  --import / --no-import         install: import the previous status line's layout without asking
  --file <path>                  import: read this settings file
  --command <cmd>                install: command to write (default: auto)
  --port <n>                     edit: port to listen on
  --no-open                      edit: do not open a browser
  --no-detect                    edit: do not ask the terminal for its colors
  -v, --version                  Print the version
  -h, --help                     Show this help
`;

function readStdin(timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function savePayload(payload: StatusPayload): void {
  try {
    writeAtomic(lastPayloadPath(), JSON.stringify(payload));
  } catch {}
}

function renderStatus(config: Config, payload: StatusPayload, widthFlag?: number): string[] {
  const width = widthFlag ?? terminalWidth(payload.session_id, payload.terminal_width ?? payload.columns);
  return render(createContext({ payload, config, terminalWidth: width }));
}

function currentCommandSafe(): string {
  try {
    return currentStatusLine()?.command ?? '';
  } catch {
    return '';
  }
}

function backupConfig(cfgFile: string): string | null {
  if (!fs.existsSync(cfgFile)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${cfgFile}.${stamp}.bak`;
  fs.copyFileSync(cfgFile, backup);
  try {
    fs.chmodSync(backup, 0o600);
  } catch {}
  return backup;
}

function runImport(
  source: ImportSource,
  opts: { file?: string | undefined; command: string },
  cfgFile: string,
): boolean {
  try {
    const result = importFrom(
      source,
      opts.file ? { file: opts.file, command: opts.command } : { command: opts.command },
    );
    const backup = backupConfig(cfgFile);
    saveConfig(toConfig(result), cfgFile);
    const count = (result.config.lines ?? []).reduce((n, l) => n + l.length, 0);
    console.log(
      `✓ Imported ${count} widgets from ${source}${result.file ? ` (${tildify(result.file)})` : ''}`,
    );
    if (backup) console.log(`  Previous ccinfobar config: ${tildify(backup)}`);
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    return true;
  } catch (err) {
    console.error(`✗ Import failed: ${(err as Error).message}`);
    return false;
  }
}

async function ask(question: string, fallback: boolean): Promise<boolean> {
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

async function offerImport(tool: DetectedTool, args: Args, cfgFile: string): Promise<void> {
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

async function runRender(args: Args, config: Config): Promise<void> {
  let raw: string;
  if (typeof args.flags.payload === 'string') raw = fs.readFileSync(args.flags.payload, 'utf8');
  else raw = await readStdin();
  let payload: StatusPayload;
  try {
    payload = JSON.parse(raw.trim() || '{}') as StatusPayload;
  } catch {
    process.stdout.write('ccinfobar: invalid JSON on stdin\n');
    return;
  }
  if (config.savePayload && typeof args.flags.payload !== 'string') savePayload(payload);
  const width = typeof args.flags.width === 'string' ? Number(args.flags.width) : undefined;
  const usageOn = !usageApiDisabled(config) && needsUsage(config, payload);
  const usage = usageOn ? readUsageCache() : null;
  const lines = renderStatus(config, usage ? mergeUsage(payload, usage) : payload, width);
  const notice = updateNotice(config, VERSION);
  if (notice && lines.length) {
    const level = detectLevel(config.colorLevel);
    lines[lines.length - 1] += ` ${style(notice, { fg: 'yellow' }, level)}`;
  }
  process.stdout.write(lines.map(finalizeLine).join('\n') + (lines.length ? '\n' : ''));
  scheduleCheck(config, payload.session_id);
  if (usageOn && usageDue(usage)) scheduleUsage();
}

function doctor(cfgFile: string): void {
  const ok = (b: boolean) => (b ? '✓' : '✗');
  const loaded = loadForUse(cfgFile);
  const sl = (() => {
    try {
      return currentStatusLine();
    } catch {
      return null;
    }
  })();
  const usesUs = !!sl?.command?.includes('ccinfobar');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`ccinfobar ${VERSION}`);
  console.log(`${ok(nodeMajor >= 20)} Node.js ${process.versions.node} (needs 20+)`);
  console.log(
    `${ok(loaded.exists && !loaded.error)} Config ${tildify(loaded.path)}${loaded.exists ? '' : ' (not created yet, defaults in use)'}`,
  );
  if (loaded.error) console.log(`  ${loaded.error}`);
  console.log(
    `${ok(usesUs)} Claude Code statusLine in ${tildify(claudeSettingsPath())}: ${sl?.command ?? 'not set'}`,
  );
  const dirs = new Set([process.cwd()]);
  const last = readLastPayload();
  const lastDir = last?.workspace?.project_dir ?? last?.workspace?.current_dir ?? last?.cwd;
  if (lastDir && fs.existsSync(lastDir)) dirs.add(lastDir);
  for (const dir of dirs) {
    const o = projectOverride(dir);
    if (!o) continue;
    console.log(`✗ ${tildify(o.file)} overrides it with: ${o.command}`);
    console.log(`  Run \`${selfCommand()} install --project\` in ${tildify(dir)} to use ccinfobar there.`);
  }
  console.log(`${ok(fs.existsSync(lastPayloadPath()))} Last payload ${tildify(lastPayloadPath())}`);
  console.log(`  Cache dir ${tildify(cacheDir())}`);
  console.log(`  Detected width ${terminalWidth(undefined) ?? 'unknown'}`);
  const upd = readUpdateState();
  const newer = availableUpdate(VERSION);
  if (updatesDisabled(loaded.config)) console.log('  Update checks off');
  else if (newer) console.log(`✗ Update available: ${VERSION} → ${newer} (run \`ccinfobar update\`)`);
  else {
    const when = upd ? `last checked ${new Date(upd.checkedAt).toLocaleString()}` : 'not checked yet';
    console.log(`✓ Up to date (${loaded.config.update} mode, ${installKind()} install, ${when})`);
  }
  if (upd?.error) console.log(`  Last update check failed: ${upd.error}`);
  printWidgetReport(loaded.config);
  if (!usesUs) console.log(`\nRun \`${selfCommand()} install\` to enable it in Claude Code.`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const cfgFile = typeof args.flags.config === 'string' ? path.resolve(args.flags.config) : configPath();

  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
  if (args.flags.help || args.command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  switch (args.command) {
    case null: {
      if (process.stdin.isTTY && typeof args.flags.payload !== 'string') {
        process.stdout.write(HELP);
        return;
      }
      const loaded = loadForUse(cfgFile);
      await runRender(args, loaded.config);
      return;
    }
    case 'edit':
    case 'editor': {
      const { startEditor } = await import('./editor/server.js');
      const { queryTerminalColors } = await import('./editor/terminal-colors.js');
      const port = typeof args.flags.port === 'string' ? Number(args.flags.port) : undefined;
      const terminal = args.flags.detect === false ? null : await queryTerminalColors();
      await startEditor({ configPath: cfgFile, port, open: args.flags.open !== false, terminal });
      return;
    }
    case 'tui': {
      const { runTui } = await import('./tui/index.js');
      await runTui({ configPath: cfgFile });
      return;
    }
    case 'install': {
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
      return;
    }
    case 'import': {
      const source = args.positional[0];
      if (source !== 'ccstatusline' && source !== 'claude-powerline') {
        console.error('Usage: ccinfobar import <ccstatusline|claude-powerline> [--file <path>] [--force]');
        process.exitCode = 1;
        return;
      }
      if (fs.existsSync(cfgFile) && !args.flags.force) {
        console.error(`${tildify(cfgFile)} already exists. Use --force to replace it (a backup is kept).`);
        process.exitCode = 1;
        return;
      }
      const file = typeof args.flags.file === 'string' ? path.resolve(args.flags.file) : undefined;
      runImport(source, { file, command: currentCommandSafe() }, cfgFile);
      return;
    }
    case 'uninstall': {
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
      return;
    }
    case 'init': {
      const id = args.positional[0] ?? 'default';
      const preset = listPresets().find((p) => p.id === id);
      if (!preset) {
        console.error(
          `Unknown preset "${id}". Available: ${listPresets()
            .map((p) => p.id)
            .join(', ')}`,
        );
        process.exitCode = 1;
        return;
      }
      if (fs.existsSync(cfgFile) && !args.flags.force) {
        console.error(`${tildify(cfgFile)} already exists. Use --force to overwrite.`);
        process.exitCode = 1;
        return;
      }
      const keepGsd = id === 'gsd' || preset.source === 'user';
      saveConfig(keepGsd ? preset.build() : forGsd(preset.build(), gsdInstalled()), cfgFile);
      console.log(`✓ Wrote "${preset.name}" preset to ${tildify(cfgFile)}`);
      return;
    }
    case 'preview': {
      const width =
        typeof args.flags.width === 'string' ? Number(args.flags.width) : (process.stdout.columns ?? 120);
      const source = args.flags.last ? 'last' : 'sample';
      for (const line of renderPreview(loadForUse(cfgFile).config, source, width)) console.log(line);
      return;
    }
    case 'themes': {
      const width =
        typeof args.flags.width === 'string' ? Number(args.flags.width) : (process.stdout.columns ?? 120);
      const current = loadForUse(cfgFile).config;
      for (const t of listThemes()) {
        const mark = t.id === current.theme ? ' (current)' : '';
        const origin = t.source === 'user' ? ' · yours' : '';
        console.log(
          `\n\x1b[1m${t.name}\x1b[0m  ${t.id}${mark}  \x1b[2m${t.style}${origin} · ${t.description}\x1b[0m`,
        );
        const demo = {
          ...current,
          theme: t.id,
          style: undefined,
          separator: undefined,
          separatorColor: undefined,
          padding: undefined,
          glyphs: undefined,
          lines: [DEMO_LINE],
        };
        for (const line of renderPreview(demo, 'sample', width)) console.log(`  ${line}`);
      }
      console.log(`\nSwitch with \`ccinfobar theme <id>\`. Your themes live in ${tildify(themesDir())}`);
      return;
    }
    case 'theme': {
      const loaded = loadForUse(cfgFile);
      if (args.positional[0] === 'new' || args.positional[0] === 'create') {
        const id = args.positional[1];
        if (!id) {
          console.error('Usage: ccinfobar theme new <id> [--from <theme>]');
          process.exitCode = 1;
          return;
        }
        const from = typeof args.flags.from === 'string' ? args.flags.from : loaded.config.theme;
        const base = resolveTheme(from);
        const file = saveUserTheme(themeToInput(base, id, base.id === id ? undefined : base.id));
        console.log(`✓ Created ${tildify(file)} from "${base.name}"`);
        console.log(`  Edit it, then run \`ccinfobar theme ${id}\`.`);
        return;
      }
      const id = args.positional[0];
      if (!id) {
        const t = resolveTheme(loaded.config.theme);
        console.log(`${t.name} (${t.id}), style ${loaded.config.style ?? t.style}`);
        console.log('Run `ccinfobar themes` to see all themes.');
        return;
      }
      const known = listThemes().find((t) => t.id === id);
      if (!known) {
        console.error(`Unknown theme "${id}". Run \`ccinfobar themes\` to list them.`);
        process.exitCode = 1;
        return;
      }
      const next = { ...loaded.config, theme: id };
      for (const k of ['style', 'separator', 'separatorColor', 'padding', 'glyphs'] as const) delete next[k];
      saveConfig(next, cfgFile);
      console.log(`✓ Theme set to ${known.name}`);
      const width = process.stdout.columns ?? 120;
      for (const line of renderPreview(next, 'sample', width)) console.log(line);
      return;
    }
    case 'widgets': {
      for (const cat of CATEGORIES) {
        const list = ALL_WIDGETS.filter((w) => !w.hidden && w.category === cat.id);
        if (!list.length) continue;
        console.log(`\n${cat.name}`);
        const pad = Math.max(...list.map((w) => visibleWidth(w.type)));
        for (const w of list) console.log(`  ${w.type.padEnd(pad)}  ${w.description}`);
      }
      return;
    }
    case 'update':
      await runUpdate(args, cfgFile);
      return;
    case 'usage': {
      const cache = await fetchUsage();
      if (args.flags.background) return;
      if (cache.error) console.log(`✗ ${cache.error}`);
      const r = cache.rate_limits;
      if (!r) {
        process.exitCode = 1;
        return;
      }
      const at = (w?: { resets_at?: number | string | null }) =>
        w?.resets_at ? `, resets ${new Date(w.resets_at).toLocaleString()}` : '';
      if (r.five_hour) console.log(`  5-hour: ${r.five_hour.used_percentage ?? '?'}%${at(r.five_hour)}`);
      if (r.seven_day) console.log(`  weekly: ${r.seven_day.used_percentage ?? '?'}%${at(r.seven_day)}`);
      for (const m of r.seven_day_models ?? []) {
        console.log(`  weekly ${m.model}: ${m.used_percentage ?? '?'}%${at(m)}`);
      }
      if (r.spend_limit)
        console.log(`  extra usage: $${r.spend_limit.used_usd} of $${r.spend_limit.limit_usd ?? '?'}`);
      return;
    }
    case 'doctor':
      doctor(cfgFile);
      return;
    default:
      console.error(`Unknown command "${args.command}". Run ccinfobar --help.`);
      process.exitCode = 1;
  }
}
