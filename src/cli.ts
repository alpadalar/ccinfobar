import fs from 'node:fs';
import path from 'node:path';
import { currentStatusLine, defaultCommand, install, uninstall } from './commands/install.js';
import { visibleWidth } from './core/ansi.js';
import { loadConfig, saveConfig } from './core/config.js';
import { createContext } from './core/context.js';
import { cacheDir, claudeSettingsPath, configPath, lastPayloadPath, tildify } from './core/paths.js';
import { getPreset, PRESETS } from './core/presets.js';
import { renderPreview } from './core/preview.js';
import { finalizeLine, render } from './core/renderer.js';
import { listThemes, resolveTheme, saveUserTheme, themesDir, themeToInput } from './core/themes.js';
import type { Config, StatusPayload } from './core/types.js';
import { terminalWidth } from './data/terminal.js';
import { ALL_WIDGETS, CATEGORIES } from './widgets/index.js';

declare const __VERSION__: string;
const DEMO_LINE = ['model', 'cwd', 'git-branch', 'context-bar', 'gsd-phase', 'gsd-plans', 'session-cost'].map(
  (type) => ({
    id: type,
    type,
  }),
);

export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

const HELP = `ccinfobar ${VERSION}
A customizable, GSD-aware status line for Claude Code

Usage
  ccinfobar                      Render the status line (reads Claude Code JSON from stdin)
  ccinfobar edit                 Open the drag-and-drop editor in your browser
  ccinfobar tui                  Open the terminal editor
  ccinfobar install              Point Claude Code's statusLine at ccinfobar
  ccinfobar uninstall            Remove ccinfobar from Claude Code settings
  ccinfobar themes               Preview every theme
  ccinfobar theme <id>           Switch theme
  ccinfobar theme new <id>       Create your own theme (--from <theme>)
  ccinfobar init [preset]        Write a preset config (${PRESETS.map((p) => p.id).join(', ')})
  ccinfobar preview              Print the status line with sample data
  ccinfobar widgets              List all widgets
  ccinfobar doctor               Check the setup

Options
  --config <file>                Use a specific config file
  --payload <file>               Render using a JSON payload file
  --width <n>                    Override the detected terminal width
  --refresh <seconds>            install: also set statusLine.refreshInterval
  --command <cmd>                install: command to write (default: auto)
  --port <n>                     edit: port to listen on
  --no-open                      edit: do not open a browser
  --no-detect                    edit: do not ask the terminal for its colors
  -v, --version                  Print the version
  -h, --help                     Show this help
`;

interface Args {
  command: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') args.flags.help = true;
    else if (a === '-v') args.flags.version = true;
    else if (a.startsWith('--no-')) args.flags[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      const next = argv[i + 1];
      if (inline !== undefined) args.flags[k] = inline;
      else if (
        next !== undefined &&
        !next.startsWith('-') &&
        ['config', 'payload', 'width', 'refresh', 'command', 'port', 'from'].includes(k)
      ) {
        args.flags[k] = next;
        i++;
      } else args.flags[k] = true;
    } else if (!args.command) args.command = a;
    else args.positional.push(a);
  }
  return args;
}

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
    const file = lastPayloadPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload));
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
    payload = JSON.parse(raw || '{}') as StatusPayload;
  } catch {
    process.stdout.write('ccinfobar: invalid JSON on stdin\n');
    return;
  }
  if (config.savePayload && typeof args.flags.payload !== 'string') savePayload(payload);
  const width = typeof args.flags.width === 'string' ? Number(args.flags.width) : undefined;
  const lines = renderStatus(config, payload, width);
  process.stdout.write(lines.map(finalizeLine).join('\n') + (lines.length ? '\n' : ''));
}

function doctor(cfgFile: string): void {
  const ok = (b: boolean) => (b ? '✓' : '✗');
  const loaded = loadConfig(cfgFile);
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
  console.log(`${ok(fs.existsSync(lastPayloadPath()))} Last payload ${tildify(lastPayloadPath())}`);
  console.log(`  Cache dir ${tildify(cacheDir())}`);
  console.log(`  Detected width ${terminalWidth(undefined) ?? 'unknown'}`);
  if (!usesUs) console.log('\nRun `ccinfobar install` to enable it in Claude Code.');
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
      const loaded = loadConfig(cfgFile);
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
      const command = typeof args.flags.command === 'string' ? args.flags.command : defaultCommand();
      const refresh = typeof args.flags.refresh === 'string' ? Number(args.flags.refresh) : undefined;
      const backup = install(command, refresh);
      if (!loadConfig(cfgFile).exists) saveConfig(loadConfig(cfgFile).config, cfgFile);
      console.log(`✓ statusLine set to "${command}" in ${tildify(claudeSettingsPath())}`);
      if (backup) console.log(`  Backup: ${tildify(backup)}`);
      console.log(`  Config: ${tildify(cfgFile)}`);
      console.log('  Customize with `ccinfobar edit` (browser) or `ccinfobar tui` (terminal).');
      return;
    }
    case 'uninstall': {
      console.log(
        uninstall()
          ? '✓ Removed ccinfobar from Claude Code settings'
          : 'ccinfobar is not the active statusLine',
      );
      return;
    }
    case 'init': {
      const id = args.positional[0] ?? 'default';
      const preset = getPreset(id);
      if (!preset) {
        console.error(`Unknown preset "${id}". Available: ${PRESETS.map((p) => p.id).join(', ')}`);
        process.exitCode = 1;
        return;
      }
      if (fs.existsSync(cfgFile) && !args.flags.force) {
        console.error(`${tildify(cfgFile)} already exists. Use --force to overwrite.`);
        process.exitCode = 1;
        return;
      }
      saveConfig(preset.build(), cfgFile);
      console.log(`✓ Wrote "${preset.name}" preset to ${tildify(cfgFile)}`);
      return;
    }
    case 'preview': {
      const width =
        typeof args.flags.width === 'string' ? Number(args.flags.width) : (process.stdout.columns ?? 120);
      const source = args.flags.last ? 'last' : 'sample';
      for (const line of renderPreview(loadConfig(cfgFile).config, source, width)) console.log(line);
      return;
    }
    case 'themes': {
      const width =
        typeof args.flags.width === 'string' ? Number(args.flags.width) : (process.stdout.columns ?? 120);
      const current = loadConfig(cfgFile).config;
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
      const loaded = loadConfig(cfgFile);
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
        const list = ALL_WIDGETS.filter((w) => w.category === cat.id);
        if (!list.length) continue;
        console.log(`\n${cat.name}`);
        const pad = Math.max(...list.map((w) => visibleWidth(w.type)));
        for (const w of list) console.log(`  ${w.type.padEnd(pad)}  ${w.description}`);
      }
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
