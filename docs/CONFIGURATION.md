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

`cost-today`, `cost-week`, `cost-project` and a daily `budget` widget read a local cost ledger. Counting starts when the first of them is on your status line; earlier sessions are not included, and a session that is already running counts from that point on. Totals are Claude Code's own cost estimates (`cost.total_cost_usd`) and will differ from your bill.

Resuming or forking a session, `/clear`, compaction, `/login` and two terminals on one session are each counted once. When two terminals keep working on the same resumed session, the ledger cannot tell them apart (Claude Code sends no per-process id), so their spend is undercounted, by up to about a third when both totals stay close. While the ledger is being rebuilt (for example after `ledger/summary.json` was deleted), totals end in `…` and may be low for a few refreshes. The ledger is `ledger/YYYY-MM.jsonl` under the cache dir (mode 0600): one line per change with the time, an account key, the session id, the project path and the session's running total. It never contains a token. Month files older than 13 months are deleted. Layouts without these widgets do not read or write it.

## Live session widgets

`tool-activity`, `turn-timer`, `permission-wait`, `env-counts` and `workspace-repos` are opt-in; no preset or default layout uses them. Their options are in [WIDGETS.md](WIDGETS.md).

### Refresh interval

Claude Code runs the status line on a new assistant message, on token, permission mode, model, effort or vim changes, and on its `refreshInterval` timer (`statusLine.refreshInterval` in Claude Code's settings, not in this config). It does not run it on hook events or tool results, and not while a permission dialog is open, so time-based widgets only move on those triggers.

The time-based widgets are `turn-timer`, `permission-wait`, `tool-activity`, `usage-projection`, `limit-eta`, `limit-risk`, `cache-timer`, `clock`, `service-status` and `http`. When one of them is on your layout and no interval is set:

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

`service-status`, `http`, `provider` and the `pr` option `ci` are opt-in; no preset or default layout uses them. The status line never waits on the network: after it has printed, ccinfobar starts at most one background process that refreshes whatever is due and writes the results to the cache dir (`jobs/<key>.json`, mode 0600). The next refresh shows them. Until the first result arrives a widget stays empty, and `ccinfobar explain` says why.

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

## Layout tips

- Put a `flex` widget between two groups to push the second group to the right edge.
- Set `merge: true` on a `text` widget to attach a custom prefix to the next widget.
- Keep GSD widgets on their own line and set `hideEmpty` on them: the whole line disappears outside GSD projects.
- `raw: true` plus a `text` widget lets you build any label style you like.
