# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.0] - 2026-10-16

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
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (when set and non-empty) stops the automatic background checks: the update check, the usage fetch and `service-status`. `http` items and the `pr` CI part, which you turn on yourself, still run. `ccinfobar update` and `ccinfobar usage` still work on demand, and `ccinfobar doctor` says when it is on
- `-y` as a short form of `--yes`, and `--` to end option parsing (for example `-- -1`)
- `ccinfobar explain [widget-id]` lists every widget with its current value, where it came from (payload field, cache and its age, git, GSD or another data source) and why it is empty, including which payload field Claude Code did not send and which Claude Code version adds it (`prompt_cache` 2.1.251+, `last_miss_cause` 2.1.260+); a widget id prints details for one widget
- `ccinfobar explain --json` prints one sanitized JSON object for bug reports, with `env`, `command` and `tool-activity` widget values replaced by `<redacted N chars>`; `--scenario <name>` or `--payload <file>` picks the input (not both), and a broken config, a bare `--payload` or a `--width` that is not a positive number makes it exit 1
- `ccinfobar doctor` also shows `env`, `command` and `tool-activity` widget values as `<redacted N chars>` in its widget list
- `explain` also redacts `env`, `command` and `tool-activity` values in its text output, and `explain <widget-id>` prints text options (such as a `command` string or a `link` URL) as `<N chars>`; `--show-values` shows them, only in a terminal and never in `--json`
- `ccinfobar preview --scenario <name>` renders fifteen named situations (fresh session, context nearly full, near 5h limit, near weekly limit, many subagents, GSD project, no git repo, API key user, Bedrock user (`bedrock-user`), GLM gateway (`gateway-glm`), over budget, workspace folder, waiting for permission, service incident (`service-incident`), PR with failing CI (`pr-ci-failing`)); a bare `--scenario` lists them, and `explain`, `bench` and the editor use the same list
- The web editor's preview has a Scenario picker next to Sample data / Last session
- `ccinfobar bench` measures cold and warm render time (median, p95) against a `node -e 0` control (`--runs <n>`, where a missing or non-numeric value is an error, `--scenario <name>` for a scenario's payload and env, `--json`); the method and a baseline are in docs/DEVELOPMENT.md
- CI installs the packed package into an empty profile on Linux, macOS and Windows, renders through the exact settings command in every shell, and checks that uninstall restores the settings file byte for byte and leaves no process behind
- `usage-projection` widget: expected 5h or weekly usage at the end of the window, at the window's pace or the recent one
- `limit-eta` widget: time until a limit reaches 100% at the current pace, or `safe`
- `limit-risk` chip that turns amber or red when a limit is projected to run out before it resets
- `performance` widget with cache hit rate and average response time (`show`, `display: badge`, `hitWarn`, `timeWarn`, `showMisses`); a time from the transcript fallback (prompt to first reply) starts with `~`
- `cost-today`, `cost-week` and `cost-project` widgets: estimated cost of all your sessions today, this week or per project, from a local ledger shared by all sessions; counting starts when one of them is added, and resume, fork, `/clear` and `/login` are not counted twice; totals end in `…` while the ledger is being rebuilt
- `budget.daily`, `budget.session` and `budget.warnAt` settings (config, editor, TUI)
- `budget` widget: estimated spend against your daily or session budget, yellow from `warnAt` (80%) and red when over
- `context-percentage` and `context-bar` `basis` option (`raw`, `usable`, `reserve`) with `reserveTokens`; it replaces the `usable` switch, which still works
- `cache-timer` `showTtl` option
- `ccinfobar explain` says whether a limits value came from this session, another session or the usage API, and when a window has just reset
- `ccinfobar explain` shows the cost ledger age and says when no cost has been recorded yet
- A Claude Code plugin in this repo: `claude plugin marketplace add alpadalar/ccinfobar`, then `claude plugin install ccinfobar@ccinfobar`, gives `/ccinfobar:install`, `/ccinfobar:edit`, `/ccinfobar:doctor`, `/ccinfobar:theme` and `/ccinfobar:uninstall`. It calls the installed `ccinfobar`, has no status line or hooks of its own and never writes settings itself; `alpadalar/ccinfobar#v<version>` pins it to a release
- `ccinfobar install --hooks` adds optional Claude Code hooks (SessionStart, UserPromptSubmit, Stop, SubagentStart, SubagentStop, Notification for permission prompts, and `PermissionDenied`, which needs Claude Code 2.1.89+ and cannot block) to user settings, recorded in the manifest and checked against the Claude Code version (2.1.101+); `--hooks=permission` also adds PermissionRequest; `--dry-run` lists every hook change
- `ccinfobar uninstall --hooks` removes only ccinfobar's hooks
- `ccinfobar hook <Event>` records Claude Code hook events in a per-session log, prints nothing and always exits 0 (used by the optional hooks); prompt text, replies and tool input are never stored. It costs about 13 ms over a bare Node start (`ccinfobar bench`), and Claude Code never waits for it
- With hooks on, a new session (SessionStart `startup`) runs the daily update check and removes hook logs older than 7 days; resume, clear and compact never do, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `update: off` still turn the check off
- The web editor's Settings has a Hooks switch and an opt-in Permission requests checkbox; it is off unless ccinfobar is the active status line and Claude Code is 2.1.101 or newer
- `ccinfobar doctor` reports ccinfobar's hooks, hooks edited outside ccinfobar, hook commands whose binary is gone, `disableAllHooks` and `allowManagedHooksOnly`, and the age of the last hook event
- `ccinfobar edit --detach` starts the editor in the background, prints its URL and exits; a running one is reused and it stops after 30 minutes idle
- `ccinfobar themes --list` prints theme ids and names only
- INSTALL.md, a pinned runbook Claude can follow to install ccinfobar, pick a preset and check it with `ccinfobar preview`
- `ccinfobar bench` has a `hook UserPromptSubmit` row and prints the hook overhead
- CI validates the plugin with `claude plugin validate --strict` and checks its version against package.json, and the clean-install check also installs hooks, runs a hook in every shell and checks that uninstall restores the settings file byte for byte
- `tool-activity` widget: the running tool and this turn's tool counts (`Bash npm test · Read 4, Edit 2, Bash 1`), from the transcript (opt-in; `scope`, `mode`, `maxTools`, `groupMcp`, `showArgs`); values after `TOKEN=`-style names, `Bearer` tokens and URL passwords are masked in the argument
- `turn-timer` widget: how long the current turn has run and how long the last one took, exact with hooks and from the transcript otherwise (opt-in; `afterStop`)
- `permission-wait` widget: how long the last permission prompt in this turn waited, such as `Wait Bash 42s` (needs hooks; Claude Code hides the status line while the dialog is open, so only closed waits are shown, timed from the permission notification about 6 s after the dialog appears to the first tool result after it)
- `env-counts` widget: CLAUDE.md, AGENTS.md, rules, MCP servers and hooks in effect, read from config files without running `claude` or probing servers, and re-checked on each refresh with about one stat per folder (opt-in; the `.claude.json` project entry is found with either slash style on Windows, in any letter case on macOS and Windows, and through the main checkout in a linked worktree); plugin MCP servers, connectors and plugin hooks are not counted, and the `mcpHealth` option is reserved until Claude Code exposes MCP status
- `workspace-repos` widget: the git repos inside a folder that is not a repo, with their branches (`repos: api (main) · web (dev)`), from `.git/HEAD` files without running git (opt-in); it hides itself inside a repo or when no child folder is a repo, and `hideEmpty: false` shows `repos: —` instead
- In a workspace folder, `workspace-repos` hides the empty git widgets instead of showing `—` (option `hideGitPlaceholders`); `explain` and `doctor` say why
- `workspace-repos` option `dirty` marks repos with uncommitted changes (`api (main*)`), checked by a background job with hardened git about once a minute, never in the render path
- `install` and `doctor` suggest `--refresh 5` when time-based widgets (`turn-timer`, `permission-wait`, `tool-activity`, `clock`, `service-status`, `http` and others) are on the layout and no refresh interval is set; nothing is set automatically
- The web editor's Settings warns when time-based widgets have no refresh interval and offers a 5 s refresh that installs after you confirm
- `service-status` widget: Claude's status page indicator and the active incident (`⚠ major: Elevated errors on Opus +1`), checked in the background every 3 minutes (opt-in; `interval`, `showName`, `maxLength`); hidden when all is well (`showOk` shows `✓ Claude OK`), `components` filters by component name, and an old result gets a ` ?` for up to 30 minutes after a failed check, then hides
- `http` widget: a value from any JSON endpoint (`url`, a JSON `path` such as `$.data.balance`, `format`, `interval`, `timeout`, `decimals`), fetched in the background (opt-in). Headers and URL query values take secrets only from env vars (`Authorization=Bearer $RELAY_TOKEN`, `?key=${API_KEY}`) and send them only over https or to localhost; Claude, cloud, ccinfobar, npm and SSH variables are never sent, and GitHub tokens go only to GitHub hosts. Cross-origin redirects are refused, replies are capped at 256 KB, items with the same URL share one fetch (a new `path` on it is fetched on the next refresh), `Accept` and `User-Agent` are fixed, and the last good value stays on screen when the endpoint fails
- `pr` option `ci` adds the CI checks from `gh pr checks` (`#128 approved ✗ 2`, `● 3` while running, `✓`), refreshed in the background (every minute while checks run); skipped for GitLab merge requests and when gh is missing, not logged in or older than 2.81 for a host other than github.com; gh only runs for github.com or hosts you logged in to with gh (`*.ghe.com` included), so `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` never reach another host
- `provider` widget: Bedrock, Vertex, Foundry, Mantle, AWS, API key or the gateway (`GLM via api.z.ai`), from which env vars are set, never their values (opt-in; off for Claude logins unless `showFirstParty`)
- Model profiles: a built-in table (updated 2026-10-14) gives names, context windows, prices and currency for GLM (Z.ai, BigModel), Kimi, DeepSeek, MiniMax and Qwen models. Built-in prices apply only on the vendor's own API host; stored prices are DeepSeek's peak price, MiniMax up to 512K input and Qwen's International list price. The new `profiles` config key adds or overrides entries (`profiles.models`) or turns the built-ins off (`profiles.builtIn: false`)
- `session-cost` option `basis` (`payload`, `profile`, `auto`) shows the cost from model profile prices in the profile's currency; `auto` is recommended for gateway users, and the default `payload` keeps today's number
- `model` option `profileLabel` shows a model profile's name instead of a raw gateway model id
- The web editor's Settings has a Model profiles group (the built-in list with its date, an on/off switch and your own entries); the TUI has the on/off switch
- `ccinfobar doctor` lists background jobs (usage, update and the new sources) with their age, last error and retry time, and says when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `CCINFOBAR_NO_JOBS` turns them off
- `ccinfobar doctor` checks `http` items: literal header values (refused), env values over plain http and refused env vars (errors), plain-http URLs, bad JSON paths, and which env vars each item sends (set or unset, never the value)
- `ccinfobar explain` names the background job behind a value (`job status, 30s old, ok`), redacts `http` values, shows `http` URLs with query values and token-like path segments hidden and headers as `Name=$VAR (set)`, names the reason an `http` item is refused, and prints a `CI:` line saying why the `pr` CI part is missing (merge request, no checks, gh missing, not logged in, host not in gh, gh too old, not fetched yet)
- `CCINFOBAR_NO_JOBS=1` turns off every background check (used by `ccinfobar bench` and tests)
- Per-widget `showWhen` and `hideWhen` rules show or hide any widget by context %, usage %, cost, tokens, running agents, git repo, GSD project, time of day, weekday or provider, for example `"hideWhen": "!git"` or `"showWhen": "usage.5h >= 80 || usage.7d >= 90"`; `~N` keeps a widget from flickering at its threshold. A rule that does not parse is ignored and never blanks the line, and finding a git repo or GSD project never runs git
- `explain` and `doctor` say which rule hid a widget (`hidden, showWhen "context.pct >= 70" (context.pct = 42)`) and point at rules that are ignored because of a typo; `config set` refuses a rule that does not parse, and `install` and `doctor` suggest `--refresh 5` when a rule depends on the time of day
- The editors have a Visibility section per widget: one-click rules (only in git repos, only in GSD projects, only while agents run, context and 5h thresholds, hide on a provider, an hours range in the web editor) and checked `showWhen`/`hideWhen` fields. The web editor marks widgets a rule hides (`hidden`) or priority overflow drops (`dropped`)
- `overflow: "priority"` drops the least important widgets first when a line does not fit, instead of wrapping or cutting it; merged widgets drop together, a `text` item drops with its widget, and no `separator` is left dangling next to a dropped widget. `priority` (0-100) can be set per widget, and defaults come from the widget's category. `autoWrap` keeps working, and the panel style is not affected. `explain` shows each widget's priority and what was dropped, and `doctor` suggests `overflow: priority` for cut lines and reports lines still cut under `wrap` or `priority`
- `glyphMode`: `single-width` (emoji icons as text, fullwidth letters as ASCII), `paste-safe` (stays aligned in GitHub code blocks: no Nerd Font glyphs or links, and plain spaces in `preview`), `jetbrains` (JetBrains terminal emoji width) and `auto`; `ambiguousWidth: 2` for CJK-locale terminals. `ccinfobar preview --glyph-mode paste-safe` prints one line without saving the mode, `explain` shows values and widths as the mode renders them, and `doctor` suggests `jetbrains` in JetBrains terminals
- The editors have Overflow (cut, wrap, drop by priority), per-widget Priority, Glyph mode and Ambiguous width settings
- Themes `catppuccin-latte`, `catppuccin-frappe`, `catppuccin-macchiato`, `catppuccin-mocha`, `everforest`, `kanagawa` and `one-dark`; themes can set a `gradient` color ramp, also in the web theme builder, which now also has color slots for the Charts, Agents & tasks and Fun categories
- Bars take `"barColor": "gradient"` (colored along the theme's `gradient` ramp, stepped with 16 colors) and two new styles: `ring` (a one-cell Braille gauge) and `matrix` (a dot-matrix bar with half-cell steps)
- `activity-strip` widget: when any session of your account was busy, in 15-minute slots (the last 9 hours by default), from the local cost ledger; history starts when the widget is added (opt-in)
- Fun widgets in a new Fun category: `pet` (a small creature that reacts to context, usage and idle time), `kaomoji` (a face with a personality) and `quip` (a short line about the context or 5h window). Opt-in; no network, no telemetry and no files written
- Terminal progress (OSC 9;4): `ccinfobar install --progress` shows the context fill (or 5h usage) as the terminal tab's progress bar in Windows Terminal, Ghostty, WezTerm, ConEmu and iTerm2, through synchronous Claude Code hooks (2.1.141+). It adds about 60-110 ms before each prompt while it is on, and `uninstall --progress` turns it off and clears the bar (while a bar is still showing, the handlers stay until the next prompt has cleared it; run it again to remove them). Turning it off in an editor or by hand also clears the bar at the next prompt. Set Claude Code's `terminalProgressBarEnabled` to `false`, or the two bars flicker; ccinfobar never changes that setting
- `progress.channel: "tty"` (Linux and macOS) writes the progress bar from the status line itself, with no hook and no prompt latency; `install --progress` and the web editor add no handlers on it (and remove earlier ones), and `doctor` warns about leftover ones; inside tmux it needs `allow-passthrough` and `progress.tmuxPassthrough` (the hook channel needs `allow-passthrough` too). Inside tmux the terminal is recognised from `GHOSTTY_RESOURCES_DIR`, `WEZTERM_PANE`, `LC_TERMINAL_VERSION` (iTerm2), `WT_SESSION` or `ConEmuPID`, because tmux replaces `TERM_PROGRAM`
- `doctor` checks terminal progress: Claude Code's own bar (`terminalProgressBarEnabled`), missing or leftover handlers, unsupported terminals, the Claude Code version and tmux; `explain` shows the current progress value
- The web editor's Settings has a Terminal progress section (on/off, source, scale, warning levels, channel), and the TUI has the same options. The web switch saves `progress.enabled` together with the hook handlers and is not part of undo
- Turkish: the status line, the CLI (`--help`, `doctor`, `explain`, `preview` and the other commands), the web editor and the terminal editor, including widget names and options, themes, presets and scenarios. JSON output stays English
- `language` setting (`auto`, `en`, `tr`; default `auto`), also settable with `ccinfobar config set language tr`; `ccinfobar init --force`, preset apply and import keep it, while the web editor's Import config takes the language of a pasted config that has one
- `CCINFOBAR_LANG` forces the display language for one run while `language` is `auto`; `CCINFOBAR_LANG=auto` leaves it to the locale
- A Language select in the web editor's Settings (Auto, English, Türkçe) and a Language field in the terminal editor (`ccinfobar tui`); both switch the editor at once
- `doctor` shows the display language and where it came from, and warns about an unsupported `language` value
- `ccinfobar report`: daily, weekly (`--period week`) or monthly (`--period month`) tokens, estimated cost and active time per project, from the cost ledger and your transcripts, as a table, `--csv` or `--json`. Requests are counted once (subagents and forked sessions included), `--since`/`--until`/`--all` and `--project` narrow it, cost is an estimate at list prices (a notional price on a subscription), and an index in the cache folder keeps the totals of transcripts Claude Code deletes later. `--rebuild` re-reads everything and repairs the cost ledger summary. `--project .` is the project that holds the current folder, also from a subfolder. A narrow terminal drops columns and then prints each row on two lines, and the tokens and time of a row that also holds a session with no transcript left are marked `+` (`tokensPartial` in JSON). After a time zone change the days are cut again, and on Windows projects keep their own letter case
- `ccinfobar import ccometixline` (alias `ccline`): segments, icons, colors and separator from CCometixLine's `~/.claude/ccline/config.toml`, and the theme picked with `-t`/`--theme` in your status line command, including its nine built-in themes
- `ccinfobar import cship`: lines, `$cship.*` modules, the common Starship git and directory modules, symbols and styles, from the same `cship.toml` or `starship.toml` cship would use (the search up from the current folder stops at your home folder)
- `ccinfobar import claude-hud`: the expanded or compact layout, element order, merged groups, custom line, colors and `--extra-cmd` (only after confirmation) from claude-hud's config and override files
- The install import offer now covers CCometixLine, cship and claude-hud
- `ccinfobar import --dry-run` prints the mapping report and a preview with sample data and writes nothing; every import prints a mapping report of what was approximated or dropped, and why, including commands that cleaning changed (line breaks become spaces) and cship gaps replaced by the common separator
- `ccinfobar import --command <cmd>` reads that status line command instead of the current one. The re-run hint printed when commands or URLs are dropped passes it, so the hint still works after `install` has replaced the status line, and starts with `npx ccinfobar@latest` when ccinfobar runs through npx or a pinned copy
- A Homebrew-installed ccinfobar (its path contains `/Cellar/ccinfobar/`) never updates itself with npm: with `update` set to `auto` or `notify` the status line shows `⬆ ccinfobar <version> · brew upgrade ccinfobar` and the background updater only checks, `off` stays off, and `ccinfobar update` prints the new version and `Installed with Homebrew: run brew upgrade ccinfobar` instead of running npm
- On a Homebrew copy, `ccinfobar install` sets the status line to `<brew prefix>/bin/ccinfobar` (or `<brew prefix>/opt/ccinfobar/bin/ccinfobar` when an npm copy owns that path or the keg is unlinked), which keeps working after `brew upgrade`; `doctor` shows the Homebrew install and that it updates through `brew upgrade ccinfobar`; the web editor labels it, hides its Update button and points at `brew upgrade ccinfobar`, and its update API refuses to run npm on it
- A Homebrew formula (`packaging/homebrew/ccinfobar.rb`) and `scripts/homebrew-formula.mjs`, which fills in the version and sha256 from the npm registry after a release and checks the tarball against npm's integrity hash. It refuses versions below 0.6.3, which have no Homebrew detection. The tap is not published yet
- docs/DISTRIBUTION.md: Homebrew install and publishing steps, and the measured startup decision for a faster launcher (no new build or release channel)

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
- Re-running `install` with a new command also updates ccinfobar's own hooks
- `ccinfobar uninstall` also removes ccinfobar's hooks and still restores the settings file byte for byte when nothing else changed it
- INSTALL.md first checks `ccinfobar --version` and stops on 0.6.2 or older, which have no dry run and replace the status line without asking; a release tag that lacks INSTALL.md or the plugin marketplace fails the release check
- The plugin skills stop when ccinfobar is 0.6.2 or older, instead of running a dry run or `edit --detach` that those releases do not know
- The plugin skills pre-approve only read-only `ccinfobar` commands; `install --yes` and `uninstall` always ask for permission
- `/ccinfobar:install --no-hooks` runs `install` without `--hooks` instead of relying on the last flag winning
- `edit --detach` reuses a running editor only for the same config file and port, and two calls at once start one editor
- Only `ccinfobar [--config <file>] hook <Event>` takes the silent hook path; a command such as `ccinfobar config set hook 1` prints its result again
- `install` and `uninstall` stop with an error on an unexpected argument, such as `--hooks permission` (meant as `--hooks=permission`), instead of ignoring it
- `install --hooks` warns when the status line command runs through `npx`, `bunx` or a `dlx` runner, because every hook event would start it
- The web editor checks the Claude Code version in the background instead of freezing for up to 4 s on its first request, and turning Permission requests off writes settings.json once
- `agents` and `agent-count` use the exact subagent start, stop and type from hooks when they are installed; without hooks nothing changes
- Background checks (the update check, usage limits, the `workspace-repos` dirty marker and the new sources) run in one background process per refresh instead of one per check, and keep their results in `jobs/` in the cache dir; older cache files are still read. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` stops usage, update and `service-status`, while `http` items and the `pr` CI part (which you turned on) still run. Fetch and exec code loads only in that process, so the status line loads no more modules than before
- The editors' Auto wrap switch is now an Overflow choice (Cut, Wrap, Drop by priority); it still writes `autoWrap`, so an older ccinfobar reading the same config behaves the same
- The status line, CLI and editors follow your locale (English and Turkish): with the default `language: auto`, a Turkish locale shows Turkish. Set `"language": "en"` to keep English
- Importing from ccstatusline lists widgets whose `hide` rule (for example `zero`) cannot be reproduced
- `import` refuses source config files larger than 1 MB

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
- The web editor's settings switches have accessible names for screen readers
- For gateway providers, context widgets use the model profile's window when Claude Code reports the 200K default (or `CLAUDE_CODE_MAX_CONTEXT_TOKENS` when set), so GLM, Kimi and other 1M models show the right percentage; the `usable` and `reserve` bases keep the window Claude Code compacts at (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, else the reported size). Claude logins are unchanged and `profiles.builtIn: false` turns it off
- Text widths match how Claude Code measures them: emoji ZWJ sequences (a family is 2 cells, not 6), flags (2, not 4), keycaps and emoji with a variation selector (2, not 1), combining marks and newer wide emoji are measured correctly, while text-style emoji without one (such as 🖥) count 1 and soft hyphens 0. Lines that contain them no longer misalign, wrap early or get cut short; ASCII lines are unchanged
- Truncation no longer splits a flag, an emoji sequence or a letter from its accent
- `install`, `uninstall` and other commands print why they failed (`✗ Cannot parse ~/.claude/settings.json: ...`) when they run without a terminal, such as from Claude Code or a script, instead of exiting 1 with no message
- `uninstall` removes the `npx -y ccinfobar@latest` status line that ccinfobar 0.5.1 to 0.5.5 wrote, instead of leaving it as another tool's, and `install` over it no longer keeps it as the status line to bring back
- `npx ccinfobar@latest install` updates an older global `ccinfobar` instead of pointing the status line and hooks at it (an old copy without the `hook` command made every hook fail); if npm cannot update it, a pinned copy is installed, and the old copy is only used when nothing else installs. With `--no-global` the pinned copy is used instead of the older global one, and `install` says how to update or remove it. A global `ccinfobar` whose package is gone (such as a leftover Windows `.cmd` shim) is never used
- `uninstall` also gives back the status line of projects where you ran `install --project` but that Claude Code's project list does not include, your home folder too, so removing ccinfobar afterwards no longer leaves them running a missing command
- `doctor`, `ccinfobar usage` and the editor's Settings showed dates in the system locale's format; they now follow the display language with 24-hour times (`Oct 14, 2026, 21:07`)
- `uninstall` says "1 project" or "2 projects" instead of "project(s)"
- Boxed panel themes no longer draw the top border wider than the box when the title is cut short
- With `ambiguousWidth: 2`, boxed panels and the editor's preview box fit the width and their borders line up
- `context-graph` stops at 100% when the context window shrinks during a session (such as a switch from a 1M to a 200K model) instead of showing more than 100%, and the `context-full` scenario's graph now matches its 94%
- Saving a preset or theme in the web editor under a name with accented or Turkish letters gives a readable id (`Çalışma Düzeni` becomes `calisma-duzeni`, not `al-ma-d-zeni`)
- `ccinfobar --help` leaves at least two spaces between every command and its description (`uninstall --progress` touched its text)
- The terminal editor's settings no longer cut long field labels at 80 columns; the label column widens when there is room, and four long option labels are shorter, with the rest moved to their help
- `ccinfobar import` exits with status 1 when the import fails
- Importing a ccstatusline widget whose type is `constructor`, `toString` or another built-in object name reports it as having no ccinfobar equivalent instead of counting it and dropping it silently
- Importing a ccstatusline `link` widget keeps its URL and text, and lists the URL for confirmation like other imported links, instead of importing an empty link

### Security

- Hook log and cost ledger folders that ccinfobar creates are private (mode 0700)
- `http` items: an item that would send an env value (a header or a `${VAR}` query value) over plain http to a host other than localhost is refused instead of sending the query value in cleartext; `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `GOOGLE_*`, `GCLOUD_*`, `GCP_*`, `AZURE_*`, `CCINFOBAR_*`, `SSH_*`, `NPM_TOKEN` and `NODE_AUTH_TOKEN` are never sent, and `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` go only to `api.github.com`, `*.ghe.com` or a host gh is logged in to, so a shared config cannot send your credentials to its own host; `doctor` and `explain` hide token-like path segments (webhook and bot tokens) as well as query values; and the background worker, gh and npm start from the home folder, so a `gh.exe` or `npm.cmd` in the project folder is never run on Windows
- Windows: the Claude Code version check (`install --hooks`, doctor, the editor) runs `claude` from your home folder with `NoDefaultCurrentDirectoryInExePath`, so a `claude.exe` or `claude.cmd` in the current folder is never run; `edit --detach` starts the editor from the home folder too
- Terminal escape sequences, 8-bit control characters and bidi overrides are stripped from payload, git, transcript, subagent and GSD text, so a hostile branch name, session name or planning file cannot write the clipboard, retitle the terminal or overwrite the status line
- The `command` widget with `preserveColors` keeps only colors and safe links; clipboard writes, title changes and other terminal sequences are removed
- PR links are only clickable for `http(s)` URLs without control characters, the `link` widget rejects `javascript:` and `data:` URLs, and environment variable values are shown as plain text
- Git calls, including the ones `install` makes, ignore repo-local `core.fsmonitor` and filter drivers (`gitHardening`, on by default)
- The last payload, usage cache, history and widget cache files are created with mode 0600
- Payload, git and cache object keys are sanitized like values, only the top-level `transcript_path` is left as is, and the U+2028/U+2029 line separators become spaces
- `install`, `update` and background updates run `npm install` with `--ignore-scripts`, so no package lifecycle script runs during an update
- `doctor`, `themes` and `usage` strip terminal escapes from statusLine commands, project settings, theme files, cached usage data and update errors, and cached usage limits are sanitized before widgets show them
- Imported `command` widgets and URLs (from every importer and the install import offer) are kept only after confirmation: on a terminal you are asked (default No), `--allow-commands` keeps them, and `--yes` or a non-interactive run drops them and prints the command to re-run with `--allow-commands`. Previously `install --yes` kept ccstatusline custom commands silently
- The confirmation shows every imported command and URL in full (wrapped, long runs of spaces and invisible characters made visible); one over 2000 characters is kept only with `--allow-commands`
- Imported labels, text and separators are cleaned of terminal escape sequences and direction controls, and `javascript:`/`data:` links are dropped

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

[Unreleased]: https://github.com/alpadalar/ccinfobar/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/alpadalar/ccinfobar/compare/v0.6.2...v0.7.0
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
