# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/alpadalar/ccinfobar/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/alpadalar/ccinfobar/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/alpadalar/ccinfobar/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/alpadalar/ccinfobar/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alpadalar/ccinfobar/releases/tag/v0.1.0
