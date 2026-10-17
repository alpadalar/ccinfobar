<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/logo-light.svg">
  <img src="docs/images/logo-dark.svg" alt="ccinfobar logo" width="96" height="96">
</picture>

# ccinfobar

**A customizable status line for Claude Code, with a drag-and-drop editor.**

[![npm](https://img.shields.io/npm/v/ccinfobar?color=cb3837)](https://www.npmjs.com/package/ccinfobar)
[![CI](https://github.com/alpadalar/ccinfobar/actions/workflows/ci.yml/badge.svg)](https://github.com/alpadalar/ccinfobar/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](package.json)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/github/license/alpadalar/ccinfobar)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/screenshots/editor-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/screenshots/editor-light.png">
  <img src="docs/images/screenshots/editor-dark.png" alt="ccinfobar web editor" width="100%">
</picture>

</div>

<p align="center"><img src="docs/images/demo.gif" alt="ccinfobar status lines cycling through themes and presets" width="100%"></p>

## Contents

- [Why ccinfobar](#why-ccinfobar)
- [Quick start](#quick-start)
- [Editing your status line](#editing-your-status-line)
- [Screenshots](#screenshots)
- [Widgets](#widgets)
- [Themes](#themes)
- [Catalog](#catalog)
- [GSD integration](#gsd-integration)
- [Coming from another status line](#coming-from-another-status-line)
- [Reports](#reports)
- [Plugin](#plugin)
- [Commands](#commands)
- [Configuration](#configuration)
- [Updates](#updates)
- [Usage limits](#usage-limits)
- [Estimated cost and budgets](#estimated-cost-and-budgets)
- [Platform notes](#platform-notes)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Acknowledgements](#acknowledgements)

## Why ccinfobar

- **Drag-and-drop editor.** `ccinfobar edit` opens a local web editor with a live terminal preview. Drag widgets in from the palette, reorder them within or across lines, and style them in an inspector. It scales cleanly from 1080p to 4K.
- **30 themes, or your own.** Colored text, colored blocks, powerline arrows, rounded capsules or a bordered panel with a responsive grid, from classic to Nord, Dracula, Rosé Pine, Tokyo Night, Kanagawa and all four Catppuccin flavours. ASCII mode for terminals without a Nerd Font. Preview them all with `ccinfobar themes` and write your own in a few lines of JSON.
- **Terminal editor too.** `ccinfobar tui` does the same from the keyboard (or mouse) when you are on SSH or prefer to stay in the terminal.
- **First-class GSD support.** Milestone progress, the current phase, plan completion inside the phase, the next command to run, blockers, requirements and more, as separate widgets you can arrange freely. See [docs/GSD.md](docs/GSD.md).
- **111 widgets** covering model and session, context window, tokens and prompt cache, session cost, cost across sessions and budgets, 5-hour and weekly limits with pace tracking and projections, the running tool and turn time, an activity strip across sessions, git with PR CI checks, workspace, system, Claude's service status, your provider or gateway, any JSON endpoint, custom commands and a few just for fun.
- **Shows what matters when it matters.** Rules show or hide any widget by context, usage, git, time or provider, narrow terminals drop the least important widgets first, and glyph modes keep lines aligned in JetBrains terminals and GitHub comments. All of it is opt-in.
- **Uses the current Claude Code payload.** Rate limits, prompt cache statistics, PR status and repository info come straight from the status line JSON, without extra API calls.
- **Fast, dependency-free, self-updating.** Zero runtime dependencies, lazy data loading, an incremental transcript cache, and network checks that run in one background process, so the status line never waits on the network.
- **Cross-platform.** Linux, macOS and Windows, tested in CI on all three with Node 20, 22, 24 and 26.

## Quick start

Requirements: [Claude Code](https://code.claude.com) and Node.js 20 or newer.

```sh
npx ccinfobar@latest install
```

This installs the `ccinfobar` command globally, points Claude Code's status line at it and keeps it updated. If npm cannot install globally (for example without write access to its global folder), or you pass `--no-global`, it installs a pinned copy in `~/.config/ccinfobar/app` and uses that. The status line never runs `npx …@latest`, so nothing is downloaded and run behind your back on every refresh.

`install` prints the version it installs, points the `statusLine` setting in `~/.claude/settings.json` at ccinfobar and writes a default config. If you were using ccstatusline, claude-powerline, CCometixLine, cship or claude-hud, it offers to import that layout first. Projects where a local GSD install set its own status line are switched to ccinfobar too, through their git-ignored `.claude/settings.local.json`. The next Claude Code prompt shows the new status line.

- **In a terminal it asks first.** If another tool owns the status line, `install` shows the current and new command and asks `Replace? [y/N]`. `--yes` (`-y`) skips the question. Non-interactive runs (no terminal) replace it and print the replaced command, which uninstall can bring back. Use `--dry-run` to preview: it shows what would change and writes nothing.
- **Backups.** Before changing `settings.json`, ccinfobar saves a copy in `backups/` inside its config folder (`~/.config/ccinfobar/backups/`, `%APPDATA%\ccinfobar\backups\` on Windows): the last 10, plus the original from before the first install and the copy `uninstall` restores from, which are never deleted. File permissions, symlinks, BOM and line endings are kept.
- **Clean uninstall.** ccinfobar records what it replaced in `manifest.json`, so `ccinfobar uninstall` brings back the status line you had before, even after several reinstalls. Other tools' status lines are never removed.
- **Broken config.** If `config.json` does not parse, the status line shows `ccinfobar: config error at line N, run ccinfobar doctor` and the file is never overwritten. `ccinfobar doctor` shows the line, column and message.
- **One setting from the terminal.** `ccinfobar config get|set|unset <path> [value]` reads or changes one value, for example `ccinfobar config set gitHardening false`.

### Pinned install

To install an exact version instead of the latest, check the current version on [npm](https://www.npmjs.com/package/ccinfobar) and run:

```sh
npx ccinfobar@<version> install
```

Releases are published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), which links each package to the commit and workflow that built it. `npm view ccinfobar@<version> dist.attestations` shows the attestation, and `npm audit signatures` checks the signatures and provenance of the packages installed in a project.

Then make it yours:

```sh
ccinfobar edit     # browser editor
ccinfobar tui      # terminal editor
```

Without the global command, use `npx ccinfobar@latest edit`.

<details>
<summary>Manual setup</summary>

Install it with `npm install -g ccinfobar`, then add this to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "ccinfobar",
    "padding": 0
  }
}
```

Add `"refreshInterval": 5` to refresh the status line every 5 seconds even while Claude is idle, so clocks, timers and countdowns stay current.

Avoid `npx -y ccinfobar@latest` as the command: it would download and run whatever npm serves on every refresh.

</details>

## Editing your status line

### Web editor

```sh
ccinfobar edit
```

| Area | What you can do |
| --- | --- |
| Palette (left) | Search and browse widgets by category, each with a description and sample output. Drag one into any line or click `+`. The GSD category appears once GSD is installed. |
| Preview (top) | A terminal-style live preview. Switch between sample data, your last real session and a named situation from the **Scenario** picker (context nearly full, near the 5h limit, API key user and more), adjust the width, and pick your terminal's colors (16 profiles such as Windows Terminal, macOS Terminal, Solarized, Dracula, or custom) so the preview matches what you will really see. When started from a terminal, `ccinfobar edit` detects its colors automatically. |
| Lines (center) | Drag chips to reorder them or move them between lines, drop them on the trash to remove, drag line handles to reorder lines. `Alt` + arrow keys move the selected chip. |
| Inspector (right) | Colors (16 named, 256 palette or hex), background, bold/dim/italic, label override, merge, and every widget option. The **Global** tab covers style, separators, glyphs, icons, color depth and width, and **Colors from** keeps your style while taking the colors of any theme. |
| Theme gallery | Every theme rendered live with your own widgets. Apply with one click, filter by style, or open **New theme** to build your own: pick a starting theme, a style, and text and background colors per category or in a cycle, with a live preview. |
| Presets | Built-in and your own layouts with live previews. **Save current as preset** keeps your layout for later. |
| Catalog | Built-in and saved presets, themes and bundles with live previews, one-click apply, save with version history, and sharing ([Catalog](#catalog)). |
| Top bar | Presets, themes, undo/redo, import/export JSON, save (`Ctrl+S`), and one-click install into Claude Code. |

The editor runs only on `127.0.0.1` with a per-session token. Press **Done** or `Ctrl+C` to stop it.

### Terminal editor

```sh
ccinfobar tui
```

| Key | Action |
| --- | --- |
| `←` `→` / `↑` `↓` | Select widget / line |
| `Shift` + arrows (or `<` `>` `{` `}`) | Move the widget within or across lines |
| `a` | Add a widget (type to filter) |
| `Enter` / `e` | Edit properties |
| `d` | Remove widget |
| `n` / `D` / `K` `J` | New line / delete line / move line |
| `T` / `g` / `t` / `p` | Theme picker / global settings / presets / preview source |
| `u` / `U` | Undo / redo |
| `s` / `i` / `q` | Save / install / quit |
| `?` | Help |

Mouse works too: click to select, drag a chip to move it.

## Screenshots

<details>
<summary><b>Show screenshots</b></summary>

<details>
<summary>Editor and inspector</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/editor-dark.png" alt="Editor and inspector, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/editor-light.png" alt="Editor and inspector, light" width="100%">

</details>

<details>
<summary>Presets</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/presets-dark.png" alt="Presets, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/presets-light.png" alt="Presets, light" width="100%">

</details>

<details>
<summary>Catalog</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/catalog-dark.png" alt="Catalog, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/catalog-light.png" alt="Catalog, light" width="100%">

</details>

<details>
<summary>Catalog entry details</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/catalog-details-dark.png" alt="Catalog entry details, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/catalog-details-light.png" alt="Catalog entry details, light" width="100%">

</details>

<details>
<summary>Install from the marketplace</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/catalog-install-dark.png" alt="Install from the marketplace, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/catalog-install-light.png" alt="Install from the marketplace, light" width="100%">

</details>

<details>
<summary>Save to catalog</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/catalog-save-dark.png" alt="Save to catalog, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/catalog-save-light.png" alt="Save to catalog, light" width="100%">

</details>

<details>
<summary>Themes</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/themes-dark.png" alt="Themes, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/themes-light.png" alt="Themes, light" width="100%">

</details>

<details>
<summary>Theme builder</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/theme-builder-dark.png" alt="Theme builder, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/theme-builder-light.png" alt="Theme builder, light" width="100%">

</details>

<details>
<summary>Import</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/import-dark.png" alt="Import, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/import-light.png" alt="Import, light" width="100%">

</details>

<details>
<summary>Install in Claude Code</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/install-dark.png" alt="Install in Claude Code, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/install-light.png" alt="Install in Claude Code, light" width="100%">

</details>

<details>
<summary>Settings</summary>

<p><b>Dark</b></p>
<img src="docs/images/screenshots/settings-dark.png" alt="Settings, dark" width="100%">

<p><b>Light</b></p>
<img src="docs/images/screenshots/settings-light.png" alt="Settings, light" width="100%">

</details>

</details>

## Widgets

| Category | Widgets |
| --- | --- |
| Session & model | model, effort, thinking, fast mode, output style, session name and id, Claude Code version, vim mode, agent name, skills, provider or gateway (`provider`), how long the turn has run (`turn-timer`), how long the last permission prompt waited (`permission-wait`) |
| Context window | used or remaining percent (optionally relative to the auto-compact limit), bar, length, window size, compaction count |
| Tokens & cache | input, output, cached, total, cache hit rate, cache expiry countdown, last cache miss cause, output speed, performance (`performance`: hit rate and average response time) |
| Cost & time | session cost, cost per hour, estimated cost today, this week and per project across sessions (`cost-today`, `cost-week`, `cost-project`), budget, session and API duration, lines changed, message count |
| Usage limits | 5-hour and weekly usage (percent or 13 bar styles, with an even-pace marker), reset countdowns, per-model weekly limits such as Fable, spend limit, usage pace, projected usage at the reset (`usage-projection`), time until 100% (`limit-eta`), an at-risk chip (`limit-risk`) |
| Charts | moving sparklines of tokens per minute, context fill, 5-hour or weekly usage and dollars per hour over the session, activity across all your sessions in 15-minute slots (`activity-strip`) |
| Agents & tasks | Claude's task list, a table of the turn's subagents (type, job, last tool, tokens per minute, share, tokens, time, model), subagent count, the running tool and the turn's tool counts (`tool-activity`) |
| GSD | milestone, milestone progress, phase, status, plans, plan progress, next step, workstream, blockers, todos, requirements, last command, update notice, current task, summary |
| Git | branch, sha, changes, status, staged, unstaged, untracked, ahead/behind, conflicts, stash, in-progress operation, repo, worktree, pull request with optional CI check status (`pr` option `ci`), child repos of a workspace folder (`workspace-repos`) |
| Workspace | current directory (5 styles), project directory |
| System | clock, date, hostname, username, memory, load average, terminal width, platform, CLAUDE.md files, rules, MCP servers and hooks in effect (`env-counts`), Claude's status page (`service-status`) |
| Custom | shell command output, a value from any JSON endpoint (`http`), clickable link, environment variable |
| Fun | a small pet that reacts to context, usage and idle time (`pet`), a kaomoji face (`kaomoji`), a short quip about the context or 5h window (`quip`) |
| Layout | text, separator, flex space |

A widget without data (a new chat, a folder that is not a git repo or GSD project) shows its label and `—`, so every line you add is always visible. Turn on **Hide when no data** (`hideEmpty`) for any widget you would rather hide. The full list with options and examples is in [docs/WIDGETS.md](docs/WIDGETS.md), or run `ccinfobar widgets`.

### Live session widgets

These show what Claude is doing right now. They are opt-in: the default layout does not use them. The `agents` preset shows `tool-activity`, `turn-timer` and `permission-wait`, the `workspace` preset shows `workspace-repos`, or add them in the editor.

- `tool-activity`: the running tool and this turn's tool counts, `Bash npm test · Read 4, Edit 2, Bash 1`
- `turn-timer`: how long the turn has run, or the last one took, `Turn 2m14s`
- `permission-wait`: how long the last permission prompt in this turn waited, `Wait Bash 42s` (needs [hooks](#hooks))
- `env-counts`: CLAUDE.md files, rules, MCP servers and hooks in effect, `CLAUDE.md 2 · rules 3 · MCP 4 · hooks 5`
- `workspace-repos`: the git repos inside a folder that is not a repo itself, `repos: api (main*) · web (dev)`. Handy when you start Claude Code in a folder that holds several projects

`workspace-repos` lists the git repos directly inside the current folder with their branches, such as `repos: api (main) · web (dev)`, when the folder itself is not a repo. It reads `.git/HEAD` files, never runs git while rendering and rescans at most every 10 seconds. It hides itself anywhere below a folder that holds `.git` (set `hideEmpty: false` to show `repos: —` instead), so a dotfiles repo at `~/.git` hides it in your whole home folder. `GIT_DIR` and `GIT_WORK_TREE` are ignored. While it shows repos, the other git widgets hide instead of showing `—`; set `hideGitPlaceholders: false` to keep them, and `ccinfobar explain` names the reason. Turn on `dirty` to mark repos with uncommitted changes, such as `api (main*)`: a background job runs a hardened `git status` in at most 50 repos about once a minute, and the status line only reads its cache.

`tool-activity` shows the tool Claude is running and what it used this turn, such as `Bash npm test · Read 4, Edit 2, Bash 1`, from the transcript alone (no hooks needed). Set `scope: session` for session totals, `mode` to show only one part, and `showArgs: false` to hide the command or file name (it is cut at 32 characters). Claude Code redraws the status line on each new assistant message, so a finished tool clears at the next message unless `refreshInterval` is set.

`turn-timer` shows how long the current turn has run (`2m14s`) and, once it ends, how long it took (`last 3m02s`; set `afterStop: hide` to hide it instead). With `ccinfobar install --hooks` the time runs exactly from your prompt to Claude's stop; without hooks it comes from the transcript and is close. The time includes any wait for a permission prompt. Set `refreshInterval` to see it tick while Claude works.

`permission-wait` needs `ccinfobar install --hooks`. Claude Code hides the status line while a permission dialog is open, so the widget cannot show a live wait. Once the dialog closes it shows the last closed wait of the turn, such as `Wait Bash 42s`. The wait starts at Claude Code's permission `Notification`, which comes about 6 s after the dialog appears, so a prompt answered within about 6 s is not counted. It never shows an open wait or a stale timer.

`env-counts` counts what Claude Code loads for this folder, read from config files only: CLAUDE.md files (managed, user, and the project folder and its parents), AGENTS.md when it is in effect, rules files, MCP servers and hook handlers, or `hooks off` when hooks are disabled. It never runs `claude mcp list` or starts a server. Plugin MCP servers, claude.ai connectors and plugin hooks are not counted, `claudeMdExcludes` is not applied, and MCP health is not shown because Claude Code does not expose it to the status line. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#live-session-widgets).

**Refresh.** Claude Code runs the status line again on a new assistant message, on token, mode or model changes and on the `refreshInterval` timer. It does not run it on hook events or tool results, and not at all while a permission dialog is open. Timers and tool activity therefore move only when one of those happens. For `turn-timer`, `tool-activity`, `permission-wait` and other time-based widgets, use `ccinfobar install --refresh 5`; `install`, `doctor` and the editor's Settings suggest it, but nothing is set for you. A 1 s refresh is not recommended: it runs ccinfobar every second.

### External data

These are opt-in too and come from the network or `gh`. A background process fetches them after the status line has printed, so rendering never waits; the status line shows the cached result.

- `service-status`: Claude's status page when something is wrong, `⚠ major: Elevated errors on Opus +1`; hidden while all is well
- `http`: one value from any JSON endpoint, such as a relay balance, `$12.50`. Secrets for headers and query values come from env vars only (`Authorization=Bearer $RELAY_TOKEN`), are sent only over https or to localhost, and never include Claude, cloud or other tool credentials
- `pr` option `ci`: the PR's CI checks from your own `gh`, `#128 approved ✗ 2`, `● 3` while running, `✓` when all pass
- `provider`: who serves the session, `Bedrock`, `API key` or `GLM via api.z.ai`; nothing for a normal Claude login

Gateway users can turn on `basis: "auto"` on `session-cost` and `profileLabel` on `model`: a built-in model profile table (GLM, Kimi, DeepSeek, MiniMax, Qwen) gives prices, names and context windows, and your own `profiles` entries extend it. Context widgets already use the profile's window when Claude Code reports the 200K default; set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the model's window so Claude Code compacts at it too, and the `usable` basis follows. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` stops the automatic checks (usage, update, `service-status`); `http` items and the CI part still run because you turned them on. Recipes and every rule are in [docs/CONFIGURATION.md](docs/CONFIGURATION.md#external-data).

### Display options

These change how the line looks and behaves. All are off until you turn them on, in the editors (the widget's Visibility section, the Global tab and Settings) or in the config:

- **Visibility rules.** `"showWhen": "context.pct >= 70"` or `"hideWhen": "!git"` on any widget, by context, usage, cost, tokens, running agents, git repo, GSD project, time of day, weekday or provider. A rule with a typo is ignored, never blanks the line, and `ccinfobar doctor` points at it.
- **Priority overflow.** `"overflow": "priority"` drops the least important widgets first when a line does not fit, instead of wrapping or cutting it; set `priority` (0-100) on the ones you want to keep.
- **Glyph modes.** `"glyphMode": "jetbrains"` for JetBrains terminals, `single-width` for one-column emoji, and `paste-safe` for lines that stay aligned in a GitHub code block (`ccinfobar preview --glyph-mode paste-safe`). `ambiguousWidth: 2` is for CJK-locale terminals.
- **Gradient and Braille bars.** `"barColor": "gradient"` on any bar, colored by the theme's ramp, and the `ring` (one-cell gauge) and `matrix` (dot-matrix) bar styles.
- **Activity strip.** `activity-strip` shows when any of your sessions was busy over the last 9 hours, `··▂▅▇▄···▁▃▆██▅▂`, from the local cost ledger.
- **Fun widgets.** `pet`, `kaomoji` and `quip`. No network, no telemetry and no files written.
- **Terminal progress.** `ccinfobar install --progress` shows the context fill as the terminal tab's progress bar in Windows Terminal, Ghostty, WezTerm, ConEmu and iTerm2. It adds about 60-110 ms before each prompt; the `tty` channel (`progress.channel`) avoids that on Linux and macOS. Set Claude Code's `terminalProgressBarEnabled` to `false`, or the two bars flicker.

Every rule, metric and mode is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md#visibility-rules).

## Themes

```sh
ccinfobar themes          # preview every theme in your terminal
ccinfobar theme dracula   # switch
```

| Style | Themes |
| --- | --- |
| Colored text | `classic` (default), `minimal`, `mono`, `neon`, `pastel`, `amber`, `matrix` |
| Colored blocks | `blocks`, `slate`, `paper` |
| Powerline | `powerline`, `nord`, `dracula`, `gruvbox`, `tokyo-night`, `solarized`, `monochrome`, `dark`, `light`, `rose-pine`, `catppuccin-latte`, `catppuccin-frappe`, `catppuccin-macchiato`, `catppuccin-mocha`, `everforest`, `kanagawa` |
| Capsules | `catppuccin`, `bubblegum`, `one-dark` |
| Panel (box with optional grid) | `panel` |

![Theme gallery](docs/images/themes.png)

### Presets

A preset is a ready layout. `ccinfobar init <id> --force` writes one, or pick it under **Presets** in either editor. `dashboard` and `powerline` bring their own theme, the others use `classic`.

| Preset | Layout |
| --- | --- |
| `default` | Model, git and context, usage limits, and a GSD line when GSD is installed |
| `cockpit` | Developer dashboard: path and git, GSD, model and time, context and tokens, usage limits |
| `dashboard` | A boxed overview: model in the corner, usage cells, a full-width context bar, token graph, tasks and subagents |
| `minimal` | One compact line |
| `gsd` | Everything GSD tracks, plus context |
| `powerline` | Powerline arrows with the Tokyo Night theme (needs a Nerd Font) |
| `full` | Dense lines for wide terminals |
| `cost` | Session, daily and weekly cost, spend rate and a budget bar |
| `limits` | Five-hour and weekly limits with pace, projection and reset times |
| `git` | Repo, branch, sync, staged and unstaged files, stash, worktree and PR |
| `workspace` | Every repo in a folder of projects, with branch and dirty marker |
| `compact` | One dense line: model, path, git, context, cost and the 5h limit |
| `two-line` | Model, path, git and time on top; context, tokens, cache, cost and limits below |
| `agents` | What Claude is doing: turn timer, tools, subagents, permission waits and tasks |
| `charts` | Small graphs of context, token rate, output speed, spend rate and usage |
| `session` | Session name, id and time, context size, tokens, cache hits and messages |

### Dashboard

The **Dashboard** preset turns the panel style into a table: session id at the top left, the model as a badge at the top right, a border that changes color as the context fills, a full-width context bar, a moving tokens-per-minute graph, the task list and a table of running subagents.

```sh
ccinfobar init dashboard --force   # or Presets → Dashboard in the editor
```

![Dashboard preset](docs/images/dashboard.png)

Any theme can be drawn in any style (`"style": "capsule"`), and per-widget colors always win. To make your own, use **New theme** in the editor, or run `ccinfobar theme new mine --from nord` and edit `~/.config/ccinfobar/themes/mine.json`. Details: [docs/THEMES.md](docs/THEMES.md).

## Catalog

The catalog keeps layouts and looks you can apply in one step: presets, themes and bundles (a preset with a theme). In `ccinfobar edit`, click **Catalog** in the header. With a marketplace on, the **Marketplace** tab opens first: your own entries on top, then the marketplace entries (read from a 24-hour cache, with a **Refresh** button). **User** shows only yours (the first tab when the marketplace is off) and **Built in** only the ones that ship with ccinfobar, each grouped as bundles, presets and themes with a live preview of your config. The Apply button on a card applies it in one step (click a card for its details and full preview), `Ctrl+Z` undoes it, and nothing is written until you save.

**Save current as…** keeps your setup as a preset, a theme or a bundle, with a name, a description and an author (remembered for next time). Saving under an existing name asks whether to update it (a new version) or overwrite the latest one, and every entry has a version history with restore. Applying changes only the layout and the theme; your budget, profiles, language and other personal settings stay.

The System tab has every built-in preset and theme, plus 15 ready bundles:

- Mocha cockpit (`cockpit` + Catppuccin Mocha)
- Nord minimal (`minimal` + Nord)
- Dracula arrows (`powerline` + Dracula, needs a Nerd Font)
- Gruvbox git (`git` + Gruvbox)
- Tokyo limits (`limits` + Tokyo Night)
- Mono compact (`compact` without colors, in the plain text style without powerline glyphs; for pasting into GitHub also set `"glyphMode": "paste-safe"`, a personal setting that bundles never change)
- Everforest repos (`workspace` + Everforest)
- Kanagawa agents (`agents` + Kanagawa)
- Rosé Pine 2-line (`two-line` + Rosé Pine)
- One Dark cost (`cost` + One Dark capsules)
- Solarized GSD (`gsd` + Solarized)
- Panel dashboard (`dashboard`, boxed)
- Paper default (`default` + Paper, for light terminals)
- Neon charts (`charts` + Neon)
- Amber session (`session` + Amber)

Every action has a CLI command too:

```sh
ccinfobar catalog list                        # your entries, then the built-in ones
ccinfobar catalog apply bundle/nord-minimal   # apply the Nord minimal bundle (backup first)
ccinfobar catalog save "My setup"             # save your current setup as a bundle
ccinfobar catalog history "My setup"          # versions, then `catalog restore <ref> <version>`
ccinfobar catalog publish                     # show what would be sent, then send after you confirm
```

Sharing is on by default, but nothing leaves your machine until you set a marketplace endpoint; there is no default endpoint. With one set (`ccinfobar catalog endpoint <url>`), `catalog publish` and the editor's **Publish…** show the exact payload and send only after you confirm, `catalog list --remote` browses the marketplace, and `catalog install <publisher/slug>` or **Install** in the editor's Marketplace tab adds an entry to yours after showing every command and URL it keeps (applying it stays a separate step). Marketplace content is data only: no `command`, `http` or `env` widgets, only http(s) links and no personal settings. Details: [docs/CATALOG.md](docs/CATALOG.md) and [docs/MARKETPLACE.md](docs/MARKETPLACE.md).

## GSD integration

If you use [GSD (Get Shit Done)](https://github.com/gsd-build/get-shit-done), ccinfobar reads your `.planning/` folder and shows where the project stands:

```
v1.2 Billing │ █████░░░░░ 50% │ Phase 4/6 Invoice export │ executing │ plans 3/5
next: /gsd-execute-phase 4 │ ⚠ 1 concern │ req 14/22
```

- Progress is computed from the plan and summary files on disk, using the same formula as GSD, so it stays correct even when `STATE.md` lags behind.
- Workstreams, decimal phases (`4.5`), nested plan folders and shipped milestones in `ROADMAP.md` are all handled.
- No processes are spawned; everything is read from files in a few milliseconds.

Without GSD installed, ccinfobar leaves GSD out of its default layout and the editor. Once GSD is installed (globally or in a project), the default GSD line is added as the second line of your layout, once, without touching the rest, and the GSD widgets show up in the editor. Start with `ccinfobar init gsd --force`, or drag widgets from the GSD category. Details: [docs/GSD.md](docs/GSD.md).

## Coming from another status line

`ccinfobar install` recognises the status line you use today and asks whether to bring its layout along:

```
$ ccinfobar install
Found ccstatusline as your current status line. Import its layout into ccinfobar? [Y/n]
✓ Imported 29 widgets from ccstatusline (~/.config/ccstatusline/settings.json)
✓ statusLine set to "/usr/local/bin/ccinfobar" in ~/.claude/settings.json
  `ccinfobar uninstall` brings back ccstatusline.
```

| From | What is imported |
| --- | --- |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline) | Lines, widgets, colors, labels (custom text), separators, merge, raw values, powerline mode and caps, `full-minus-40` width |
| [claude-powerline](https://github.com/Owloops/claude-powerline) | Lines, segments, theme, style (`minimal`, `powerline`, `capsule`, `tui`), charset, auto wrap, width reserve, custom colors, and `--theme`/`--style` flags in the command |
| [CCometixLine](https://github.com/Haleclipse/CCometixLine) (`ccline`) | Segments from `~/.claude/ccline/config.toml` (or its default layout; a `-t`/`--theme` flag in the status line command imports that theme instead, from `~/.claude/ccline/themes/` or the nine built-in themes), icons for the style mode as labels, text and background colors, bold, separator, and the powerline arrow separator as the powerline style. Usage API options and the `update` segment are dropped |
| [cship](https://github.com/stephenleo/cship) | `lines` or `format` from the file cship itself uses (`--config` in the status line command, else the nearest `cship.toml` or `starship.toml` above the current folder, up to your home folder when it is inside it, else `~/.config/cship.toml` or `~/.config/starship.toml`), `$cship.*` modules, the Starship git, directory, host, user, time and memory modules, `$fill`, literal text, `[text](style)` spans, symbols as labels and Starship styles. Thresholds become threshold colors where the widget has them; other Starship modules and `$cship.account` are dropped (no `starship module` command is created) |
| [claude-hud](https://github.com/jarrodwatts/claude-hud) | `plugins/claude-hud/config.json` in your Claude config folder with `claude-hud.json` merged over it, on top of claude-hud's defaults: the expanded layout (one line per element in `elementOrder`, merged groups on one line) or the compact one (a session line plus activity lines), the project line order, the custom line, path levels, colors, the separator line, and `--extra-cmd` from the status line command as a command widget. Thresholds and the advisor, added folders, external usage files and the language are reported as approximated or dropped |

Every import prints a report: what was imported, what was approximated and what was dropped, with the reason. `--dry-run` prints the report and a preview with sample data and writes nothing. Run it later with `ccinfobar import ccstatusline` or `ccinfobar import claude-powerline --file <path>` (`ccline` works as a short name for `ccometixline`); your current ccinfobar config is backed up first.

Imported labels and text are cleaned of terminal escape sequences, and `javascript:`/`data:` links are dropped. A layout that runs shell commands (ccstatusline custom commands, claude-hud `--extra-cmd`) or opens URLs lists them first: on a terminal you are asked whether to keep them (default No), `--allow-commands` keeps them, and `--yes` or a non-interactive run drops them and prints the command to re-run with `--allow-commands`. That command passes the status line command it read with `--command`, because `install` replaces it before you run the hint. ccusage, the GSD status line and your own scripts are recognised but have no layout to import.

## Reports

`ccinfobar report` shows tokens, estimated cost and active time per project, by day for the last 7 days:

```
$ ccinfobar report
Day         Project   Sessions  Input  Output  Cache read  Cache write  Total  Cost (est.)  Active
2026-10-15  api              1   2.6k    7.8k        252k        16.6k   279k        $0.44      9m
2026-10-15  web              2   4.7k   13.1k        324k        25.6k   368k        $0.28     18m
2026-10-15  cli              1   2.4k    4.7k        206k         8.9k   222k        $0.06      8m
            subtotal         4   9.7k   25.5k        783k        51.1k   869k        $0.78     36m
2026-10-16  notes            1   2.3k    5.6k        191k        14.6k   213k        $0.34     10m
2026-10-16  api              1   2.7k    7.0k        218k         8.9k   237k        $0.21      9m
            subtotal         2   5.0k   12.6k        409k        23.5k   450k        $0.55     19m
            total            6  14.7k   38.1k        1.2M        74.6k   1.3M        $1.33     56m

Costs are estimates at list prices; on a subscription they are not what you pay.
```

- `--period week` groups by ISO week (last 4 weeks), `--period month` by month (last 3 months).
- `--since` and `--until` take `YYYY-MM-DD` or a count back (`7d`, `4w`, `3m`); `--all` shows everything there is.
- `--project <text>` keeps projects whose path contains the text; `--project .` is the current project: the longest project root in the report that is the current folder or holds it, so it also works from a subfolder.
- `--csv` and `--json` print CSV or one JSON object (always English) instead of the table. In a terminal the table fits the width by dropping the token columns first (cache ones first), then shortening the project, then dropping Sessions and Active; below that each row takes two lines, period and project over the numbers. Piped, every column is kept.

How it counts:

- Tokens, time and projects come from the transcripts in your Claude config folder. Each request is counted once, by its message and request id: Claude Code writes a reply in several lines, subagent transcripts repeat their requests and a fork copies earlier ones, and none of that is counted twice. Subagents count toward their parent session. Active time adds up the gaps between entries of a session, each capped at 5 minutes. When a row also holds a session whose transcript is gone (only its ledger cost is left), its tokens and time are marked `+`, and JSON rows say `tokensPartial: true`.
- Cost comes from the local cost ledger (the one behind `cost-today`) when it saw the session from its start. Otherwise it is estimated from the transcript with a built-in, dated price table, or your `profiles.models` prices when you set them. Costs that are only partly known are marked `*`, and unpriced models are listed. It is always an estimate at list prices; on a subscription it is a notional price, not what you pay.
- One Claude config folder per run. For another profile, run `CLAUDE_CONFIG_DIR=~/.claude-work ccinfobar report`.
- The first run builds an index in the cache folder (`report/` in `~/.cache/ccinfobar`, `~/Library/Caches/ccinfobar` on macOS, `%LOCALAPPDATA%\ccinfobar\cache` on Windows), so later runs read only what is new. It holds numbers, hashes, model and session ids and project paths, never prompt text. Totals of transcripts that Claude Code deletes later (`cleanupPeriodDays`) are kept for 13 months, so your history survives that cleanup from the first run on.
- `--rebuild` reads every transcript again and repairs the cost ledger summary the cost widgets use; deleted transcripts keep their totals.
- CSV has a fixed English header, one row per period and project and the full project path. A row priced only in another currency (a model profile in CNY, for example) has an empty `cost_usd` and `partial` set to `true`; `--json` has the amount in `costOther`. A text cell that starts with `=`, `+`, `-`, `@` or a tab gets a leading `'`, so a spreadsheet never runs it as a formula; saving the file again from Excel can undo that.

## Plugin

ccinfobar also ships a small Claude Code plugin, so you can install and control it without leaving Claude Code. The status line itself always comes from the npm package; the plugin only runs the `ccinfobar` command.

| | npm | Plugin |
| --- | --- | --- |
| Install | `npx ccinfobar@latest install` | `claude plugin marketplace add alpadalar/ccinfobar`, then `claude plugin install ccinfobar@ccinfobar` and `/ccinfobar:install` |
| Status line | Rendered by the `ccinfobar` command | The same `ccinfobar` command; the plugin has no renderer |
| Controls | `ccinfobar edit`, `doctor`, `theme` in a terminal | `/ccinfobar:edit`, `/ccinfobar:doctor`, `/ccinfobar:theme` inside Claude Code |
| Updates | Updates itself in the background | The plugin does not auto-update; the `ccinfobar` command still does |
| Remove | `ccinfobar uninstall`, then `npm rm -g ccinfobar` | `/ccinfobar:uninstall`, then `claude plugin uninstall ccinfobar@ccinfobar` |

Skills (you run them; Claude never starts them on its own):

- `/ccinfobar:install`: shows `ccinfobar install --hooks --dry-run`, asks (by name if another tool's status line would be replaced), then installs the status line and the optional [hooks](#hooks). Pass `--no-hooks` to skip them.
- `/ccinfobar:edit`: starts the web editor in the background with `ccinfobar edit --detach` and gives you the URL.
- `/ccinfobar:doctor`: runs `ccinfobar doctor` and lists the problems first. It suggests fixes and runs none on its own.
- `/ccinfobar:theme [id]`: switches theme, or lists them with `ccinfobar themes --list` and asks.
- `/ccinfobar:uninstall`: runs `ccinfobar uninstall` (status line and hooks) and explains the next step.

The plugin has no status line, no renderer, no hooks of its own and never writes a settings file; only `ccinfobar` commands change settings. If `ccinfobar` is not installed, a skill offers `npx ccinfobar@latest install` and runs it (dry run first) only after you agree.

**Pinning.** `claude plugin marketplace add alpadalar/ccinfobar#v0.7.0` pins the plugin to the release tag of this version; any later tag works the same way. The marketplace needs the first release that contains `.claude-plugin/marketplace.json` (the first release after 0.6.2); older tags have no plugin. Third-party marketplaces do not auto-update by default. That is harmless here, because the skills only call the `ccinfobar` command, which keeps itself up to date.

**Removal order.** Run `/ccinfobar:uninstall` or `ccinfobar uninstall` first, then `claude plugin uninstall ccinfobar@ccinfobar` or `npm rm -g ccinfobar`. Removing the plugin leaves nothing in your settings.

**No plugin?** Paste the prompt at the top of [INSTALL.md](INSTALL.md) into Claude Code and Claude installs a pinned version step by step, with a dry run first.

### Hooks

Hooks are optional. They let Claude Code tell ccinfobar exactly when a turn starts and ends, when a permission prompt is waiting and when a subagent starts or stops, instead of guessing from the transcript. Only `permission-wait` needs them; every other widget works without them, and `turn-timer`, `agents` and `agent-count` become exact with them.

```sh
ccinfobar install --hooks              # add them (also: Settings, Claude Code, Hooks in the editor)
ccinfobar install --hooks=permission   # also add PermissionRequest
ccinfobar uninstall --hooks            # remove only ccinfobar's hooks
```

`install --hooks` registers seven events; `--hooks=permission` adds an eighth, `PermissionRequest`.

| Event | What is recorded |
| --- | --- |
| `SessionStart` | the source (such as `startup` or `resume`); a new session also starts the daily update check |
| `UserPromptSubmit` | the prompt id |
| `Stop` | the prompt id |
| `SubagentStart`, `SubagentStop` | the agent id and type, and on stop its transcript path |
| `Notification` | only permission prompts (matcher `permission_prompt`) |
| `PermissionDenied` | the tool name, when auto mode denies a tool call (Claude Code 2.1.89+, cannot block) |
| `PermissionRequest` (opt-in) | the tool name |

Each event is one line with a timestamp in `<cache dir>/hooks/<session id>.jsonl` (`~/.cache/ccinfobar/hooks/`, `~/Library/Caches/ccinfobar/hooks/` on macOS, `%LOCALAPPDATA%\ccinfobar\cache\hooks\` on Windows); logs older than 7 days are removed when a new session starts. Prompt text, Claude's replies and tool input are never stored. The hook command prints nothing and always exits 0, and every hook runs in the background (`async`), so it never slows a prompt down.

- Hooks need Claude Code 2.1.101 or newer; `install --hooks` checks the version and refuses otherwise (the status line still installs). `--dry-run` lists every hook change.
- They go into `~/.claude/settings.json` only, never into a project file, and are recorded in the manifest. Hooks you edited yourself and other tools' hooks are left alone; `uninstall` restores the settings file byte for byte when nothing else changed it.
- `PermissionRequest` is opt-in. Leave it off on Windows without Git Bash, where a failing `PermissionRequest` hook can block tool calls.
- Hooks call the same `ccinfobar` command as the status line. Run `ccinfobar uninstall` before `npm rm -g ccinfobar`. Because the hooks are async, a removed binary shows no notice in the transcript by default, only in verbose or transcript mode, so leftovers are easy to miss. `ccinfobar doctor` warns about hook commands whose binary is gone.

## Commands

| Command | Description |
| --- | --- |
| `ccinfobar` | Render the status line from the JSON on stdin (what Claude Code runs) |
| `ccinfobar edit` | Open the web editor (`--port <n>`, `--no-open`, `--no-detect`) |
| `ccinfobar edit --detach` | Start the editor in the background, print its URL and exit; a running one is reused, and it stops after 30 minutes idle |
| `ccinfobar tui` | Open the terminal editor |
| `ccinfobar install` | Set Claude Code's `statusLine`, offering to import your previous one (`--yes` to replace another tool's without asking, `--dry-run` to only show the plan, `--import`, `--no-import`, `--allow-commands` to keep imported commands, `--command <cmd>`, `--refresh <seconds>`; through npx it also installs the `ccinfobar` command globally, or a pinned copy with `--no-global`) |
| `ccinfobar install --hooks` | Also add the optional [hooks](#hooks) (`--hooks=permission` adds PermissionRequest) |
| `ccinfobar install --progress` | Show context fill as the terminal tab's progress bar (OSC 9;4) through synchronous hooks; needs Claude Code 2.1.141+ and adds about 60-110 ms before each prompt |
| `ccinfobar usage` | Fetch your 5-hour and weekly usage from Claude now |
| `ccinfobar install --project` | Use ccinfobar in this project even if its `.claude/settings.json` sets another status line |
| `ccinfobar uninstall` | Remove ccinfobar and its hooks from Claude Code settings and restore the status line you had before (`--project` for the project file). Run it before `npm rm -g ccinfobar` |
| `ccinfobar uninstall --hooks` | Remove only ccinfobar's hooks and keep the status line |
| `ccinfobar uninstall --progress` | Remove only the terminal progress handlers, turn `progress.enabled` off and clear the bar |
| `ccinfobar themes` | Preview every theme (`--width <n>`; `--list` prints ids and names only) |
| `ccinfobar theme <id>` | Switch theme; `ccinfobar theme new <id> --from <theme>` creates your own |
| `ccinfobar import <tool>` | Import a `ccstatusline`, `claude-powerline`, `ccometixline` (`ccline`), `cship` or `claude-hud` layout (`--file <path>`, `--force`, `--dry-run` to only show the report and a preview, `--allow-commands` to keep its commands and URLs without asking, `--command <cmd>` to read that status line command instead of the current one) |
| `ccinfobar report` | Tokens, estimated cost and active time per project ([Reports](#reports); `--period day\|week\|month`, `--since`/`--until <date>`, `--all`, `--project <text>`, `--csv`, `--json`, `--rebuild`) |
| `ccinfobar init [preset]` | Write a [preset](#presets): `default`, `cockpit`, `dashboard`, `minimal`, `gsd`, `powerline`, `full`, `cost`, `limits`, `git`, `workspace`, `compact`, `two-line`, `agents`, `charts`, `session` (`--force` to overwrite) |
| `ccinfobar preview` | Print the status line with sample data (`--last` for your last session, `--width <n>`, `--glyph-mode <mode>` to try a glyph mode without saving it, for example `paste-safe` for text that stays aligned in a GitHub issue, `--scenario <name>` for a named situation: `fresh-session`, `context-full`, `near-5h-limit`, `many-subagents`, `gsd-project`, `no-git`, `api-key-user`, `bedrock-user`, `gateway-glm`, `near-7d-limit`, `over-budget`, `workspace-folder`, `waiting-permission`, `service-incident`, `pr-ci-failing`; a bare `--scenario` lists them) |
| `ccinfobar update` | Update to the latest release now (`--check` to only look) |
| `ccinfobar widgets` | List all widgets |
| `ccinfobar doctor` | Check the setup and explain, widget by widget, why something is hidden or cut off; points to `ccinfobar explain` for details |
| `ccinfobar explain [widget-id]` | Show each widget's value, where it came from (payload field, cache and its age, git, GSD) and why it is empty (`--json` for bug reports, `--scenario <name>`, `--payload <file>`). `env`, `command`, `http` and `tool-activity` values are redacted; `--show-values` shows them in a terminal |
| `ccinfobar bench` | Measure render time: a `node -e 0` control, then cold and warm median and p95 (`--runs <n>`, `--scenario <name>`, `--json`) |
| `ccinfobar config get\|set\|unset <path> [value]` | Read or change one config value by dotted path, e.g. `ccinfobar config set gitHardening false` or `ccinfobar config get lines.0.2.type`. Values are parsed as JSON, else taken as a string; a value that would not pass validation is refused and nothing is written |
| `ccinfobar catalog <command>` | Browse, apply and save presets, themes and bundles ([Catalog](#catalog)): `list`, `show`, `history`, `apply`, `save`, `restore`, `share`, `unshare`, `delete`, `author`, `endpoint`, `publisher`, `publish` (`--json`, `--dry-run` on the write commands, `--remote` to browse a marketplace) |
| `ccinfobar hook <Event>` | Used by Claude Code hooks: records one event and prints nothing |

All commands accept `--config <file>`.

## Configuration

The config lives in `~/.config/ccinfobar/config.json` (`%APPDATA%\ccinfobar\config.json` on Windows). The editors write it for you; to edit it by hand, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md). It ships with a JSON schema, so editors such as VS Code autocomplete every field.

```json
{
  "lines": [
    [
      { "id": "m", "type": "model", "bold": true },
      { "id": "d", "type": "cwd", "options": { "style": "short" } },
      { "id": "f", "type": "flex" },
      { "id": "c", "type": "context-bar", "options": { "width": 12, "basis": "usable" } }
    ]
  ],
  "theme": "tokyo-night"
}
```

### Languages

ccinfobar speaks English and Turkish. The status line, the CLI and both editors follow your locale (`CCINFOBAR_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG`, then the system locale). Set `"language": "en"` to keep English, or `"tr"` for Turkish; `ccinfobar config set language tr` does the same. See [Language](docs/CONFIGURATION.md#language).

## Updates

ccinfobar keeps itself up to date: each time Claude Code starts a session (and at least once a day), after the status line has been printed, a background process asks GitHub for the latest release and installs it from npm (or from the GitHub release if npm does not have it yet); the status line never waits for it. Installs made from a GitHub release tarball move to the npm package on their next update.

| `update` | Behaviour |
| --- | --- |
| `"auto"` (default) | Installs new releases in the background (global installs only; npx always runs the latest, source checkouts are left alone) |
| `"notify"` | Adds `⬆ ccinfobar 0.4.0 · ccinfobar update` to the end of the status line |
| `"off"` | Never checks |

`ccinfobar update` updates right away (`--check` only looks). Checks are skipped when `CI` or `CCINFOBAR_NO_UPDATE` is set, and when Claude Code's `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set (to any non-empty value) ccinfobar makes no automatic network request: no update check, no usage fetch and no `service-status` check. `http` items and the `pr` CI part still run, since you added them. `ccinfobar update` and `ccinfobar usage` still work when you run them, and `ccinfobar doctor` says when this is on.

## Usage limits

Claude Code sends your 5-hour and weekly usage only in some sessions, and never the per-model weekly limits (such as Fable) that some plans have. When they are missing, ccinfobar asks Claude for them with your existing login, the same way ccstatusline does, in the background and at most every 3 minutes. Data from Claude Code always wins. `ccinfobar usage` fetches it now; `usageApi: false` turns this off, and so does `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. See [SECURITY.md](SECURITY.md) for what is sent where.

All sessions of one account share the same limits: the newest value wins, so an idle session shows what the active one sees, an expired window never comes back, and two accounts (two `CLAUDE_CONFIG_DIR`s) never mix. `usage-projection`, `limit-eta` and `limit-risk` project the current pace to the end of the window; `ccinfobar explain` says which session or source a value came from.

## Estimated cost and budgets

`cost-today`, `cost-week` and `cost-project` add up the cost of all your sessions from a small local ledger, and `activity-strip` shows when they were busy. Counting starts when the first of these widgets (or a daily `budget` widget) is on your status line, so earlier sessions are not included. The numbers are Claude Code's own estimates and will differ from your bill. Set a budget with `ccinfobar config set budget.daily 10` (or in the editor or TUI) and add the `budget` widget; it turns yellow at 80% and red when you are over. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#budget) for details.

## Platform notes

- **Fonts.** Powerline arrows, capsule caps and the `nerd` icon set need a [Nerd Font](https://www.nerdfonts.com/). With the default `charset: "auto"`, ccinfobar avoids them in Apple Terminal (whose default fonts lack them) and draws plain colored blocks and half-block caps instead. Set `charset` to `nerd` once your terminal uses a Nerd Font, or to `text` for pure ASCII.
- **Colors.** The color depth is detected automatically and honors `NO_COLOR`, `FORCE_COLOR` and `COLORTERM`. Set `colorLevel` if your terminal disagrees.
- **Terminal width.** Used for `flex` spacing and truncation. ccinfobar probes the terminal Claude Code runs in on Linux and macOS. On Windows, set `maxWidth` to a fixed number if you use `flex`.
- **Windows.** Works in Windows Terminal, PowerShell and cmd. Prefer a global install; `npx` startup on Windows is slow.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Nothing shows up | Run `ccinfobar doctor`. Claude Code also hides the status line in untrusted folders and while dialogs are open. |
| Another status line shows in one project | That project's `.claude/settings.json` sets its own `statusLine`, and project settings beat `~/.claude/settings.json`. GSD's is replaced automatically by `install` and the daily check; for any other, run `ccinfobar install --project` there. |
| A widget I added is missing | Run `ccinfobar doctor`: it lists every widget with its value or the reason it is hidden (for example "Claude Code sent no rate_limits") and warns when a line is cut to fit the terminal. Save in the editor before checking. |
| `?` instead of arrows on macOS | Apple Terminal's default fonts have no powerline glyphs. Keep `charset: "auto"` or `"unicode"`, or install a Nerd Font and set `charset: "nerd"`. |
| Odd boxes instead of arrows or icons | Install a Nerd Font, or set `charset` to `unicode` or `text`. |
| GSD widgets show `—` | You are outside a GSD project, or `.planning/STATE.md` / `ROADMAP.md` doesn't exist yet. Set `hideEmpty` on them to hide the line elsewhere. |
| Context, cache or token widgets show `—` | Claude Code sends these only after Claude's first reply in the session. If your usage limit is at 100%, Claude cannot reply, so they stay empty; `ccinfobar doctor` tells you which case you are in. |
| `cost-today`, `cost-week`, `cost-project` or `activity-strip` show `—` | Nothing has been recorded yet. They count only from when one of them was added, and a session that was already running counts from that point on. `ccinfobar explain` shows the ledger age. |
| A widget disappears now and then | A `showWhen`/`hideWhen` rule or `overflow: "priority"` hid it. `ccinfobar explain` names the rule or says `dropped by priority`. |
| The tab's progress bar flickers | Claude Code draws its own bar too. Set `"terminalProgressBarEnabled": false` in `~/.claude/settings.json`; `ccinfobar doctor` checks it. |
| Emoji make the line misaligned in a JetBrains IDE | Set `"glyphMode": "jetbrains"` (or `auto`); `ccinfobar doctor` suggests it there. |
| `usage-projection`, `limit-eta` or `limit-risk` show nothing | They wait until 15 minutes into the 5-hour window (about 8 hours into the week), so an early burst does not look like a runaway. `limit-risk` only appears when a limit is projected to run out before it resets. |
| Usage limit widgets show `—` | Usage needs a Claude Pro or Max login. ccinfobar fills it from Claude when Claude Code sends none; run `ccinfobar usage` to see the reply or the error. |
| Preview in the editor doesn't match | Use **Last session** in the preview, after Claude Code has rendered the status line at least once. |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); adding a widget takes about 20 lines.

```sh
git clone https://github.com/alpadalar/ccinfobar.git && cd ccinfobar
npm install && npm run check && npm run build
```

## Acknowledgements

### Inspired by

- [ccstatusline](https://github.com/sirmalloc/ccstatusline) by Matthew Breedlove pioneered the configurable widget-based status line and inspired much of this project.
- [claude-powerline](https://github.com/Owloops/claude-powerline), [claude-hud](https://github.com/jarrodwatts/claude-hud) and [claude-pace](https://github.com/Astro-Han/claude-pace) inspired the themes, the web editor idea and pace tracking.
- [GSD](https://github.com/gsd-build/get-shit-done) defines the planning format the GSD widgets read.

<details>
<summary><b>Similar projects we learned from</b></summary>

ccinfobar's feature set grew out of a review of the most-starred Claude Code status line projects. These are the ones whose ideas we adopted, with thanks:

| Project | What we took |
| --- | --- |
| [jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud) | tool, agent and todo lines, i18n with CJK widths, layout importer |
| [sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline) | widget-based layouts, conditional hiding, service status, layout importer |
| [Owloops/claude-powerline](https://github.com/Owloops/claude-powerline) | powerline themes, incremental cost from the transcript, layout importer |
| [Astro-Han/claude-pace](https://github.com/Astro-Han/claude-pace) | usage pace against elapsed time |
| [Haleclipse/CCometixLine](https://github.com/Haleclipse/CCometixLine) | layout importer |
| [stephenleo/cship](https://github.com/stephenleo/cship) | `ccinfobar explain`, refreshing usage when a limit window resets, layout importer |
| [micschr0/claudebar](https://github.com/micschr0/claudebar) | control character stripping, highest usage across sessions, dry-run install with diff and backup, `doctor` |
| [Nanako0129/coralline](https://github.com/Nanako0129/coralline) | usage shared across sessions, burn-rate estimate |
| [stormzhang/token-tracker](https://github.com/stormzhang/token-tracker) | restoring the previous status line exactly on uninstall |
| [ilia-pluzhnikov/claude-code-statusline](https://github.com/ilia-pluzhnikov/claude-code-statusline) | plan-and-apply install, dropping widgets by priority on narrow terminals |
| [leeguooooo/claude-code-usage-bar](https://github.com/leeguooooo/claude-code-usage-bar) | end-of-window projection and risk label |
| [vfmatzkin/claude-statusline](https://github.com/vfmatzkin/claude-statusline) | pace arrows and budgets |
| [aiedwardyi/claude-usage-monitor](https://github.com/aiedwardyi/claude-usage-monitor) | trimming by terminal width |
| [fredrikaverpil/claudeline](https://github.com/fredrikaverpil/claudeline) | cache-miss detection from `prompt_cache`, provider detection, service status, keeping the last good value on errors |
| [loadbalance-sudachi-kun/claude-code-statusline](https://github.com/loadbalance-sudachi-kun/claude-code-statusline) | keeping the last good usage value on rate limits |
| [nilbuild/claude-statusline](https://github.com/nilbuild/claude-statusline) | credential lookup chain |
| [daniel3303/ClaudeCodeStatusLine](https://github.com/daniel3303/ClaudeCodeStatusLine) | credential lookup chain with a locked usage cache |
| [Wangnov/claude-code-statusline-pro](https://github.com/Wangnov/claude-code-statusline-pro) | provider profiles, HTTP/JSONPath widget |
| [byebye-code/byebyecode](https://github.com/byebye-code/byebyecode) | provider-specific usage |
| [martinemde/starship-claude](https://github.com/martinemde/starship-claude) | terminal progress bar (OSC 9;4) |
| [NYCU-Chung/cc-statusline](https://github.com/NYCU-Chung/cc-statusline) | cumulative cost, boxed dashboard, hook-based session tracking |
| [m1ckc3s/claude-status-bar](https://github.com/m1ckc3s/claude-status-bar) | waiting-for-permission state |
| [ai-younggle-man/claude-ultimate-hud](https://github.com/ai-younggle-man/claude-ultimate-hud) | CLAUDE.md, MCP and hook counts |
| [shanraisshan/claude-code-status-line](https://github.com/shanraisshan/claude-code-status-line) | loading state before the first response |
| [huangguang1999/ccstatusline-zh](https://github.com/huangguang1999/ccstatusline-zh) | translated interface |
| [sorosora/arcade-statusline](https://github.com/sorosora/arcade-statusline) | activity strip, JetBrains width compensation |
| [Autumn1337/better-statusline](https://github.com/Autumn1337/better-statusline) | Braille ring and dot-matrix gauges |
| [AwesomeZun/CC-statusline](https://github.com/AwesomeZun/CC-statusline) | Catppuccin gradients |
| [GaoSSR/best-claude-hud](https://github.com/GaoSSR/best-claude-hud) | official payload fields first, new widgets off by default |
| [tmck-code/yet-another-statusline](https://github.com/tmck-code/yet-another-statusline) | boxed multi-line layout, terminal width detection |

</details>

## License

[MIT](LICENSE)
