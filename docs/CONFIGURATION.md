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
| `autoWrap` | boolean | `true` | Move widgets that do not fit onto a new line instead of truncating with `…` |
| `tui` | object | | Settings for the panel (`tui`) style, see [Panel style](THEMES.md#panel-style) |
| `colorLevel` | `auto` \| 0 \| 1 \| 2 \| 3 | `"auto"` | 0 no color, 1 basic 16, 2 256 colors, 3 truecolor. `auto` honors `NO_COLOR`, `FORCE_COLOR` and `COLORTERM`. |
| `maxWidth` | `auto` \| number | `"auto"` | Lines longer than this are truncated with `…`. `auto` uses the detected terminal width. |
| `widthOffset` | number | `10` | Columns subtracted from the terminal width in `auto` mode. Outside fullscreen mode Claude Code shows notifications on the right of the status line row; raise this (for example to `40`) to keep them visible. |
| `update` | `auto` \| `notify` \| `off` | `"auto"` | Background update behaviour, see [Updates](../README.md#updates) |
| `gsdAutoLine` | boolean | unset | Set by ccinfobar when it left GSD out because GSD was not installed; once GSD is installed the default GSD line is added as the second line and this is removed |
| `usageApi` | boolean | `true` | Fill usage limit widgets from Claude when Claude Code sends no `rate_limits`, see [Usage limits](../README.md#usage-limits) |
| `budget` | object | | Daily and per-session spend budget for the `budget` widget, see [Budget](#budget) |
| `gitHardening` | boolean | `true` | Ignore repo-local `core.fsmonitor` and `filter.<name>` drivers when ccinfobar runs git, so a cloned repo cannot run commands through the status line. Set `false` only if you need them |
| `loadingText` | string | `loading…` | Shown by context, token and plan-limit widgets until Claude's first reply, instead of `0%`. Up to 40 characters; `""` turns it off. Items with `hideEmpty` stay hidden |
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
| `options` | object | Widget specific options, listed in [WIDGETS.md](WIDGETS.md) |

## Colors

Any of these work wherever a color is accepted:

- Named: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white` and their `bright*` variants (`brightBlack` is a good gray)
- 256 palette: `ansi256:208` or just `208`
- Hex: `#ff8800` or `#f80`
- `default` to fall back to the terminal color

Colors are converted down automatically when the terminal supports fewer colors.

## Bars

Widgets that draw a bar (`context-bar`, `five-hour-usage` and `weekly-usage` with `display: "bar"`, `gsd-milestone-progress`, `gsd-plan-progress`, `gsd-summary`) accept `width`, `style` and `showPercent`.

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

With `charset: "text"` every bar becomes `=====-----`.

`five-hour-usage` and `weekly-usage` also take `showPace`: the text becomes `60%/40%` (actual and even-burn usage), and bars get a `◆` (ahead of pace) or `◇` (under pace) marker where even burn would be.

## Context basis

`context-percentage` and `context-bar` take a `basis` option that sets what 100% means:

| `basis` | 100% is |
| --- | --- |
| `raw` (default) | the full context window, as Claude Code reports it |
| `usable` | the point where Claude Code compacts: the window minus the output reserve and the compaction buffer, so a 1M window counts against about 967K. It follows `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| `reserve` | the window minus `reserveTokens` (default `20000`), an approximate output reserve you set yourself |

`usable` and `reserve` fall back to `raw` until the window size and token count are known. The old `usable: true` option still works; the editors save it as `basis: "usable"`.

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

`cost-today`, `cost-week`, `cost-project` and a daily `budget` widget read a local cost ledger. Counting starts when the first of them is on your status line; earlier sessions are not included, and a session that is already running counts from that point on. Totals are Claude Code's own cost estimates (`cost.total_cost_usd`) and will differ from your bill.

Resuming or forking a session, `/clear`, compaction, `/login` and two terminals on one session are each counted once. When two terminals keep working on the same resumed session, the ledger cannot tell them apart (Claude Code sends no per-process id), so their spend is undercounted, by up to about a third when both totals stay close. While the ledger is being rebuilt (for example after `ledger/summary.json` was deleted), totals end in `…` and may be low for a few refreshes. The ledger is `ledger/YYYY-MM.jsonl` under the cache dir (mode 0600): one line per change with the time, an account key, the session id, the project path and the session's running total. It never contains a token. Month files older than 13 months are deleted. Layouts without these widgets do not read or write it.

## Layout tips

- Put a `flex` widget between two groups to push the second group to the right edge.
- Set `merge: true` on a `text` widget to attach a custom prefix to the next widget.
- Keep GSD widgets on their own line and set `hideEmpty` on them: the whole line disappears outside GSD projects.
- `raw: true` plus a `text` widget lets you build any label style you like.
