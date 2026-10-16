# Configuration

ccinfobar reads a single JSON file. You rarely need to edit it by hand: `ccinfobar edit` (browser) and `ccinfobar tui` (terminal) write it for you. This page documents every field for those who prefer a text editor or want to keep the file in their dotfiles.

## Location

| Platform | Default path |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/ccinfobar/config.json` (falls back to `~/.config/ccinfobar/config.json`) |
| macOS | `~/.config/ccinfobar/config.json` |
| Windows | `%APPDATA%\ccinfobar\config.json` |

Override it with:

- `--config <file>` on any command
- `CCINFOBAR_CONFIG=<file>` for the file
- `CCINFOBAR_CONFIG_DIR=<dir>` for the directory

Your own themes live in `themes/` and your own presets in `presets/` next to `config.json`. A preset file holds `name`, `description` and a full `config`; `ccinfobar init <id>` applies it.

Built-in presets: `default`, `cockpit`, `dashboard`, `minimal`, `gsd`, `powerline`, `full`, `cost`, `limits`, `git`, `workspace`, `compact`, `two-line`, `agents`, `charts`, `session`. The [README](../README.md#presets) describes each one.

To use a project-specific layout, point the Claude Code `statusLine` command at a different file, e.g. `ccinfobar --config ./.claude/infobar.json`.

## Editor support

The file declares a JSON schema, so VS Code and other editors offer completion and validation:

```json
{
  "$schema": "https://raw.githubusercontent.com/alpadalar/ccinfobar/main/schema/config.schema.json"
}
```

## Example

```json
{
  "version": 1,
  "lines": [
    [
      { "id": "model-1", "type": "model" },
      { "id": "cwd-1", "type": "cwd", "options": { "style": "tilde" } },
      { "id": "git-branch-1", "type": "git-branch", "color": "magenta" },
      { "id": "flex-1", "type": "flex" },
      { "id": "context-bar-1", "type": "context-bar", "options": { "width": 12 } }
    ],
    [
      { "id": "gsd-milestone-1", "type": "gsd-milestone", "bold": true },
      { "id": "gsd-phase-1", "type": "gsd-phase" },
      { "id": "gsd-plans-1", "type": "gsd-plans", "color": "#7aa2f7" }
    ]
  ],
  "theme": "nord",
  "style": "capsule",
  "icons": "text"
}
```

## Top-level fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | `1` | Config format version |
| `lines` | `Widget[][]` | see presets | One array per status line, top to bottom. Lines with nothing to show are skipped. |
| `theme` | string | `"classic"` | Built-in theme id or the name of your own theme file. See [THEMES.md](THEMES.md). |
| `style` | `text` \| `blocks` \| `powerline` \| `capsule` \| `tui` | theme | Overrides the theme style |
| `separator` | string | theme | Overrides the text between widgets. Use `""` and `separator` widgets for full manual control. |
| `separatorColor` | color | theme | Overrides the separator color |
| `padding` | 0 to 4 | theme | Overrides the spaces inside blocks |
| `glyphs` | object | theme | Overrides `separator`, `thin`, `startCap` and `endCap` glyphs of powerline and capsule styles |
| `icons` | `nerd` \| `emoji` \| `text` \| `none` | `"text"` | What a widget shows before its value: Nerd Font glyph, emoji, short text label or nothing |
| `charset` | `auto` \| `nerd` \| `unicode` \| `text` | `"auto"` | Which characters may be printed. `nerd`: everything, including powerline arrows, capsule caps and Nerd Font icons. `unicode`: no Nerd Font needed; arrows become plain blocks, caps become half blocks (`▐ ▌`), Nerd icons fall back to text. `text`: ASCII only (bars `=-`, boxes `+-\|`). `auto`: `unicode` in Apple Terminal, `nerd` elsewhere. |
| `align` | `left` \| `center` \| `right` | `left` | Where lines sit in the terminal. In the panel style it places the box when the box is narrower than the terminal |
| `lineAlign` | array | | Alignment per line by index (`["right", null, "center"]`); `null` follows `align`. In the panel style it aligns the row inside the box |
| `autoWrap` | boolean | `true` | Move widgets that do not fit onto a new line instead of truncating with `…`. `overflow` wins when both are set |
| `overflow` | `truncate` \| `wrap` \| `priority` | from `autoWrap` | What happens when a line does not fit, see [Overflow and priority](#overflow-and-priority) |
| `glyphMode` | `normal` \| `single-width` \| `paste-safe` \| `jetbrains` \| `auto` | `"normal"` | Which characters are printed and how wide they count, see [Glyph mode](#glyph-mode) |
| `ambiguousWidth` | 1 \| 2 | `1` | Width of East Asian ambiguous characters such as `●`, `▓` and box drawing. Set `2` only when your terminal draws them double-width, see [Glyph mode](#glyph-mode) |
| `language` | `auto` \| `en` \| `tr` | `"auto"` | Display language; auto follows your locale, see [Language](#language) |
| `progress` | object | | The terminal tab's progress bar (OSC 9;4), off by default, see [Terminal progress](#terminal-progress) |
| `tui` | object | | Settings for the panel (`tui`) style, see [Panel style](THEMES.md#panel-style) |
| `colorLevel` | `auto` \| 0 \| 1 \| 2 \| 3 | `"auto"` | 0 no color, 1 basic 16, 2 256 colors, 3 truecolor. `auto` honors `NO_COLOR`, `FORCE_COLOR` and `COLORTERM`. |
| `maxWidth` | `auto` \| number | `"auto"` | Lines longer than this are truncated with `…`. `auto` uses the detected terminal width. |
| `widthOffset` | number | `10` | Columns subtracted from the terminal width in `auto` mode. Outside fullscreen mode Claude Code shows notifications on the right of the status line row; raise this (for example to `40`) to keep them visible. |
| `update` | `auto` \| `notify` \| `off` | `"auto"` | Background update behaviour, see [Updates](../README.md#updates); Homebrew copies only notify (see [DISTRIBUTION.md](DISTRIBUTION.md)) |
| `gsdAutoLine` | boolean | unset | Set by ccinfobar when it left GSD out because GSD was not installed; once GSD is installed the default GSD line is added as the second line and this is removed |
| `usageApi` | boolean | `true` | Fill usage limit widgets from Claude when Claude Code sends no `rate_limits`, see [Usage limits](../README.md#usage-limits) |
| `budget` | object | | Daily and per-session spend budget for the `budget` widget, see [Budget](#budget) |
| `gitHardening` | boolean | `true` | Ignore repo-local `core.fsmonitor` and `filter.<name>` drivers when ccinfobar runs git, so a cloned repo cannot run commands through the status line. Set `false` only if you need them |
| `loadingText` | string | `loading…` | Shown by context, token and plan-limit widgets until Claude's first reply, instead of `0%`. Up to 40 characters; `""` turns it off. Items with `hideEmpty` stay hidden |
| `profiles` | object | | Model profiles for gateway models: names, context windows and prices, see [Model profiles](#model-profiles) |
| `savePayload` | boolean | `true` | Store the latest Claude Code payload so the editors can preview with your real session data. `ccinfobar explain` reads it too; with no saved payload (for example when this was always off), explain falls back to sample data and says so |

Fields marked "theme" are optional. Leave them out to use the theme's value.

## Widget fields

Every entry in `lines` is a widget instance:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Unique id. The editors generate it. |
| `type` | string | Widget type, see [WIDGETS.md](WIDGETS.md) |
| `color` | color | Text color. Overrides the theme and any threshold color. |
| `background` | color | Background color. In block styles this is the block color. |
| `bold`, `dim`, `italic` | boolean | Text attributes (`bold` overrides the theme) |
| `label` | string | Replaces the default label, e.g. `"ctx"`. A space is added before the value unless the label already ends with one. `""` removes it. |
| `raw` | boolean | Value only, no label or icon |
| `merge` | boolean | Glue the next widget directly to this one, with no separator |
| `hideEmpty` | boolean | Hide the widget when it has no data. By default it shows its label and `—` (unlabelled widgets add a short name, e.g. `branch —`). |
| `showWhen`, `hideWhen` | string or string[] | Show or hide the widget by a rule, see [Visibility rules](#visibility-rules) |
| `priority` | 0 to 100 | With `overflow: "priority"`, higher stays longer. Default from the widget category, see [Overflow and priority](#overflow-and-priority) |
| `options` | object | Widget specific options, listed in [WIDGETS.md](WIDGETS.md) |

## Visibility rules

`showWhen` and `hideWhen` show or hide a widget by what is going on. A widget shows when `showWhen` is absent or holds, and `hideWhen` is absent or does not hold.

```json
"showWhen": "context.pct >= 70"
"hideWhen": ["!git"]
"showWhen": ["provider != firstParty", "time.hour in 9..18"]
"showWhen": "usage.5h >= 80 || usage.7d >= 90"
```

- A rule is one string or an array of strings. Every string in an array must hold (AND); inside one string, `||` separates alternatives (OR). There are no parentheses.
- A term is a flag (`git`, `!git`), a number comparison (`context.pct >= 70`, with `>`, `>=`, `<`, `<=`, `==` or `!=`), a word comparison (`provider == bedrock`, `!=`), a range (`time.hour in 9..18`, inclusive) or a list (`time.weekday in sat,sun`). Hour and weekday ranges wrap: `time.hour in 22..6`, `time.weekday in fri..mon`.
- Up to 8 strings of up to 256 characters, each with up to 8 terms.

| Metric | Kind | Meaning |
| --- | --- | --- |
| `context.pct` | number 0..100 | Context used, as `context-percentage` shows it |
| `context.usable` | number 0..100 | Context used against the point where Claude Code compacts |
| `usage.5h`, `usage.7d` | number 0..100 | 5-hour and weekly plan usage |
| `cost.session` | number | This session's cost in USD |
| `cost.today` | number | Today's cost across sessions, only when the [cost ledger](#estimated-cost) is on |
| `tokens.total` | number | Total tokens of the session |
| `agents.running` | number | Running subagents |
| `time.hour` | number 0..23 | Local hour |
| `time.weekday` | `mon`..`sun` | Local weekday |
| `provider` | word | `firstParty`, `apiKey`, `bedrock`, `mantle`, `anthropicAws`, `vertex`, `foundry` or `gateway` |
| `git` | flag | Inside a git repo (found by looking for `.git`; git is never run for this) |
| `gsd` | flag | Inside a GSD project (a `.planning/` folder) |
| `agents` | flag | A subagent is running |
| `limit-risk` | flag | A limit is projected to run out before it resets, like the `limit-risk` chip |
| `permission.waiting` | flag | A permission prompt was shown (needs [hooks](../README.md#hooks)) |

Numbers are compared as you see them: percentages rounded to whole numbers, costs to cents. A metric with no data makes every comparison false, so `context.pct >= 70` hides before the first reply and `!git` holds outside a repo.

A `~N` band stops a widget from flickering at the threshold: `usage.5h >= 80 ~5` turns on at 80 and stays on until usage drops below 75. It works on `>`, `>=`, `<` and `<=` for `usage.5h` and `usage.7d` (from the shared limits samples) and `context.pct` (when the session chart history is recorded); elsewhere the plain threshold applies. Nothing new is stored for it.

A hidden widget leaves nothing behind, not even `—`, and `hideEmpty` applies after the rules. Rules work in every style, panel cells included.

**A broken rule never blanks the line.** A rule that does not parse (an unknown metric, a bad operator or number) is ignored and the widget shows as if it had no rule. `ccinfobar doctor` and `ccinfobar explain` name the widget and the problem (`⚠ Widget ctx1: showWhen is ignored (bad operator at 13)`), the editors show it next to the field, and `ccinfobar config set` refuses it. `explain` also says which rule hid a widget: `hidden, showWhen "context.pct >= 70" (context.pct = 42)`.

In the editors, the widget's Visibility section has one-click rules (only in git repos, only in GSD projects, only while agents run, context and 5h thresholds, hide on a provider, an hours range) and a text field for any rule; there, `; ` separates the strings of an array.

**Time rules need a refresh interval.** Claude Code only re-runs the status line on its own triggers (see [Refresh interval](#refresh-interval)), so a `time.*` rule changes late without one. `install` and `doctor` suggest `ccinfobar install --refresh 5` when a rule uses `time.*`; nothing is set for you.

## Overflow and priority

`overflow` decides what happens when a line is wider than the terminal:

| `overflow` | What happens |
| --- | --- |
| `truncate` | The line is cut with `…` |
| `wrap` | Widgets that do not fit move to a new line |
| `priority` | The least important widgets are dropped until the line fits |

Without `overflow`, `autoWrap` decides as before (`true` is `wrap`, `false` is `truncate`). When both are set, `overflow` wins. The editors write both (`autoWrap` is `true` only for `wrap`), so an older ccinfobar reading the same file behaves the same.

With `priority`, each widget has a `priority` from 0 to 100; higher stays longer. Without one it comes from the widget's category:

| Category | Default priority |
| --- | --- |
| Context window, Usage limits, Session & model | 70 |
| Git, Workspace, Cost & time, Tokens & cache | 50 |
| Everything else (GSD, Agents, Charts, System, Custom, Fun) | 30 |

- The lowest one goes first; on a tie the rightmost goes first. Separators and `flex` space are worked out again after each drop.
- Widgets joined with `merge: true` drop together and count as their highest member. Layout items (`text`, `separator`, `flex`) never count for priority. A `text` item goes with the widget before it (or the one after it at the start of the line or after a `flex`). A `separator` item is kept only while widgets are left on both sides of it: when a widget drops, one gap's separators stay between the remaining neighbours, and none is left at the edge of the line or of a `flex` group (separators you placed at an edge stay). Text a widget prints below the line goes with it too.
- The last widget left is never dropped; if it still does not fit it is cut with `…`.
- `ccinfobar explain` shows each widget's priority and `dropped by priority at width N`, and the web editor marks dropped widgets on the canvas.
- The panel (`tui`) style keeps its own breakpoints and cuts cells to fit; `priority` does not apply there, and `doctor` says so.

## Glyph mode

`glyphMode` changes which characters ccinfobar prints and how it counts their width:

| `glyphMode` | What it does |
| --- | --- |
| `normal` (default) | Today's output |
| `single-width` | Emoji icons become text, emoji ccinfobar prints get a one-column form where one exists (`✅` becomes `✔`), a single emoji with a variation selector becomes its text form (joined sequences such as the rainbow flag and keycaps stay whole and count as 2) and fullwidth letters become ASCII. CJK text cannot be folded and counts as 2 |
| `paste-safe` | Everything `single-width` does, plus no Nerd Font glyphs (separators and caps fall back as with `charset: "text"`), and no links. `ccinfobar preview` then prints plain spaces; the live status line keeps non-breaking spaces in every mode, because Claude Code trims and collapses plain ones. Colors stay. Use it for status lines you paste into a GitHub issue or code block |
| `jetbrains` | Emoji count as one column, the way JetBrains terminals draw them |
| `auto` | `jetbrains` when `TERMINAL_EMULATOR` contains `JetBrains`, else `normal` |

`ccinfobar preview --glyph-mode paste-safe` prints one line in a mode without saving it. `ccinfobar doctor` suggests `jetbrains` in a JetBrains terminal, and `explain` shows the mode in use.

`ambiguousWidth: 2` counts East Asian ambiguous characters (`●`, `▓`, `…`, box drawing) as two columns, for CJK-locale terminals that draw them wide. Claude Code itself measures them as narrow, so keep the default `1` unless your terminal really draws them double-width. Nerd Font icons always count as 1.

## Language

`language` sets the language of the status line, the CLI and both editors. The values are `auto` (default), `en` and `tr`.

With `auto` (or no `language` key) ccinfobar picks the language from the first of these that is set:

1. `CCINFOBAR_LANG=<tag>`, which forces the display language while `language` is `auto`
2. `LC_ALL`
3. `LC_MESSAGES`
4. `LANG`
5. the system locale
6. English

The first non-empty variable decides, even when it names a language ccinfobar does not have; then you get English. `CCINFOBAR_LANG=auto`, or a value that names no language, counts as not set. `C` and `POSIX` mean English. Tags such as `tr`, `tr_TR.UTF-8` or `tr-TR` select Turkish.

```json
{ "language": "tr" }
```

```sh
ccinfobar config set language tr     # or en, or auto (removes the key)
CCINFOBAR_LANG=tr ccinfobar preview  # one run in Turkish
LANG=C ccinfobar doctor              # English in scripts
```

Set `"language": "en"` to keep English on a machine with a Turkish locale. The web editor has a Language select in Settings and the terminal editor (`ccinfobar tui`) a Language field next to Glyph mode; both switch at once, and Auto removes the `language` key. `ccinfobar doctor` shows the language in use and where it came from (`Language: English (en, from config)`), and warns about an unsupported `language` value.

What does not change with the language:

- JSON output (`explain --json`, `bench --json`, `config get` and the editor API) stays English.
- Numbers, units, costs and compact durations look the same as in English (`12.4/31.0 GB`, `$1.87`, `2h 13m`). Dates use the language's month and day names with 24-hour times (`Oct 14, 2026, 21:07`, `14 Eki 2026 21:07`).
- Widget ids, theme ids, config keys, commands and flags never change. Labels and text you wrote in your config show as written.
- `ccinfobar init --force`, presets and `ccinfobar import` keep your `language` setting. The web editor's Import config uses the pasted config's `language` when it has one.

## Colors

Any of these work wherever a color is accepted:

- Named: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white` and their `bright*` variants (`brightBlack` is a good gray)
- 256 palette: `ansi256:208` or just `208`
- Hex: `#ff8800` or `#f80`
- `default` to fall back to the terminal color

Colors are converted down automatically when the terminal supports fewer colors.

## Bars

Widgets that draw a bar (`context-bar`, `five-hour-usage` and `weekly-usage` with `display: "bar"`, `gsd-milestone-progress`, `gsd-plan-progress`, `gsd-summary`) accept `width`, `style`, `barColor` and `showPercent`.

| `style` | Example |
| --- | --- |
| `blocks` | `█████░░░░░` |
| `blocks-line` | `█████─────` |
| `shade` | `▓▓▓▓▓░░░░░` |
| `bar` | `▪▪▪▪▪▫▫▫▫▫` |
| `thin` | `━━━━━─────` |
| `line` | `━━━━━┄┄┄┄┄` |
| `capped` | `━━━━╸┄┄┄┄┄` |
| `ball` | `─────●────` |
| `dots` | `●●●●●○○○○○` |
| `filled` | `■■■■■□□□□□` |
| `squares` | `◼◼◼◼◼◻◻◻◻◻` |
| `geometric` | `▰▰▰▰▰▱▱▱▱▱` |
| `ascii` | `#####-----` |
| `ring` | `⠹` (one Braille cell that fills clockwise in 8 steps; `width` is ignored) |
| `matrix` | `⣿⣿⣇⣀⣀` (Braille dots, two steps per cell) |

With `charset: "text"` every bar becomes `=====-----`.

`barColor: "gradient"` colors each filled cell by its position along the bar, from green through yellow and red to violet, or through the theme's `gradient` colors when it has them. The default is `solid`. With 16 colors the steps are green, yellow and red at 50% and 80%, and without color the bar is plain.

`five-hour-usage` and `weekly-usage` also take `showPace`: the text becomes `60%/40%` (actual and even-burn usage), and bars get a `◆` (ahead of pace) or `◇` (under pace) marker where even burn would be.

## Context basis

`context-percentage` and `context-bar` take a `basis` option that sets what 100% means:

| `basis` | 100% is |
| --- | --- |
| `raw` (default) | the full context window, as Claude Code reports it |
| `usable` | the point where Claude Code compacts: the window minus the output reserve and the compaction buffer, so a 1M window counts against about 967K. It follows `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| `reserve` | the window minus `reserveTokens` (default `20000`), an approximate output reserve you set yourself |

`usable` and `reserve` count against the window Claude Code itself compacts at: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` when it is set (gateway and cloud sessions), else the size Claude Code reports. A [model profile](#model-profiles) window changes `raw` only. `usable` and `reserve` fall back to `raw` until the window size and token count are known. The old `usable: true` option still works; the editor and TUI show and save it as `basis: "usable"`.

## Budget

```json
{ "budget": { "daily": 10, "session": 2.5, "warnAt": 0.8 } }
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `daily` | number | | Budget in USD for today's estimated spend across all sessions |
| `session` | number | | Budget in USD for this session's cost |
| `warnAt` | number | `0.8` | Fraction of the budget where the widget turns yellow, clamped to 0.05..1 |

Amounts must be positive; anything else is dropped. Set them with `ccinfobar config set budget.daily 10` (remove with `ccinfobar config unset budget.daily`), in the web editor's Settings (Budget) or in the TUI's settings.

The `budget` widget shows spend against one of them: `period` is `daily` (default, from the [cost ledger](#estimated-cost)) or `session` (this session's cost), and `display` is `amount` (`~$4.10/$10`), `percent` or `bar`. It is green below `warnAt`, yellow from `warnAt` and red at 100% or more, and it shows `—` while that budget is not set (`ccinfobar explain` says so). It is separate from `spend-limit`, which shows the spend limit Claude reports for your plan.

## Shared limits

Plan limits (5-hour, weekly and per-model weekly) are kept in one file per account under the cache dir (`limits/<account key>.json`, mode 0600). The account key is a hash of the Claude config dir and the provider, so two `CLAUDE_CONFIG_DIR`s never share limits. Every session writes the values Claude Code sent it, stamped with the time of its last reply, and reads the newest one back:

- The latest window wins, then the newest capture, so an idle session shows the active session's numbers.
- An expired window is dropped and never comes back.
- The usage API only replaces a payload value when its fetch is newer and the two differ by at least 1 point (the API sends whole percents, Claude Code tenths).
- With `usageApi: false` sessions still share the values Claude Code sends; only the fetch is off.
- When the usage fetch sees that you logged in to another account, the stored values are dropped. A token refresh does not count as a switch: the account is recognized by its id in `.claude.json` (`oauthAccount`), else by the refresh token.

The file holds percentages, reset times and a few samples for the projection widgets, never a token. `ccinfobar explain` says whether a value came from this session, another session or the usage API.

## Estimated cost

`cost-today`, `cost-week`, `cost-project`, `activity-strip` and a daily `budget` widget read a local cost ledger. Counting starts when the first of them is on your status line; earlier sessions are not included, and a session that is already running counts from that point on. `activity-strip` shows the last 9 hours by default (up to 7 days are kept) in 15-minute slots: a cell is busy when the estimated cost of any session of your account went up in it. Totals are Claude Code's own cost estimates (`cost.total_cost_usd`) and will differ from your bill.

Resuming or forking a session, `/clear`, compaction, `/login` and two terminals on one session are each counted once. When two terminals keep working on the same resumed session, the ledger cannot tell them apart (Claude Code sends no per-process id), so their spend is undercounted, by up to about a third when both totals stay close. While the ledger is being rebuilt (for example after `ledger/summary.json` was deleted), totals end in `…` and may be low for a few refreshes. The ledger is `ledger/YYYY-MM.jsonl` under the cache dir (mode 0600): one line per change with the time, an account key, the session id, the project path and the session's running total. It never contains a token. Month files older than 13 months are deleted. Layouts without these widgets do not read or write it.

## Live session widgets

`tool-activity`, `turn-timer`, `permission-wait`, `env-counts` and `workspace-repos` are opt-in; the default layout does not use them. The `agents` preset uses `tool-activity`, `turn-timer` and `permission-wait`, and the `workspace` preset uses `workspace-repos`. Their options are in [WIDGETS.md](WIDGETS.md).

### Refresh interval

Claude Code runs the status line on a new assistant message, on token, permission mode, model, effort or vim changes, and on its `refreshInterval` timer (`statusLine.refreshInterval` in Claude Code's settings, not in this config). It does not run it on hook events or tool results, and not while a permission dialog is open, so time-based widgets only move on those triggers.

The time-based widgets are `turn-timer`, `permission-wait`, `tool-activity`, `usage-projection`, `limit-eta`, `limit-risk`, `cache-timer`, `clock`, `service-status`, `http`, `activity-strip`, `pet` and `kaomoji`. When one of them is on your layout and no interval is set:

- `ccinfobar install` (also with `--dry-run` and `--hooks`) and `ccinfobar doctor` print a hint to run `ccinfobar install --refresh 5`
- the web editor's Settings (Claude Code) shows a warning with a **Use 5 s refresh** button, which installs only after you confirm

Nothing is set for you. 5 s is a good balance; `--refresh 1` works but runs ccinfobar every second, and `install` says so.

### tool-activity and turn-timer

Both read the transcript and need no hooks. With hooks, `turn-timer` uses the exact prompt and stop times, unless the transcript shows a missed prompt, a missed stop or another prompt id; then it falls back to the transcript. A tool running longer than 10 minutes is no longer shown as running. `tool-activity` cuts the command or file name at 32 characters and masks values after names such as `GITHUB_TOKEN=` or `--password=`, `Bearer` tokens and passwords in URLs; set `showArgs: false` to hide the argument.

### permission-wait

Needs `ccinfobar install --hooks`. The wait starts at the `Notification` hook for a permission prompt, about 6 s after the dialog appears (each keystroke in the terminal delays it), and ends at the first tool result after it (from the transcript), or at `PermissionDenied`, `Stop` or a new prompt when one of those comes first. Later tools in the same turn do not add to it. Because Claude Code hides the status line during the dialog, the widget only shows closed waits of the current turn; waits longer than `maxAgeMin` (default 30) are ignored.

### env-counts

Counts come from config files and a stat-only cache; nothing is spawned and no server is probed.

- **CLAUDE.md**: managed, user (`$CLAUDE_CONFIG_DIR/CLAUDE.md`), and `CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` in the launch folder and its parents. Files in subfolders load lazily and are not counted.
- **AGENTS.md**: counted only when it is in effect, which by default means the project has no CLAUDE.md.
- **rules**: `*.md` under the user and project `.claude/rules` folders.
- **MCP**: servers in `.claude.json` (user and this project), approved `.mcp.json` servers in the launch folder and its parents, and managed servers. Claude Code rewrites `.claude.json` often, so a change is picked up once the file has been quiet for 30 seconds; a `.claude.json` over 8 MB is not parsed, and the counts from when it was smaller are kept.
- **hooks**: handlers in user, project, local and managed settings, or `hooks off` when `disableAllHooks` applies.

Not covered:

- plugin MCP servers and claude.ai connectors, which are not in config files
- plugin hooks and settings passed with `--settings`
- a `.claude.json` project entry keyed by a folder other than the git root, or the main checkout for a linked worktree (keys match case-insensitively on macOS and Windows)
- `claudeMdExcludes` (excluded files are still counted) and an inline managed `claudeMd`
- MCP health: `mcpHealth` is reserved because Claude Code does not expose MCP status to the status line, so it does nothing today and `ccinfobar explain` says so

### workspace-repos

Lists git repos directly inside the current folder when that folder is not inside a repo. Elsewhere it hides itself instead of showing `repos: —`; set `hideEmpty: false` on it to keep the placeholder. It reads `.git/HEAD` files, never runs git while rendering, and rescans at most every 10 seconds. Inside-repo detection walks up to the filesystem root looking for `.git`, so a dotfiles repo at `~/.git` makes every folder under your home count as inside a repo and the widget stays hidden there. `GIT_DIR` and `GIT_WORK_TREE` are ignored. With `dirty: true` a background job runs a hardened `git status` in up to 50 repos, the ones on screen first, about once a minute; the status line only reads its cache.

## External data

`service-status`, `http`, `provider` and the `pr` option `ci` are opt-in; neither the default layout nor any built-in preset uses them. The status line never waits on the network: after it has printed, ccinfobar starts at most one background process that refreshes whatever is due and writes the results to the cache dir (`jobs/<key>.json`, mode 0600). The next refresh shows them. Until the first result arrives a widget stays empty, and `ccinfobar explain` says why.

### What runs when

| Check | Kind | Off with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` |
| --- | --- | --- |
| usage limits, update check, `service-status` | automatic | yes |
| `http` items, the `pr` CI part | explicit: you typed the URL or turned on `ci` | no, they still run |
| `workspace-repos` dirty marker | local, no network | no |

Claude Code also stops sending `pr` when that flag is set, so the CI part disappears with the PR. `CCINFOBAR_NO_JOBS=1` turns off every background check (bench and tests use it). `ccinfobar doctor` lists each job with its age, last error and retry time, and says what turns jobs off.

There is no proxy support of ccinfobar's own: `HTTPS_PROXY` and `NO_PROXY` are not read. Node's own `NODE_USE_ENV_PROXY=1` makes `fetch` use them on Node 22.21+ and 24+; it has to be in the environment Claude Code starts the status line with.

### service-status

Shows the indicator and the worst open incident from Claude's status page (`https://status.claude.com/api/v2/summary.json`), such as `⚠ major: Elevated errors on Opus +1`. It hides itself when all is well; `showOk: true` shows `✓ Claude OK` instead.

| Option | Default | Description |
| --- | --- | --- |
| `interval` | `180` | Seconds between checks, 120 to 600. A failed check is retried after 60 s, then less often, up to 30 min |
| `components` | `""` | Comma-separated terms. When set, only incidents whose affected component names contain one of them count (`api, claude code`); case-insensitive. A component that is degraded without an incident is not seen in this mode |
| `showName` | `true` | Show the incident name, not just the indicator |
| `showOk` | `false` | Show `✓ Claude OK` when nothing is wrong |
| `maxLength` | `40` | Cut the incident name with `…` |

When the latest check failed, the last result stays for up to 30 minutes with a trailing ` ?`, then the widget hides. An old "all good" is never shown.

### http

Shows one value from any JSON endpoint. A relay balance:

```json
{
  "id": "bal",
  "type": "http",
  "options": {
    "url": "https://relay.example.com/api/user/balance",
    "path": "$.data.balance",
    "format": "${value}",
    "decimals": 2,
    "headers": "Authorization=Bearer $RELAY_TOKEN"
  }
}
```

A gateway quota with the key in the query string:

```json
{
  "id": "quota",
  "type": "http",
  "options": {
    "url": "https://gateway.example.com/v1/quota?key=${API_KEY}",
    "path": "$.remaining",
    "format": "{value} left",
    "interval": 600
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `url` | | `http:` or `https:` only; no `user:pass@`. `${VAR}` is allowed in query values only, never in the host or path, and only over `https:` or to localhost |
| `path` | `$` | JSON path: `$`, `.key`, `['key']`, `[0]`, `[-1]`. No filters, wildcards or `..`. The value must be a string, number, boolean or null |
| `format` | `{value}` | Text around the value; `{value}` is the only placeholder |
| `interval` | `300` | Seconds between fetches, at least 30 |
| `timeout` | `5000` | Milliseconds, 1000 to 15000 |
| `headers` | `""` | `Name=$VAR` or `Name=<Scheme> $VAR` entries, comma or newline separated (`${VAR}` works too). `Accept` and `User-Agent` are fixed and cannot be set |
| `decimals` | `-1` | Digits after the point for numbers; `-1` keeps them as they are |
| `maxLength` | `40` | Cut a text value with `…` |

Rules:

- **Secrets come from env vars only.** A header with a literal value (`Authorization=Bearer abc`) is dropped and `ccinfobar doctor` reports it. Values are filled in by the background process when it fetches; they are never written to the cache, argv, explain or doctor. A missing variable shows as `env RELAY_TOKEN not set` in `ccinfobar explain`, and nothing is fetched.
- **Some env vars are never sent.** Names starting with `ANTHROPIC_`, `CLAUDE_`, `AWS_`, `GOOGLE_`, `GCLOUD_`, `GCP_`, `AZURE_`, `CCINFOBAR_` or `SSH_`, and `NPM_TOKEN` and `NODE_AUTH_TOKEN`, are refused in headers and query values (in any letter case). `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` go only to `api.github.com`, `*.ghe.com` or a host `gh auth status` lists. A refused item shows nothing; the editor, `ccinfobar doctor` and `ccinfobar explain` name the variable, and the background job reports `env NAME denied` without reading it. Use a variable of your own, such as `RELAY_TOKEN`.
- An http item sends the env vars it names to its host. Check the URL before you copy someone else's config; `ccinfobar doctor` lists every http item with its host and the env vars it sends (set or unset, never the value). Doctor and `explain` show the URL with query values and token-like path segments (such as a webhook or bot token) replaced by `…`.
- Env values (headers and `${VAR}` query values) are sent only over `https:`, or plain `http:` to `localhost`, `127.0.0.1` or `::1`. An item that would send one to another plain `http:` host is refused: nothing is fetched, the item shows nothing, and the editor, `ccinfobar doctor` and `ccinfobar explain` say `secrets need https or localhost`. Doctor also warns about a plain `http:` URL without secrets, because the reply can be changed on the way.
- Redirects are followed up to 3 times, only on the same origin or from `http:` to `https:` on the same host. Any other redirect is refused.
- Replies over 256 KB are cut off and count as an error. Only the values your paths pick are stored, never the reply.
- Items with the same `url` and `headers` share one fetch; the shortest `interval` wins. A new item or a changed `path` on a URL that is already cached is fetched on the next refresh, not after the interval.
- When a fetch fails, the last good value stays. Once it is older than three intervals (at least 15 minutes) it gets a ` ?`, and after 24 hours without success the widget hides.
- With `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, Claude Code removes token-like variables from the status line's environment, so those headers report "not set".

### PR CI checks

`pr` with `ci: true` adds the checks of the current pull request: `#128 approved ✗ 2` (failing, cancelled counts as failing), `● 3` (still running) or `✓` (all passed). Nothing is added when the PR has no checks. The counts come from your own `gh pr checks`, run in the background about every minute while checks run and every 5 minutes after. ccinfobar never reads a token itself.

- The PR comes only from the payload Claude Code sends (`pr` and `workspace.repo`); GitLab merge requests are skipped.
- gh runs for `github.com`. Any other host, `*.ghe.com` included, must be one you logged in to with `gh auth login --hostname <host>` (`gh auth status` lists them); otherwise gh is not run, so `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` never go to an unknown host.
- Without gh, when it is not logged in, or when it is older than 2.81 (no `gh auth status --json`) for a host that needs the check, the CI part is left out and `ccinfobar explain` prints a `CI:` line with the reason.

### provider

Shows who serves the session: `Bedrock`, `Vertex`, `Foundry`, `Mantle`, `AWS`, `API key`, or a gateway as `GLM via api.z.ai` (with a matching model profile) or its host. It shows nothing for a normal Claude login unless `showFirstParty` is on (`Claude`).

Detection reads only which variables are set (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and so on), never their secret values. Claude Code passes the `env` block of its settings files to the status line, so variables set there are seen; nothing extra is needed. Plan-limit widgets hide for Bedrock, Vertex, Foundry, API key and gateway sessions unless Claude Code sends limits.

## Model profiles

Gateways such as Z.ai or DeepSeek report models Claude Code does not know, so it assumes a 200K window and prices nothing. ccinfobar ships a table (updated 2026-10-14) for GLM (Z.ai and BigModel), Kimi (Moonshot), DeepSeek, MiniMax and Qwen (DashScope). For a non-Claude provider a matching profile gives:

- **Context window.** When Claude Code reports the 200K default (or no size) and the profile knows a larger window, context widgets use the profile's window. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` wins over both. Claude logins are never affected. The `usable` and `reserve` [bases](#context-basis) keep the window Claude Code compacts at, because Claude Code does not know the profile: set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the model's window so Claude Code itself uses it, and those bases follow.
- **Cost.** `session-cost` with `basis: "auto"` uses the profile's prices in its currency when they are known, else Claude Code's cost; `basis: "profile"` always uses the profile. The default `payload` keeps Claude Code's number. Gateway users should set `auto`. Ledger, `cost-*` and budget widgets stay in USD from Claude Code.
- **Name.** `model` with `profileLabel: true` shows the profile's name instead of a raw model id.

Built-in prices are per 1M tokens and apply only when `ANTHROPIC_BASE_URL` is the vendor's own API host; through another gateway you get the name and window but no price. Where a vendor has tiers, the table stores one list price:

- DeepSeek: the peak price (off-peak is half)
- MiniMax: the price up to 512K input (above is double)
- Qwen: the International region list price; other regions have names and windows only

Prices change, and they are never fetched; add your own entries to fix or extend them:

```json
{
  "profiles": {
    "builtIn": true,
    "models": [
      { "match": "glm-*", "contextWindow": 500000 },
      { "match": "my-model", "label": "Mine", "input": 0.5, "output": 2, "currency": "EUR" }
    ]
  }
}
```

| Field | Description |
| --- | --- |
| `builtIn` | `false` turns the built-in table off |
| `models[].match` | Case-insensitive pattern on the model id or display name; `*` matches anything. Up to 200 characters |
| `label`, `contextWindow` | Name and window size in tokens |
| `input`, `output`, `cacheRead`, `cacheWrite` | Prices per 1M tokens, positive. A price needs both `input` and `output` |
| `currency` | Three capital letters, default `USD` |

Your entries win over the built-ins and the first match wins; they apply to every provider. Set them with `ccinfobar config set profiles.builtIn false` or `ccinfobar config set profiles.models '[{"match":"glm-*","contextWindow":500000}]'`, or in the web editor's Settings (Model profiles), which also lists the built-ins. The TUI has the on/off switch only.

## Terminal progress

Some terminals show a progress bar in the tab or taskbar (OSC 9;4). ccinfobar can show your context fill, or 5-hour usage, there. It is off by default.

```sh
ccinfobar install --progress     # turn it on
ccinfobar uninstall --progress   # turn it off and clear the bar
```

`install --progress` adds three synchronous hook handlers (`UserPromptSubmit`, `Stop`, `StopFailure`) to `~/.claude/settings.json`, records them in the manifest and sets `progress.enabled` to `true`. It needs Claude Code 2.1.141 or newer and refuses when the version is older or unknown; `--dry-run` shows the change. The web editor's Settings (Terminal progress) has the same switch; it writes `progress.enabled` to the config file together with the handlers, right away and outside undo, so the two never disagree. The TUI has every option below.

How it works: each render writes the value it wants in a small file in the cache dir (`hooks/<session id>.progress.json`, only when the value changes), and the handler hands it to Claude Code as a `terminalSequence` when it differs from the last one sent. The bar therefore moves when you send a prompt and when a turn ends. With the regular hooks installed (`install --hooks`), `SessionStart` forgets the last value sent, so a session resumed in a new tab gets its bar at the next prompt.

**Cost.** Claude Code waits for synchronous hooks, so this adds about 60-110 ms before each prompt while it is on. `ccinfobar explain` says so next to the current value. The `tty` channel below has no such cost.

```json
{ "progress": { "enabled": true, "source": "context", "warnAt": 50, "errorAt": 80 } }
```

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Turn it on (`install --progress` sets it) |
| `source` | `context` | `context` (context used) or `usage5h` (5-hour usage) |
| `scaleTo` | `full` | `full` (the whole window) or `autocompact` (the point where Claude Code compacts is 100%) |
| `warnAt` | `50` | From this percent the bar shows the warning state (usually yellow), 1..100 |
| `errorAt` | `80` | From this percent the bar shows the error state (usually red), 1..100 |
| `channel` | `auto` | `hook` (through Claude Code's hooks), `tty` (straight to the terminal, Linux and macOS only) or `auto`, which is `hook` |
| `terminals` | `allowlist` | `allowlist` writes only in terminals known to draw the bar; `always` writes everywhere |
| `tmuxPassthrough` | `false` | Let the `tty` channel write inside tmux |

**Terminals.** By default the bar is only sent to Windows Terminal, ConEmu, WezTerm, Ghostty 1.2+ and iTerm2 3.6.6+. Other terminals may show OSC 9 as a desktop notification on every turn, so they need `terminals: "always"`.

**Claude Code's own bar.** Claude Code shows its own busy bar in the same terminals and clears the bar at the end of each turn, so the two fight and flicker. Set `"terminalProgressBarEnabled": false` in Claude Code's settings. ccinfobar never writes that setting; `ccinfobar doctor` warns and names the file to change.

**The tty channel.** With `"channel": "tty"` on Linux or macOS, the status line writes the bar straight to Claude Code's terminal whenever the value changes, so there is no hook and no prompt latency. It needs no handlers:

```sh
ccinfobar config set progress.channel tty
ccinfobar config set progress.enabled true
```

`ccinfobar install --progress` and the web editor's switch add no handlers while the channel is `tty`, and remove ones installed earlier, which would otherwise still cost their 60-110 ms; changing the channel in the web editor while progress is on does the same at once. After switching the channel by hand or in the TUI, run `ccinfobar install --progress` again so the handlers match; `ccinfobar doctor` warns about handlers left on the tty channel. The bar moves only when Claude Code re-runs the status line. On Windows `tty` falls back to the hook.

**tmux.** tmux 3.3 and newer drop passthrough sequences unless `~/.tmux.conf` has `set -g allow-passthrough on`, so both channels need that line. On the hook channel Claude Code wraps the sequence for tmux itself, so nothing else is needed; the tty channel also needs `progress.tmuxPassthrough: true`. Inside tmux `TERM_PROGRAM` says `tmux`, so ccinfobar recognises the outer terminal from variables tmux keeps: `WT_SESSION`, `ConEmuPID`, `WEZTERM_EXECUTABLE` or `WEZTERM_PANE`, `GHOSTTY_RESOURCES_DIR`, and `LC_TERMINAL_VERSION` 3.6.6 or newer for iTerm2. `KITTY_WINDOW_ID` means kitty, which shows OSC 9 as a notification, so it is never allowed. These variables come from the terminal the tmux server started in, and Ghostty's version cannot be read there (Ghostty before 1.2 shows OSC 9 as notifications). Set `progress.terminals` to `"always"` when your terminal is not recognised.

**Turning it off.** `uninstall --progress` sets `progress.enabled` to `false` (the key stays, as `{ "enabled": false }`) and asks every open session to clear its bar. Only these handlers can clear a bar, at the next prompt or turn end, so while a bar is still showing the first `uninstall --progress` keeps them and says so; run it again after that prompt to remove them. Otherwise it removes only these handlers. Run in a terminal, it also clears that terminal's bar at once. `ccinfobar uninstall` removes the handlers right away and clears only the terminal it runs in. The web editor's switch works the same way: while a bar is showing it keeps the handlers and shows a Remove handlers button for afterwards. Turning progress off in the TUI, or setting `enabled: false` by hand, keeps the handlers, so the next prompt clears the bar; `ccinfobar doctor` then reports the leftover handlers. `ccinfobar doctor` checks Claude Code's own bar, missing or leftover handlers (also on the tty channel), unsupported terminals, the Claude Code version, and the tty channel on Windows or in tmux.

## Layout tips

- Put a `flex` widget between two groups to push the second group to the right edge.
- Set `merge: true` on a `text` widget to attach a custom prefix to the next widget.
- Keep GSD widgets on their own line and set `hideEmpty` on them: the whole line disappears outside GSD projects.
- `raw: true` plus a `text` widget lets you build any label style you like.
