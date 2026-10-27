# Importers

`ccinfobar import <tool>` reads another status line's config and turns it into a ccinfobar config. `ccinfobar install` offers the same import when it recognises your current status line. `ccinfobar import --help` lists every tool with its id, aliases, project and the file it reads.

```
ccinfobar import <tool> [--file <path>] [--command <cmd>] [--force] [--dry-run] [--allow-commands]
```

- Without `--file`, each importer reads the file the tool itself would read. Paths below use `~` for your home folder (`%USERPROFILE%` on Windows) and are the same on every OS unless a section says otherwise.
- `--command` passes the status line command to read flags from. Without it, the `statusLine` command in your Claude settings is used. Flags are read only after the tool's own program in that command (also inside a quoted `sh -c "…"` script); another tool's command, ccinfobar's own included, is ignored with a note, and the tool's default files are used.
- `--dry-run` prints the report and a preview with sample data, and writes nothing.
- `--force` replaces an existing ccinfobar config. The old one is backed up first.
- Every import prints a report: what was imported, what was approximated and what was dropped, with the reason.
- Commands, HTTP widgets and links in an imported layout are listed first. On a terminal you are asked whether to keep them (default No). `--allow-commands` keeps them. `--yes` or a non-interactive run drops them.
- Importers only read files. They never run, source or execute anything from a config. API keys, tokens, auth headers and similar secrets are never copied into the ccinfobar config.
- Imported labels and text are cleaned of terminal escape sequences.

## Reviewed projects

ccinfobar's importers come from a review of 41 Claude Code status line projects. Each one is listed here with its config, the verdict and why. "Effort" is the size of the importer: low (under about 100 lines), medium (100 to 250 lines), n/a when there is nothing to import, high when a config exists but importing it would take a lot of work.

| # | Project | Config format and default path | Verdict | Effort | `ccinfobar import` or reason |
| --- | --- | --- | --- | --- | --- |
| 1 | [jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud) | JSON, `<Claude config folder>/plugins/claude-hud/config.json` + `claude-hud.json` | supported | existing | `ccinfobar import claude-hud` |
| 2 | [sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline) | JSON, `~/.config/ccstatusline/settings.json` | supported | existing | `ccinfobar import ccstatusline` |
| 3 | [Haleclipse/CCometixLine](https://github.com/Haleclipse/CCometixLine) | TOML, `~/.claude/ccline/config.toml`, themes in `~/.claude/ccline/themes/` | supported | existing | `ccinfobar import ccometixline` (alias `ccline`) |
| 4 | [nilbuild/claude-statusline](https://github.com/nilbuild/claude-statusline) | none, the script is edited | not importable | n/a | No config file; the layout is fixed in the script |
| 5 | [Owloops/claude-powerline](https://github.com/Owloops/claude-powerline) | JSON, `./.claude-powerline.json`, `~/.claude/claude-powerline.json`, `~/.config/claude-powerline/config.json` | supported | existing | `ccinfobar import claude-powerline` |
| 6 | [GaoSSR/best-claude-hud](https://github.com/GaoSSR/best-claude-hud) | TOML, `~/.claude/best-claude-hud/config.toml` (CCometixLine format) | alias | low | `ccinfobar import best-claude-hud` |
| 7 | [huangguang1999/ccstatusline-zh](https://github.com/huangguang1999/ccstatusline-zh) | JSON, the same file as ccstatusline | alias | low | `ccinfobar import ccstatusline-zh` (alias of `ccstatusline`) |
| 8 | [m1ckc3s/claude-status-bar](https://github.com/m1ckc3s/claude-status-bar) | none (macOS menu bar app and hook) | not importable | n/a | Not a status line: it lives in the macOS menu bar |
| 9 | [chongdashu/cc-statusline](https://github.com/chongdashu/cc-statusline) | generated script `~/.claude/statusline.sh` with a `# Theme: … \| Features: …` header | supported | medium | `ccinfobar import cc-statusline` |
| 10 | [daniel3303/ClaudeCodeStatusLine](https://github.com/daniel3303/ClaudeCodeStatusLine) | none (one update-check env var) | not importable | n/a | No layout config; install recognises it by name or by its script |
| 11 | [Nanako0129/coralline](https://github.com/Nanako0129/coralline) | shell assignments, `~/.claude/coralline.conf` (`$CORALLINE_CONFIG`) | supported | medium | `ccinfobar import coralline` |
| 12 | [stormzhang/token-tracker](https://github.com/stormzhang/token-tracker) | JSON, `~/.config/token-tracker/config.json` (theme only) | supported | low | `ccinfobar import token-tracker` |
| 13 | [rz1989s/claude-code-statusline](https://github.com/rz1989s/claude-code-statusline) | TOML, `~/.claude/statusline/Config.toml` | supported | medium | `ccinfobar import claude-code-statusline` (alias `rz1989s`) |
| 14 | [stephenleo/cship](https://github.com/stephenleo/cship) | TOML, `cship.toml` or `starship.toml` | supported | existing | `ccinfobar import cship` |
| 15 | [leeguooooo/claude-code-usage-bar](https://github.com/leeguooooo/claude-code-usage-bar) | JSON, `~/.claude/claude-statusbar.json` | supported | medium | `ccinfobar import claude-statusbar` |
| 16 | [NYCU-Chung/cc-statusline](https://github.com/NYCU-Chung/cc-statusline) | JSON, `~/.claude/cc-statusline-rows.json` | supported | medium | `ccinfobar import nycu-cc-statusline` |
| 17 | [tmck-code/yet-another-statusline](https://github.com/tmck-code/yet-another-statusline) | TOML, `~/.claude/yas.toml` | not importable | high | The config has width, theme, glyphs and budgets but no layout; the box layout is built in code |
| 18 | [Wangnov/claude-code-statusline-pro](https://github.com/Wangnov/claude-code-statusline-pro) | TOML, `~/.claude/statusline-pro/config.toml` | supported | medium | `ccinfobar import statusline-pro` (aliases `ccsp`, `claude-code-statusline-pro`) |
| 19 | [Astro-Han/claude-pace](https://github.com/Astro-Han/claude-pace) | none | not importable | n/a | No config file |
| 20 | [Autumn1337/better-statusline](https://github.com/Autumn1337/better-statusline) | plugin settings (icons, motion) | not importable | n/a | Not a stdin status line (an early-access plugin UI) and no layout config |
| 21 | [kcchien/claude-code-statusline](https://github.com/kcchien/claude-code-statusline) | env vars for the glyph tier | not importable | n/a | The env vars only pick ASCII, Nerd Font or powerline glyphs; the layout is fixed |
| 22 | [AwesomeZun/CC-statusline](https://github.com/AwesomeZun/CC-statusline) | none, a preset script is copied | not importable | n/a | No config; the preset is the script file that was copied |
| 23 | [martinemde/starship-claude](https://github.com/martinemde/starship-claude) | Starship TOML, `~/.claude/starship.toml` (`--config`) | supported | medium | `ccinfobar import starship-claude` |
| 24 | [ilia-pluzhnikov/claude-code-statusline](https://github.com/ilia-pluzhnikov/claude-code-statusline) | none | not importable | n/a | No config file |
| 25 | [danielmackay/claude-code-statusline](https://github.com/danielmackay/claude-code-statusline) | none (a short example script) | not importable | n/a | No config file |
| 26 | [rithkott/claude-thing](https://github.com/rithkott/claude-thing) | env vars | not importable | n/a | Not a status line: a HUD for the Spotify Car Thing |
| 27 | [byebye-code/byebyecode](https://github.com/byebye-code/byebyecode) | TOML, `~/.claude/byebyecode/config.toml` (CCometixLine format) | alias | low | `ccinfobar import byebyecode` |
| 28 | [wolfdenpublishing/pyccsl](https://github.com/wolfdenpublishing/pyccsl) | status line command flags and an optional `--env` file | supported | medium | `ccinfobar import pyccsl` |
| 29 | [sorosora/arcade-statusline](https://github.com/sorosora/arcade-statusline) | command flags `--theme`, `--width` | not importable | n/a | Game-style renderings with no widget overlap; install recognises it by name |
| 30 | [ersinkoc/claude-statusline](https://github.com/ersinkoc/claude-statusline) | JSON, `~/.claude/data-statusline/config.json` | not importable | high | Generated themes, layouts from code templates and data from its own daemon; the toggles barely overlap |
| 31 | [xleddyl/claude-watch](https://github.com/xleddyl/claude-watch) | none | not importable | n/a | No config file |
| 32 | [shanraisshan/claude-code-status-line](https://github.com/shanraisshan/claude-code-status-line) | none | not importable | n/a | No config file |
| 33 | [terryso/ccpet](https://github.com/terryso/ccpet) | JSON, `~/.claude-pet/config.json` | supported | medium | `ccinfobar import ccpet` |
| 34 | [aiedwardyi/claude-usage-monitor](https://github.com/aiedwardyi/claude-usage-monitor) | `CQB_*` keys in the `env` block of `~/.claude/settings.json` | supported | low | `ccinfobar import claude-usage-monitor` |
| 35 | [loadbalance-sudachi-kun/claude-code-statusline](https://github.com/loadbalance-sudachi-kun/claude-code-statusline) | none (constants in the script) | not importable | n/a | No config file |
| 36 | [vfmatzkin/claude-statusline](https://github.com/vfmatzkin/claude-statusline) | `~/.claude/usage/.config` (budget only) | not importable | n/a | The config holds budget numbers only, no layout |
| 37 | [fredrikaverpil/claudeline](https://github.com/fredrikaverpil/claudeline) | status line command flags | supported | low | `ccinfobar import claudeline` |
| 38 | [anhannin/codex-hud](https://github.com/anhannin/codex-hud) | JSON, `~/.codex-hud/config.json` | not importable | n/a | For Codex, not Claude Code |
| 39 | [glauberlima/claude-code-statusline](https://github.com/glauberlima/claude-code-statusline) | TOML, `statusline.toml` next to the binary (`~/.claude/statusline.toml`) | supported | low | `ccinfobar import glauberlima-statusline` (alias `glauberlima`) |
| 40 | [ai-younggle-man/claude-ultimate-hud](https://github.com/ai-younggle-man/claude-ultimate-hud) | JSON, `~/.claude/claude-ultimate-hud.local.json` | supported | low | `ccinfobar import claude-ultimate-hud` |
| 41 | [micschr0/claudebar](https://github.com/micschr0/claudebar) | TOML, `~/.config/claudebar/config.toml` (`$XDG_CONFIG_HOME`, `--config`) | supported | medium | `ccinfobar import claudebar` |

Totals: 5 supported before this review, 3 aliases, 15 new importers, 18 not importable.

## Install detection

`ccinfobar install` looks at your current `statusLine` command, in this order:

1. The importers added in this review, by their documented commands and install paths (so `best-claude-hud` and `claude-ultimate-hud` are never read as claude-hud).
2. ccstatusline (and ccstatusline-zh), claude-powerline, CCometixLine, cship and claude-hud.
3. Reviewed tools with nothing to import, by name: arcade-statusline, awesome-statusline (AwesomeZun/CC-statusline), yet-another-statusline and ClaudeCodeStatusLine (its PowerShell form; its `statusline.sh` is found in step 5). Install says it found them and imports nothing.
4. ccusage and the GSD status line.
5. For any other command, the start of the `statusline.sh` it names is read (never run): the cc-statusline header in the first 512 bytes, the `~/.claude/statusline/Config.toml` path of claude-code-statusline (rz1989s) in the first 8 KiB, or the `# Source:` line of ClaudeCodeStatusLine. Both rz1989s and ClaudeCodeStatusLine install `~/.claude/statusline/statusline.sh`, so that path alone is not enough; a script that matches none of them is a custom status line.

Some tools install with a command that does not name them, for example `node ${CLAUDE_PLUGIN_ROOT}/statusline.js` (NYCU-Chung/cc-statusline) or a binary called `statusline` outside `~/.claude` (glauberlima). Install then offers no import, but `ccinfobar import <id>` still works.

## Supported tools

### ccstatusline

`ccinfobar import ccstatusline`, also `ccinfobar import ccstatusline-zh` (same file and format).

- File: `--config` in the status line command, else `$XDG_CONFIG_HOME/ccstatusline/settings.json`, else `~/.config/ccstatusline/settings.json`.
- Maps: lines, widgets, colors, labels (custom text), separators, merge, raw values, powerline mode and caps, the `full-minus-40` width. Claude status, spend limit amount, staged/unstaged/untracked file counts and the worktree branch map one to one. The Jujutsu widgets map to the `jj-*` widgets (`jj-insertions` and `jj-deletions` fold into `jj-changes`, `jj-root-dir` into `project-dir`), `git-is-fork` keeps its symbol, the origin owner/repo widget keeps its owner-only-when-fork flag (`ownerOnlyWhenFork`), and the `no-jj` and `not-fork` hide states become `hideEmpty`.
- Dropped: widgets with no close equivalent, such as the spend limit percentage, the `upstream` remote owner and repo and the origin owner.
- Custom commands are listed for consent, like command, HTTP, link and env widgets in any imported layout.

### claude-powerline

`ccinfobar import claude-powerline`

- File: `--config` in the command, else `$CLAUDE_POWERLINE_CONFIG`, else the first of `./.claude-powerline.json`, `<Claude config folder>/claude-powerline.json` and `~/.config/claude-powerline/config.json`.
- Maps: lines, segments, theme, style (`minimal`, `powerline`, `capsule`, `tui`), charset, auto wrap, width reserve, custom colors, and `--theme`/`--style` flags in the command.

### CCometixLine

`ccinfobar import ccometixline` (alias `ccline`)

- File: `~/.claude/ccline/config.toml`, else its default layout. A `-t`/`--theme` flag in the command imports that theme instead, from `~/.claude/ccline/themes/` or the nine built-in themes.
- Maps: segments, icons for the style mode as labels, text and background colors, bold, the separator, and the powerline arrow separator as the powerline style.
- Dropped: usage API options and the `update` segment.

### cship

`ccinfobar import cship`

- File: `--config` in the command, else the nearest `cship.toml` or `starship.toml` above the current folder (up to your home folder when it is inside it), else `~/.config/cship.toml` or `~/.config/starship.toml`.
- Maps: `lines` or `format`, `$cship.*` modules, the Starship git, directory, host, user, time and memory modules, `$fill`, literal text, `[text](style)` spans, symbols as labels and Starship styles. Thresholds become threshold colors where the widget has them.
- Dropped: other Starship modules and `$cship.account`. No `starship module` command is created.

### claude-hud

`ccinfobar import claude-hud`

- File: `plugins/claude-hud/config.json` in your Claude config folder, with `claude-hud.json` merged over it, on top of claude-hud's defaults.
- Maps: the expanded layout (one line per element in `elementOrder`, merged groups on one line) or the compact one (a session line plus activity lines), the project line order, the custom line, path levels, colors, the separator line, and `--extra-cmd` from the command as a command widget (listed for consent).
- Approximated or dropped: thresholds, the advisor, added folders, external usage files and the language.

### best-claude-hud

`ccinfobar import best-claude-hud`

- File: `~/.claude/best-claude-hud/config.toml`, themes in `~/.claude/best-claude-hud/themes/`, `-t`/`--theme` in the command. Without a file, its default layout.
- Same format as CCometixLine, so the same mapping applies. It is not related to claude-hud.

### byebyecode

`ccinfobar import byebyecode`

- File: `~/.claude/byebyecode/config.toml`, themes in `~/.claude/byebyecode/themes/`, `-t`/`--theme` in the command.
- Same mapping as CCometixLine. `style.line_break_after` becomes a second line (approximated: byebyecode counts only segments that show something).
- Dropped: the three 88code segments. Their options, which hold an API key, are never read.

### claudebar

`ccinfobar import claudebar`

- File: `--config` in the command, else `$XDG_CONFIG_HOME/claudebar/config.toml`, else `~/.config/claudebar/config.toml` (on Windows too, as claudebar reads `HOME`). Without a file, claudebar's default layout.
- Command flags: `--theme`, `--style` and `--segments` override the file, as in claudebar.
- Maps: segments in order (directory, git, model with effort, context bar and tokens, rate limits with resets, cost, lines, duration, burn, clock), bar width, cost decimals, the 12-hour clock and the auto layout as line wrapping.
- Themes: tokyo-night, catppuccin, everforest-dark, gruvbox, kanagawa-wave, nord, one-dark, dracula, rose-pine and solarized-dark map to built-in themes; the other six are approximated by `dark`.
- Styles: all eight become the text style with claudebar's separator, bar style and icons (claudebar never fills backgrounds).
- Approximated: `clock_mode = "auto"`, `weekly_show_at`, custom `warn`/`crit` thresholds. Dropped: `float` output, `dev-context`, `update-notice`, `burn_lookback`, `limit_sync`, `max_lines`, `wrap_margin`.

### claude-code-statusline-pro

`ccinfobar import statusline-pro` (aliases `ccsp`, `claude-code-statusline-pro`)

- File: `-c`/`--config` in the command, else `~/.claude/statusline-pro/config.toml`. Without a file, ccsp's defaults. Project layers under `~/.claude/projects/` are not read (pass one with `--file`).
- Command flags: `--preset`/`-p` or a positional preset, `--theme`/`-t`, `--force-text`, `--force-nerd-font`, `--force-emoji`, `--no-colors`, `--no-emoji`, `--no-icons`.
- Maps: the preset letters (with `preset_mapping`) or `components.order`, each component's options (project, model, branch with dirty/ahead-behind/stash, tokens bar and counts, cost and lines, 5h and 7d limits with resets), Nerd Font, emoji or text icons, text colors and `enable_colors`. Themes: classic as the text style with its separators, powerline and capsule as those styles.
- Approximated: the status component, model name mappings, token thresholds and context windows, icon colors.
- Dropped: `[multiline]` and `[widgets.*]`. Their URLs and HTTP headers are never read or copied.

### claude-code-statusline (rz1989s)

`ccinfobar import claude-code-statusline` (alias `rz1989s`)

- File: `~/.claude/statusline/Config.toml`.
- Install: `~/.claude/statusline/statusline.sh` is offered for import only when the script itself names `~/.claude/statusline/Config.toml`, since daniel3303/ClaudeCodeStatusLine installs the same path.
- Maps: `display.lines` and each `display.lineN.components` as one line: repo and git, model, version, time, the cost components, burn rate, cache efficiency, code productivity, context, usage limits and resets, session info and mode, tokens, vim mode, agent and MCP status. Themes: classic and catppuccin exact; garden, ocean and custom approximated.
- Approximated: per-line separators (the most common one is used), weekly and monthly cost periods, block projection, Bedrock model, GitHub and MCP components.
- Dropped: commits, submodules, context alerts, block token usage, prayer times, the Hijri calendar, location, wellness and plugin components. Other sections are named with a key count; plugin API keys are never copied.

### starship-claude

`ccinfobar import starship-claude`

- File: `--config` in the command, else `~/.claude/starship.toml`.
- Maps: the format through the same Starship reader as cship, with `palette` colors, `${…}` braces, the Starship directory and git modules with their styles, and `${env_var.CLAUDE_*}` modules (model, context, tokens, cost, 5h and 7d limits and resets, version, output style, session, lines, durations, folders). A template with powerline arrows becomes the powerline style.
- Approximated: rate limit reset strings, the session summary, lines, current and cache tokens, powerline glyph spans (the powerline style draws its own).
- Dropped: unknown `CLAUDE_*` variables, other Starship modules.

### pyccsl

`ccinfobar import pyccsl`

- Read from the status line command: the field list after `pyccsl.py`, `--theme`, `--style`, `--numbers`, `--no-emoji`, badge thresholds, and the `--env` file (or `--file`). `PYCCSL_*` keys in the env file win over the flags, as in pyccsl.
- The env file is read the way pyccsl reads it: each line splits on its first `=`, one pair of surrounding quotes comes off, and the value is taken as written (so `export NAME=…` is ignored, a value may contain spaces, and a trailing `# comment` stays part of the value). Lines without `=` are skipped and named by line number; nothing is run or expanded. Only `PYCCSL_*` keys are used, and the process environment is never read.
- Maps: fields in pyccsl's own order (badge, folder, git, model, performance metrics, input, output, tokens, cost), the nine themes and the five separator styles.
- Approximated: the 4-dot badge (the performance widget), thresholds, number formats other than compact.

### coralline

`ccinfobar import coralline`

- File: `$CORALLINE_CONFIG`, else `~/.claude/coralline.conf`. Without a file, coralline's defaults.
- The file is read as plain assignments. It is never sourced or run. The theme is the last `. …/coralline/themes/<name>.conf` include, else the last include; other includes are listed as skipped lines.
- Maps: `VL_SEGMENTS`, `VL_SEGMENTS2` and `VL_SEGMENTS3` as lines (or auto wrapping), the pill, lean and classic styles, the clock, bar width, cost decimals, ASCII mode, the theme and `VL_BG_*` colors.
- Themes: catppuccin-mocha, gruvbox-dark, tokyo-night, nord, dracula and mono map to built-in themes. For coralline-only themes the colors come from `~/.claude/coralline/themes/<name>.conf` (`$CLAUDE_CONFIG_DIR/coralline/themes/` when set), read the same way and only when the name is a safe theme name.
- Approximated: the context gauge, time to first token, the classic style, warn and hot thresholds. Dropped: node and python segments, float output, subagent and burn tuning keys.

### claude-statusbar

`ccinfobar import claude-statusbar`

- File: `~/.claude/claude-statusbar.json`. Without a file, its defaults.
- Maps: the usage, model and context line, the per-model line, the project and branch line, the mode line, the activity line and the agents line, rebuilt from the `show_*` toggles. Styles classic, capsule and hairline. Themes nord, dracula, mono, catppuccin-mocha and tokyo-night exact; graphite, twilight, linen and sakura approximated.
- Not imported: `CLAUDE_STATUSBAR_*` env vars and `--style`/`--theme` flags (named in a note), relay balance, IP and fingerprint risk, self-update and color overrides. Their values are never copied.

### NYCU-Chung/cc-statusline

`ccinfobar import nycu-cc-statusline`

- File: `~/.claude/cc-statusline-rows.json`. Without a file, its defaults.
- Maps: the boxed dashboard as a `tui` panel, one line per enabled row: summary, directory, repo, model and duration, cost, tokens and context, 5h and 7d quota, agents, memory and MCP. `statuslineWidth` and `statuslineWidthOffset` become the width settings.
- Approximated: summary, duration, cost and memory rows. Dropped: the edited and history rows.
- The plugin command `node ${CLAUDE_PLUGIN_ROOT}/statusline.js` does not name the tool, so install does not offer this import; run it by hand.

### claude-ultimate-hud

`ccinfobar import claude-ultimate-hud`

- File: `~/.claude/claude-ultimate-hud.local.json`. Without a file, its defaults.
- Maps: the session, stats, project, tools, agents and todos lines from the `display.show*` toggles. `plan` picks the 5h, 7d and Sonnet limits, or the session cost for enterprise. The token breakdown shows from 85% context.
- Approximated: the token breakdown, the context warning line. Not imported: the language and the usage cache TTL.

### ccpet

`ccinfobar import ccpet`

- File: `~/.claude-pet/config.json`. Without a file, its defaults.
- Maps: the pet items on line 1 as the `pet` widget (approximated), the token, context and cost items on lines 2 and 3, `#RRGGBB[:bright][:bold]` colors as the widget color and bold.
- Dropped: accumulated and lifetime tokens. The `supabase` block, which holds a service key, is never read or copied.

### cc-statusline (chongdashu)

`ccinfobar import cc-statusline`

- File: the `statusline.sh` named in the status line command, else `~/.claude/statusline.sh`, else `./.claude/statusline.sh`.
- Only the generated header (`# Theme: … | Colors: … | Features: …`) is read. The script is never run, and later edits to it are not imported.
- Maps: the picked features onto the same three lines: directory, git, model, version and output style; context and session reset; cost, burn rate and tokens.
- Approximated: the context bar (cc-statusline fills it by the remaining share), the session reset, the burn rate, the minimal and compact themes.
- Install finds it by the "Generated by cc-statusline" header even though the command is generic.

### claudeline

`ccinfobar import claudeline`

- Read from the status line command (or `--command "<cmd>"`): `-cwd`, `-git-branch`, `-cost`, `-effort`. claudeline has no config file, so `--file` is ignored with a note.
- Maps: claudeline's fixed order: provider and model, context bar, 5-hour and 7-day bars with resets, cost, spend limit and service status.
- Approximated: `-cwd-max-len`, `-git-branch-max-len`, the login type before the model. Dropped: the update notice.

### claude-usage-monitor

`ccinfobar import claude-usage-monitor`

- File: `settings.json` in your Claude config folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), or `--file`.
- Only the `CQB_*` keys of its `env` block are read. Other settings, API keys and shell variables are never read or copied. `CQB_EMAIL` is dropped for privacy.
- Maps: the toggles onto its two fixed lines (model, project and branch; context, tokens, 5h and 7d usage with pace and resets, cost and duration). `CQB_MAX_WIDTH` becomes `maxWidth`.
- Approximated: pace (claude-usage-monitor hides it within ±10%) and the remaining-share context display.

### glauberlima/claude-code-statusline

`ccinfobar import glauberlima-statusline` (alias `glauberlima`)

- File: `statusline.toml` next to the `statusline` binary in the status line command, else `~/.claude/statusline.toml`. Without a file, its defaults.
- Maps: its one line: directory, branch, changed files, model, context bar with used and max tokens, and cost (unless `cost = false`). Themes dracula, tokyo-night, one-dark and solarized-dark; phosphor is approximated by matrix. The `gradient` and other bar styles become a bar color.
- Approximated: the changed files count (git status). Dropped: the joke messages and their language.

### token-tracker

`ccinfobar import token-tracker`

- File: `~/.config/token-tracker/config.json`. `XDG_CONFIG_HOME` is not used, as in token-tracker. Without a file, the mocha default.
- Maps: tt's four fixed rows: project and git, tokens, cost and code; 5-hour and 7-day bars with resets and the context bar; input, output, cache and speed; model, effort, fast mode, duration and repo. Themes mocha, latte, frappé and macchiato (Catppuccin), Nord and Dracula.
- Approximated: the total and cache token counts, the remote host (the repo widget), the `auto` theme. Not imported: the language.

## Not importable

These 18 reviewed projects have no layout to import, or importing it would take far more work than it saves:

- No config file, the layout is in the script: nilbuild/claude-statusline, daniel3303/ClaudeCodeStatusLine, Astro-Han/claude-pace, AwesomeZun/CC-statusline, ilia-pluzhnikov/claude-code-statusline, danielmackay/claude-code-statusline, xleddyl/claude-watch, shanraisshan/claude-code-status-line, loadbalance-sudachi-kun/claude-code-statusline.
- A config without a layout: vfmatzkin/claude-statusline (budget numbers), kcchien/claude-code-statusline (glyph tier env vars), tmck-code/yet-another-statusline (width, theme, glyphs and budgets; the box layout is built in code).
- Not a Claude Code status line: m1ckc3s/claude-status-bar (macOS menu bar), rithkott/claude-thing (Spotify Car Thing HUD), anhannin/codex-hud (Codex), Autumn1337/better-statusline (an early-access plugin UI, not a stdin status line).
- Little overlap: sorosora/arcade-statusline (game-style renderings), ersinkoc/claude-statusline (generated themes, code templates and its own daemon).

ccinfobar presets and themes cover most of what these show. Start with `ccinfobar init <preset>` or the editor.
