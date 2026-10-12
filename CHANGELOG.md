# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/alpadalar/ccinfobar/compare/v0.6.1...HEAD
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
