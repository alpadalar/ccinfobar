import fs from 'node:fs';
import path from 'node:path';
import { type Args, parseArgs } from './cli/args.js';
import { runDoctor } from './commands/doctor.js';
import { runInstall, runUninstall } from './commands/install-cli.js';
import {
  runImportCommand,
  runInit,
  runPreview,
  runTheme,
  runThemes,
  runUsage,
  runWidgets,
} from './commands/manage.js';
import { runUpdate } from './commands/update.js';
import { detectLevel, style } from './core/ansi.js';
import { createContext } from './core/context.js';
import { loadForUse } from './core/load.js';
import { configPath, lastPayloadPath } from './core/paths.js';
import { PRESETS } from './core/presets.js';
import { finalizeLine, render } from './core/renderer.js';
import type { Config, StatusPayload } from './core/types.js';
import { VERSION } from './core/version.js';
import { writeAtomic } from './data/store.js';
import { terminalWidth } from './data/terminal.js';
import { scheduleCheck, updateNotice } from './data/update-state.js';
import {
  mergeUsage,
  needsUsage,
  readUsageCache,
  scheduleUsage,
  usageApiDisabled,
  usageDue,
} from './data/usage.js';

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
    case 'install':
      await runInstall(args, cfgFile);
      return;
    case 'import':
      runImportCommand(args, cfgFile);
      return;
    case 'uninstall':
      runUninstall(args, cfgFile);
      return;
    case 'init':
      runInit(args, cfgFile);
      return;
    case 'preview':
      runPreview(args, cfgFile);
      return;
    case 'themes':
      runThemes(args, cfgFile);
      return;
    case 'theme':
      runTheme(args, cfgFile);
      return;
    case 'widgets':
      runWidgets(args, cfgFile);
      return;
    case 'update':
      await runUpdate(args, cfgFile);
      return;
    case 'usage':
      await runUsage(args, cfgFile);
      return;
    case 'doctor':
      runDoctor(cfgFile);
      return;
    default:
      console.error(`Unknown command "${args.command}". Run ccinfobar --help.`);
      process.exitCode = 1;
  }
}
