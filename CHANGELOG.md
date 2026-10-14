# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- In a terminal, `install` shows the current and new status line and asks `Replace? [y/N]` before replacing another tool's; `--yes` (`-y`) replaces without asking. Non-interactive runs replace it and print the replaced command (`Replaced: <command>`); use `--dry-run` to preview the plan without writing anything (no backup, no npm install)
- `install` prints `Installing ccinfobar <version>`
- `ccinfobar config get|set|unset <path> [value]` reads or changes one config value by dotted path (`lines.0.2.type`, `gitHardening`); values are parsed as JSON, else taken as a string, and a value that would not pass validation is refused without writing
- A config that does not parse shows `ccinfobar: config error at line N, run ccinfobar doctor` and is never overwritten
- An unexpected render error shows `ccinfobar: render error, run ccinfobar doctor` instead of a blank status line
- Context and token widgets show `loading…` before the first reply instead of `0%`; `loadingText` sets the text, an empty string turns it off, and the editor (Settings, Appearance) and TUI have a Loading text setting
- Plan-limit widgets show `loading…` until Claude Code sends usage limits, only in Claude subscription sessions
- `ccinfobar doctor` shows the line and column of a broken config and warns about unknown widgets and unsupported option values
- `ccinfobar doctor` lists the install manifest, where backups are kept and whether git hardening is off, warns on Windows about a backslash or quoted first token in the statusLine command, and removes stale temp files
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (when set and non-empty) stops the background update check and the background usage fetch; `ccinfobar update` and `ccinfobar usage` still work on demand, and `ccinfobar doctor` says when it is on
- `-y` as a short form of `--yes`, and `--` to end option parsing (for example `-- -1`)
- `ccinfobar explain [widget-id]` lists every widget with its current value, where it came from (payload field, cache and its age, git, GSD or another data source) and why it is empty, including which payload field Claude Code did not send and which Claude Code version adds it (`prompt_cache` 2.1.251+, `last_miss_cause` 2.1.260+); a widget id prints details for one widget
- `ccinfobar explain --json` prints one sanitized JSON object for bug reports, with `env` and `command` widget values replaced by `<redacted N chars>`; `--scenario <name>` or `--payload <file>` picks the input (not both), and a broken config, a bare `--payload` or a `--width` that is not a positive number makes it exit 1
- `ccinfobar doctor` also shows `env` and `command` widget values as `<redacted N chars>` in its widget list
- `explain` also redacts `env` and `command` values in its text output, and `explain <widget-id>` prints text options (such as a `command` string or a `link` URL) as `<N chars>`; `--show-values` shows them, only in a terminal and never in `--json`
- `ccinfobar preview --scenario <name>` renders nine named situations (fresh session, context nearly full, near 5h limit, near weekly limit, many subagents, GSD project, no git repo, API key user, over budget); a bare `--scenario` lists them
- The web editor's preview has a Scenario picker next to Sample data / Last session
- `ccinfobar bench` measures cold and warm render time (median, p95) against a `node -e 0` control (`--runs <n>`, where a missing or non-numeric value is an error, `--scenario <name>` for a scenario's payload and env, `--json`); the method and a baseline are in docs/DEVELOPMENT.md
- CI installs the packed package into an empty profile on Linux, macOS and Windows, renders through the exact settings command in every shell, and checks that uninstall restores the settings file byte for byte and leaves no process behind
- `usage-projection` widget: expected 5h or weekly usage at the end of the window, at the window's pace or the recent one
- `limit-eta` widget: time until a limit reaches 100% at the current pace, or `safe`
- `limit-risk` chip that turns amber or red when a limit is projected to run out before it resets
- `performance` widget with cache hit rate and average response time (`show`, `display: badge`, `hitWarn`, `timeWarn`, `showMisses`)
- `cost-today`, `cost-week` and `cost-project` widgets: estimated cost of all your sessions today, this week or per project, from a local ledger shared by all sessions; counting starts when one of them is added, and resume, fork, `/clear` and `/login` are not counted twice; totals end in `…` while the ledger is being rebuilt
- `budget.daily`, `budget.session` and `budget.warnAt` settings (config, editor, TUI)
- `budget` widget: estimated spend against your daily or session budget, yellow from `warnAt` (80%) and red when over
- `context-percentage` and `context-bar` `basis` option (`raw`, `usable`, `reserve`) with `reserveTokens`; it replaces the `usable` switch, which still works
- `cache-timer` `showTtl` option
- `ccinfobar explain` says whether a limits value came from this session, another session or the usage API, and when a window has just reset
- `ccinfobar explain` shows the cost ledger age and says when no cost has been recorded yet

### Changed

- Settings backups are timestamped under the config dir (`backups/settings-<UTC stamp>.json`, last 10 kept, plus a `settings-original.json` and the backup `uninstall` restores from, which are never deleted); no new `.ccinfobar-backup` file is created, but an existing one is still used on uninstall
- `uninstall` restores exactly what ccinfobar replaced, using `<configDir>/manifest.json`, and after several reinstalls brings back the status line you had before ccinfobar; other tools' status lines are never removed, even when they mention ccinfobar
- `uninstall` asks once before removing a status line that mentions ccinfobar but was not set by it; without a terminal it is left alone
- The editor and TUI show the current and new status line and ask before replacing another tool's; the editor's Install toast says where backups are kept
- The editor, doctor and the background GSD takeover decide whether the status line is ccinfobar's from the manifest instead of looking for "ccinfobar" in the command; each GSD takeover can be undone by uninstall
- The editor and TUI refuse to overwrite a broken config.json: `ccinfobar edit` shows a banner with the line, column and message, and `ccinfobar tui` prints it and exits 1
- `theme` refuses to run on a broken config and points to the error; `init --force` keeps a `.bak` copy of the previous config
- Rendering no longer writes config.json; the GSD line migration is applied in memory and saved by install, the editor or the TUI
- API-key, Bedrock, Vertex, Foundry, Mantle, Anthropic AWS and gateway (custom `ANTHROPIC_BASE_URL`) sessions no longer try the OAuth usage fetch; their plan-limit widgets stay empty unless Claude Code sends `rate_limits`
- Faster start-up: install, update, doctor, import, editor and TUI code load only when their command runs
- The stdin payload is sanitized before any widget sees it, and a non-object JSON payload is reported as invalid
- On macOS and Linux, a path with spaces or quotes is single-quoted in the statusLine command
- `ccinfobar import` config backups are created with mode 0600
- `ccinfobar preview` prints plain text when its output is not a terminal, unless `FORCE_COLOR` is set; `NO_COLOR` (or `FORCE_COLOR=0`) always gives plain text
- `ccinfobar doctor` builds its widget list from the same data as `explain` and points to it for details; it takes the width from the last session's cached terminal width and no longer runs `ps`/`stty` or writes a width cache file
- CI also tests on Node 26
- Plan limits are shared across sessions of the same account, so an idle session shows the newest 5h and weekly usage and an expired window never comes back; chart history in idle sessions follows the shared value. Logging in to another account drops the shared values, even after a logout in between; a token refresh does not
- `cache-miss-cause` shows the cause only while the latest request missed; set `show: always` for the old behaviour

### Fixed

- Install and uninstall keep the settings file's permissions (such as 0600), symlinks, BOM, CRLF line endings, indentation and trailing newline
- A settings file that does not parse is never overwritten, and a concurrent write by Claude Code is merged instead of lost
- Uninstall after Claude Code reformatted settings.json keeps your other edits and only restores the statusLine key; if Claude Code already removed the statusLine, uninstall restores the previous one and says so
- Editor and TUI installs are recorded in the manifest, so `ccinfobar uninstall` brings back the previous status line
- Windows: `install` writes `node "<path with forward slashes>/dist/ccinfobar.js"` instead of backslash or `.cmd` paths that Git Bash cannot run (which left the status line blank) and instead of the `ccinfobar` shim, which PowerShell blocks under the default Restricted execution policy
- Windows: `install` refuses a path containing `"`, `` ` ``, `$` or `%` and explains why, instead of writing a command the shell would expand; when `ccinfobar` is on PATH it writes the bare `ccinfobar` command instead
- Cache, update state, last payload, terminal width, theme, preset, styles and config files are written atomically (temp file and rename), so a cancelled render or crash cannot leave a half-written file
- Windows: renames briefly blocked by antivirus or indexers (EPERM/EACCES/EBUSY) are retried instead of failing
- A config.json saved with a UTF-8 BOM (common on Windows) loads instead of falling back to the default layout
- `cache-miss-cause` no longer blanks the status line when Claude Code sends the object form of `prompt_cache.last_miss_cause`; it shows, for example, `tools changed (+2/-0)`
- A widget that returns malformed output shows as empty instead of crashing the whole status line
- Emoji such as ⚡ and ✅ are measured as 2 cells
- Preview and doctor ignore a cached last payload that is not a JSON object
- Previewing the last session (`ccinfobar preview`, the editor and the TUI) no longer writes transcript or subagent cache files
- A `command` widget whose command does not read the payload on stdin (such as `echo` or `date`) no longer goes blank now and then when the command exits before the payload is written
- `--option=value` keeps values that contain `=`, such as `--command=FOO=1 ccinfobar`
- The editor's install preview no longer runs `npm install` before you confirm, and installing or updating from the editor runs npm in the background instead of freezing the editor
- The TUI install question no longer runs `npm install` before you confirm when started through npx
- An editor install confirmation must include the status line it was shown, so a stale or partial request cannot replace a different one
- `uninstall` no longer deletes a settings file that Claude Code changed after ccinfobar read it; it removes only the statusLine key instead
- If `manifest.json` cannot be written, `install` puts the settings file back as it was instead of leaving an unrecorded statusLine
- A link cut off by truncation is closed, so the rest of the terminal line no longer belongs to it
- `command` output with `preserveColors` that leaves a color on is reset at its end, so the color no longer bleeds into the next widgets
- A damaged `update.json` in the cache no longer replaces the whole status line with the render error line
- Windows: updates and the pinned-copy install no longer fail when npm is only available as `npm.cmd` and the config folder path contains spaces; npm's own `npm-cli.js` is used without a shell when it can be found
- Update checks order prerelease versions correctly, so `1.0.0-beta.1` counts as older than `1.0.0`
- `install --project` escapes `*`, `?`, `[` and `\` in the path it adds to `.git/info/exclude`, so it no longer hides other files, and works when the project is opened through a symlink
- The editor's install dialog shows the settings file it will write, including a `CLAUDE_CONFIG_DIR` location, instead of always `~/.claude/settings.json`
- Saving a symlinked `config.json` (for example from a dotfiles repo) writes through the link instead of replacing it with a plain file; the same holds for themes, presets and cache files
- `ccinfobar doctor` no longer merges the cached usage limits when the status line would not, so its widget list matches the status line
- The `usable` context percentage on 1M-token windows uses Claude Code's compaction threshold (about 967K) instead of 83.5% of the window
- Two Claude config dirs (`CLAUDE_CONFIG_DIR`) no longer share one usage cache, so their limits never mix
- `cache-timer` shows `off` instead of `cold` when Claude Code saw no caching

### Security

- Terminal escape sequences, 8-bit control characters and bidi overrides are stripped from payload, git, transcript, subagent and GSD text, so a hostile branch name, session name or planning file cannot write the clipboard, retitle the terminal or overwrite the status line
- The `command` widget with `preserveColors` keeps only colors and safe links; clipboard writes, title changes and other terminal sequences are removed
- PR links are only clickable for `http(s)` URLs without control characters, the `link` widget rejects `javascript:` and `data:` URLs, and environment variable values are shown as plain text
- Git calls, including the ones `install` makes, ignore repo-local `core.fsmonitor` and filter drivers (`gitHardening`, on by default)
- The last payload, usage cache, history and widget cache files are created with mode 0600
- Payload, git and cache object keys are sanitized like values, only the top-level `transcript_path` is left as is, and the U+2028/U+2029 line separators become spaces
- `install`, `update` and background updates run `npm install` with `--ignore-scripts`, so no package lifecycle script runs during an update
- `doctor`, `themes` and `usage` strip terminal escapes from statusLine commands, project settings, theme files, cached usage data and update errors, and cached usage limits are sanitized before widgets show them

## [0.6.2] - 2026-10-12

### Added

- Alignment: `align` places every line (or the panel box) left, center or right, and `lineAlign` overrides it per line; the editor has an Alignment setting and three buttons on each line
- Editor: the preview width is remembered in the browser; it only affects the preview
- Charts: `output-speed-graph` draws output tokens per second as a moving sparkline

### Fixed

- Panel style: an aligned line keeps its natural size instead of letting a fill widget take the row, and the editor marks lines drawn in the panel title instead of offering alignment for them
- Editor: the Glyphs section only shows for the powerline and capsule styles that draw them, and in the panel style the Separator field sets the gap between cells, which now takes the separator color
- Editor: the powerline separator and cap buttons draw their shapes instead of blank boxes when the browser has no Nerd Font, the preview draws the diagonal caps too, and theme glyphs show as `U+E0B0` in the placeholders
- Editor: changing a panel setting no longer warns that values were adjusted when only the order of the settings differed
- Panel style without breakpoints draws each widget as its own cell: merged widgets share one, rows with the same cell count line up, fill widgets take the free width, cells that do not fit wrap, and widgets used in a custom title or footer are not repeated
- The Dashboard preset is built from config lines instead of a fixed grid, so moving widgets in the editor changes the panel
- Background subagents (`run_in_background`) show as running until their task notification arrives instead of finishing at once; their tokens per minute leave out cache reads
- Panel style: a widget hidden with **Hide when no data** no longer shows up as `name —` when its cell name is also a widget type

### Changed

- Panel style: line layouts are as wide as their content by default, measured as if nothing filled its cell, and bars and graphs with Fill the cell stretch inside that width; the editor's Width setting picks Auto, Content or Full
- Editor: merged widgets look joined, with square corners on both sides of the join
- The preset gallery stacks cards in two columns at their own height instead of stretching them to match their neighbour
- The Dashboard preset stops at 140 columns like yet-another-statusline and hides the skills and effort when they are empty
- Automatic updates check each time Claude Code starts a new session instead of once a day; within a session the daily check stays

## [0.6.1] - 2026-10-12

### Added

- Editor: copy a widget's style and paste it onto others with the Copy/Paste buttons (`Ctrl+Alt+C` / `Ctrl+Alt+V`), the Paint brush (click widgets to apply, `Esc` to stop) or the right-click menu, which also pastes to a whole line and resets to the theme look. Pick what to carry over (colors, bold/dim/italic, bar and graph options, label switches) with the checkboxes or the Colors, Colors + text and All buttons
- Editor: saving keeps each widget's last three earlier styles in `styles.json` next to the config; the widget's Appearance section lists them to bring one back
- Agents & tasks widgets: `todo-list` shows Claude's task list (TodoWrite and Task tools), `agents` draws the current turn's subagents as an aligned table with their last tool, tokens per minute, share, tokens, time and model, and `agent-count` counts running and finished ones
- **Dashboard** preset: a boxed table with the session id at the top left, the model badge at the top right, a full-width context bar, a token rate graph, tasks and subagents
- Panel style: `tui.borderColor: "context"` colors the border by context fill; multi-line widgets make taller rows; bars and graphs with the new **Fill the cell** option stretch to their cell

### Changed

- Applying a theme while widgets have their own colors asks whether to switch them to the theme's colors; the theme gallery asks once and its previews show each theme without your widget colors
- Multi-line widgets in the text, block, powerline and capsule styles print their extra lines below the line
- The editor preview keeps symbols one column wide so tables and boxes line up in the browser

## [0.6.0] - 2026-10-12

### Added

- Charts: `token-rate-graph`, `context-graph`, `usage-graph` and `cost-graph` draw moving sparklines from a small per-session history that is only kept when a chart is on the status line
- Editor **Settings** (gear in the top bar): Claude Code install state and command, update mode with check and update buttons, usage API and last-payload toggles; they left the Global tab, which now only covers looks

### Fixed

- The editor page no longer breaks when the bundled script contains `$'` or similar sequences (the build used them as replacement patterns)

### Changed

- `autoWrap` is on by default, so long lines move widgets to a new line instead of cutting them with `…`; saved configs keep their setting

## [0.5.6] - 2026-10-12

### Security

- The status line command is never `npx -y ccinfobar@latest` any more, which would download and run whatever npm serves on every refresh. When a global install is not possible (or with `--no-global`), `install` puts a pinned copy in `~/.config/ccinfobar/app` and points Claude Code at it; that copy updates itself like a global install

## [0.5.5] - 2026-10-12

### Changed

- Editor: the presets gallery shows two columns and renders each preview to fit its card

## [0.5.4] - 2026-10-12

### Changed

- Editor inspector: label, toggles and options come first and colors last in the Widget tab; rendering settings and Claude Code come first and theme, style and glyphs last in the Global tab

## [0.5.3] - 2026-10-12

### Changed

- `npx ccinfobar@latest install` installs the `ccinfobar` command globally and uses it for the status line, so `ccinfobar edit` works and the status line starts fast; it falls back to `npx -y ccinfobar@latest` when the global install fails, and `--no-global` skips it
- Editor: while a widget from a line is dragged, the whole widget palette on the left becomes a drop-to-remove area

### Fixed

- `install` run through npx no longer writes npx's temporary cache path as the status line command
- Git widgets no longer come up empty on slow Windows machines: git calls get 1.5 s there (`CCINFOBAR_GIT_TIMEOUT` to change)

## [0.5.2] - 2026-10-12

### Fixed

- Editor: a widget dragged from the palette and dropped outside a line no longer leaves its drag ghost on screen in Chrome and Edge on macOS

### Changed

- Updates install `ccinfobar@<version>` from npm and fall back to the GitHub release; installs made from a GitHub tarball move to the npm package on their next update
- With npx, the update notice is skipped and command hints read `npx ccinfobar@latest …`
- Editor: once installed, the top bar shows a plain "Active in Claude Code" status instead of a button; the command and refresh settings moved to a Claude Code section in the Global tab, and saving says when Claude Code will show the change

## [0.5.1] - 2026-10-12

### Added

- Published to npm: `npx ccinfobar@latest install` sets the status line to `npx -y ccinfobar@latest`; `npm install -g ccinfobar` still gives the faster global command

### Changed

- Releases publish to npm through trusted publishing instead of a stored token

## [0.5.0] - 2026-10-12

### Added

- Theme builder in the editor (**New theme**): start from any theme, pick a style, color mode and text and background colors per category or in a cycle, with a live preview; your themes get an edit button in the gallery
- **Colors from** in the Global tab keeps your style and takes another theme's colors; text-style palettes become readable blocks in block styles
- Presets gallery with live previews replaces the preset dropdown; **Save current as preset** stores your own presets in `presets/`, and `ccinfobar init <id>` applies them
- `weekly-model-usage` and `weekly-model-reset` widgets show per-model weekly limits such as Fable, from Claude's usage API

### Changed

- GSD is detected: without it, the default layout, presets and the editor leave GSD out; once GSD is installed the default GSD line is added as the second line of your layout, once
- GSD widgets are a plain category in the editor and the TUI, no longer pinned on top
- Editor palette categories start collapsed; the preview starts at 130 columns
- `weekly-sonnet-usage` and `weekly-opus-usage` are hidden from the palettes, since current plans have no such limits; existing configs keep working

### Fixed

- The usage API no longer reports a 0% Sonnet or Opus limit when the plan has none

## [0.4.0] - 2026-10-12

### Added

- Usage limits from Claude: when Claude Code sends no `rate_limits`, a background request with your Claude login fills the 5-hour, weekly and extra usage widgets (`usageApi`, on by default); `ccinfobar usage` fetches it now and `doctor` shows where the numbers come from
- `install` switches projects that use GSD's own status line to ccinfobar through `.claude/settings.local.json`; the daily background check catches new ones and `uninstall` gives them back

### Fixed

- The config schema lists every `charset` value and the `update` setting

## [0.3.4] - 2026-10-12

### Fixed

- Running `install` again keeps the existing `refreshInterval`; `install --project` copies it from the user setting
- Custom labels get a space before the value when they don't end with one

## [0.3.3] - 2026-10-12

### Added

- `ccinfobar install --project` sets ccinfobar in `.claude/settings.local.json` so it wins over a project's own status line, such as a local GSD install; `uninstall --project` undoes it
- `install` and `doctor` warn when the current project overrides the status line

### Changed

- `widthOffset` defaults to `10`

## [0.3.2] - 2026-10-12

### Fixed

- Block, powerline and capsule themes fall back to the theme text color when a widget's own color would be unreadable on its block

## [0.3.1] - 2026-10-12

### Fixed

- Updates validate the release version before using it and no longer run npm through a shell on Windows
- Git counters show `0`, `+0 -0` and `↑0 ↓0` inside a repository instead of `—`; `hideZero` hides them again


## [0.3.0] - 2026-10-12

### Added

- Automatic updates: a daily background check against GitHub releases; `update: "auto"` (default) installs new releases, `"notify"` shows a note, `"off"` disables; `ccinfobar update` updates now
- Widgets without data now show their label and `—` instead of disappearing; new per-widget `hideEmpty` option (Hide when no data) in both editors
- `doctor` explains empty sessions and full usage limits
- Context widgets show `0%` before Claude's first reply

### Fixed

- Palette cards were cut off on Windows, where scrollbars take up space
- The TUI labelled `merge` as "Merge with previous"; it joins with the next widget


## [0.2.0] - 2026-10-12

### Added

- `ccinfobar install` detects ccstatusline and claude-powerline and offers to import their layout; `ccinfobar import <tool>` does it on demand
- `cockpit` preset: a five-line developer dashboard
- `charset` is now `auto`, `nerd`, `unicode` or `text`; `auto` avoids Nerd Font glyphs in Apple Terminal
- `ccinfobar doctor` reports every widget with its value or why it is hidden, and lines cut by the terminal width
- Panel (`tui`) style with box presets, title and footer templates and a responsive grid (`areas`, `columns`, `align`, spans, breakpoints, culling)
- `dark`, `light` and `rose-pine` themes ported from claude-powerline, plus a `panel` theme
- 13 bar styles and an even-pace marker for usage bars (`showPace`)
- `autoWrap` and the `skills` widget

### Fixed

- Powerline arrows showed as `?` in Apple Terminal
- Context widgets disappeared when Claude Code sent no `context_window`; they now fall back to the transcript
- GSD: phase numbers across milestones, shipped milestone ranges, bare `Phase: N` lines, stale phase counts, resolved blockers, "awaiting next milestone"
- Git worktree name outside Claude Code worktrees; no fake owner/repo for local remotes
- `uninstall` restores the previous status line


## [0.1.0] - 2026-10-12

### Added

- Status line renderer with unlimited lines, separators, merge, flex spacing and truncation
- Theme system with 19 built-in themes in four styles (text, blocks, powerline, capsule), per-config overrides and user themes in the `themes` folder with `extends`
- `themes` and `theme` commands, plus theme galleries in both editors
- Terminal color profiles for the editor preview (16 presets plus custom colors), with automatic detection of the launching terminal's colors via OSC 10/11/4
- Drag-and-drop web editor (`ccinfobar edit`) with live preview from sample or real session data
- Keyboard and mouse terminal editor (`ccinfobar tui`)
- GSD widgets: milestone, milestone progress, phase, status, plans, plan progress, next step, workstream, blockers, todos, requirements, last command, update notice, current task, summary
- Session, context, token, cache, cost, usage limit, git, workspace, system and custom widgets
- `install`, `uninstall`, `init`, `preview`, `widgets` and `doctor` commands
- Presets: default, minimal, gsd, powerline, full
- JSON schema for the config file

[Unreleased]: https://github.com/alpadalar/ccinfobar/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/alpadalar/ccinfobar/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/alpadalar/ccinfobar/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/alpadalar/ccinfobar/compare/v0.5.6...v0.6.0
[0.5.6]: https://github.com/alpadalar/ccinfobar/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/alpadalar/ccinfobar/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/alpadalar/ccinfobar/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/alpadalar/ccinfobar/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/alpadalar/ccinfobar/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/alpadalar/ccinfobar/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/alpadalar/ccinfobar/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/alpadalar/ccinfobar/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/alpadalar/ccinfobar/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/alpadalar/ccinfobar/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/alpadalar/ccinfobar/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/alpadalar/ccinfobar/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/alpadalar/ccinfobar/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/alpadalar/ccinfobar/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alpadalar/ccinfobar/releases/tag/v0.1.0
