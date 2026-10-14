import { PRESETS } from '../core/presets.js';
import { VERSION } from '../core/version.js';

export const HELP = `ccinfobar ${VERSION}
A customizable, GSD-aware status line for Claude Code

Usage
  ccinfobar                      Render the status line (reads Claude Code JSON from stdin)
  ccinfobar edit                 Open the drag-and-drop editor in your browser
  ccinfobar tui                  Open the terminal editor
  ccinfobar install              Point Claude Code's statusLine at ccinfobar
  ccinfobar install --project    Also win over this project's own statusLine (e.g. GSD's)
  ccinfobar install --no-global  With npx: do not install the ccinfobar command globally
  ccinfobar install --dry-run    Show what install would change and write nothing
  ccinfobar uninstall            Remove ccinfobar and restore your previous status line
  ccinfobar import <tool>        Import a ccstatusline or claude-powerline layout
  ccinfobar themes               Preview every theme
  ccinfobar theme <id>           Switch theme
  ccinfobar theme new <id>       Create your own theme (--from <theme>)
  ccinfobar init [preset]        Write a preset config (${PRESETS.map((p) => p.id).join(', ')})
  ccinfobar preview              Print the status line with sample data
  ccinfobar preview --scenario <name>
                                 Preview a named situation (list them with --scenario)
  ccinfobar update               Update to the latest release (--check to only look)
  ccinfobar usage                Fetch your plan usage from Claude now
  ccinfobar widgets              List all widgets
  ccinfobar doctor               Check the setup
  ccinfobar explain [widget-id]  Show each widget's value, source and why it is empty
  ccinfobar explain --scenario <name>
                                 Explain the widgets for a named situation
                                 (put options after the widget id)
  ccinfobar bench                Measure render time: cold, warm, median and p95
  ccinfobar config get <path>    Print a config value (e.g. theme, lines.0.2.type)
  ccinfobar config set <path> <value>
                                 Set a value (JSON, else a string); invalid values are refused
  ccinfobar config unset <path>  Remove a value (defaults come back)

Options
  --config <file>                Use a specific config file
  --payload <file>               Render using a JSON payload file
  --width <n>                    Override the detected terminal width
  --scenario <name>              preview/explain/bench: use a named scenario (bare flag lists them)
  --runs <n>                     bench: number of runs (default 20, max 1000)
  --json                         explain, bench: print one JSON object
  --refresh <seconds>            install: also set statusLine.refreshInterval
  --project                      install/uninstall: use .claude/settings.local.json here
  --import / --no-import         install: import the previous status line's layout without asking
  --file <path>                  import: read this settings file
  --command <cmd>                install: command to write (default: auto)
  -y, --yes                      install: replace another tool's statusLine without asking
  --dry-run                      install: print the plan and write nothing
  --port <n>                     edit: port to listen on
  --no-open                      edit: do not open a browser
  --no-detect                    edit: do not ask the terminal for its colors
  -v, --version                  Print the version
  -h, --help                     Show this help
`;
