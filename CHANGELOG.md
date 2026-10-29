# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Plugin: `/ccinfobar:configure` guides through preset, refresh, hooks, `--subagents` and `--hide-vim-indicator`, dry run first and a yes before every write
- Web editor and TUI: the subagent rows (`subagentLine.fields`) can be switched on/off and reordered in Settings
- Web editor Install dialog and TUI install: an option to also render the subagent panel rows (`--subagents`); Settings shows whether Claude Code runs the subagent line
- TUI: model profile entries (`profiles.models`) can be added, edited and removed in Settings, like the web editor
- Web editor: a "Show tips" switch in Settings → Appearance brings the rotating tip line back after it was hidden with ×
- `ccinfobar doctor` warns when the status line command pins a Node binary that no longer exists, for example after a Node upgrade; `ccinfobar install` pins the current one
- `ccinfobar update` falls back to the digest-checked GitHub tarball when npm cannot fetch the version, as the automatic update already did
- `updateMinAgeHours` (config, web editor Settings, TUI): with `update: "auto"`, wait until a release is at least that many hours old (1-720; the GitHub release date, or npm's publish time as fallback) before installing it; a too-new release is skipped with `reason: too-new` and installed on a later check, and `ccinfobar doctor` says so. Default `0` keeps today's behaviour; update notices and `ccinfobar update` ignore the setting
- `command` widgets can run in the background worker with `background: true` (needs `cacheSeconds > 0`): the status line shows the last result and never waits for the command; a background result is one plain line, so `preserveColors` has no effect there. The `commandBudgetMs` setting is in the web editor's Settings and the TUI. `docs/WIDGETS.md` now says plainly that a `command` runs through the shell with the status line's full environment.

- `ccinfobar subagent-line` renders Claude Code's subagent panel rows (agent type, label, token sparkline, tokens and context share, model and effort, elapsed time) from the JSON Claude Code sends, fitted to the panel width, with the parts chosen by the new `subagentLine.fields` config key; it reads only the config file and prints nothing on bad input. `ccinfobar install --subagents` sets it up with a backup and a manifest entry, `ccinfobar doctor` shows it and `ccinfobar uninstall` (or `uninstall --subagents`) removes it, restoring any entry that was there before.
- `ccinfobar install --hide-vim-indicator` sets `statusLine.hideVimModeIndicator`, so Claude Code no longer prints `-- INSERT --` under the prompt when your `vim-mode` widget shows the mode; an interactive `install` offers it when both are on, `--no-hide-vim-indicator` removes it, and `ccinfobar doctor` warns when the mode is shown twice
- `cache-miss-cause` gains `show: summary`, which shows misses/requests and the most frequent miss causes from Claude Code's histogram (`3/48 miss · tools changed ×2, ttl expired 5m ×1`; `maxCauses` picks how many); `latest` and `always` are unchanged
- `cache-timer` can append what a re-cache would cost if the prompt cache went cold (`showColdCost: tokens | usd`); the price uses the cache-write rate for the cache TTL (5m or 1h), your model profiles and fast mode, and the part is hidden when Claude Code sends no estimate or caching is off. `ccinfobar explain` now names the Claude Code version that added `miss_causes`, `recache_tokens_if_cold`, the spend-limit dollar fields, `worktree` and `added_dirs`
- `cwd` can show the folders added with `/add-dir` as a count (`+2 dirs`) or as names (`+shared-lib +docs`, at most five) with the new `addedDirs` option; off by default
- The background worker now removes per-session cache files (transcript, subagent, git, jj, width and similar entries) that have not been used for 30 days, and deletes the old `agent2-*` subagent cache files right away because they could hold unmasked tool arguments. Account usage and update state are never removed
- Theme rotation: the new `themeRotation` config key switches the status line between a pool of themes every hour, day, week or N minutes, in order or in a fixed shuffle, and can pin a theme per weekday. It follows the local clock, stores nothing and is off unless you set it. Set it with `ccinfobar theme rotate <id...> [--every hour|day|week|<minutes>] [--shuffle|--cycle] [--weekdays mon=nord,...]` (`theme rotate off` turns it off), in the web editor's Settings (**Theme rotation**) or in the TUI's settings (there the rotation change and order fields wait until a theme is added). `ccinfobar theme` and `ccinfobar doctor` show the rotation and the next change; doctor warns about ids that do not exist. Catalog and marketplace apply keep it, and the theme gallery and catalog previews still show their own theme
- Jujutsu (jj) widgets: `jj-bookmarks`, `jj-workspace`, `jj-revision` (short change ID), `jj-description` and `jj-changes`. They read with `--ignore-working-copy`; `jj-changes` counts the last snapshot unless you set `snapshot: true`, which snapshots the working copy on every refresh. jj only runs when a `.jj` folder is found above the working folder, and each call is bounded by `CCINFOBAR_JJ_TIMEOUT` (default 1 s, 2 s on Windows). Read-only jj results are cached until the next jj operation, a missing `jj` is remembered for 5 minutes and a timeout pauses jj for a minute. The new `git-is-fork` widget shows ⑂ when the `origin` remote and the `upstream` (or `fork`) remote point at different repos, read from local git config only; it hides outside a fork, and `showParent` names the parent like `git-repo` (last two path segments). `git-repo` has a new `ownerOnlyWhenFork` option. `ccinfobar import ccstatusline` now maps all these widgets, the `no-jj` and `not-fork` hide states and the fork symbol instead of dropping them
- `ccinfobar install` suggests a refresh interval when hourly or minute theme rotation over more than one theme is configured
- Web editor: double-click a widget in the palette to add it to the end of the active line, now marked in the lines area (the `+` button does the same)
- Web editor: `Ctrl`/`Cmd` + `C`, `Ctrl`/`Cmd` + `V` and `Ctrl`/`Cmd` + `D` copy, paste and duplicate the selected widget with all its options, style and rules. Each paste is one undo step, the shortcuts never fire inside text fields or over selected page text, and `Ctrl`/`Cmd` + `Alt` + `C`/`V` still copy and paste only the style
- Web editor: drag the preview's right edge to resize it (40 to 400 columns, synced with the width slider), double-click the edge to reset it to 130
- Web editor: a rotating tips line under the lines shows shortcuts. It pauses on hover or focus, does not rotate when the system asks for reduced motion, and can be hidden for good
- Share codes: `ccinfobar share` prints a `ccib1:` code (compressed, base64url) with your layout and theme and none of your personal settings. Command, HTTP, link and env widgets are removed unless you pass `--include-commands`, and `--json` prints the code with its size and what was removed. `ccinfobar edit --open <code>` (or `ccinfobar edit <code>`) opens the editor with it loaded and unsaved, and `ccinfobar catalog apply <code>` writes it with the usual consent, `--dry-run`, `--json` and backup. A damaged, oversized or unknown-version code is refused before anything starts. `ccinfobar edit <word>` that is not a share code explains `--port`, `--open` and `ccinfobar share`
- Web editor: **Share** shows the share code for the current config with its size, copies it and lists the removed command, HTTP, link and env widgets, with an **Include commands and links** switch. **Open…** takes a pasted code or a link ending in `#c=<code>`, and a code pasted into **Import** works too. Opening asks about every command, link and env widget like a catalog apply, installs an embedded theme into `themes/`, and leaves the config unsaved (undo works)
- Automatic updates now check the new version (`--version` and a test render) before keeping it and roll back to the previous version on failure, including when `--version` or the test render hangs; a rejected version is not retried; if the restored version's own check cannot finish on a slow machine, `doctor` reports the rollback as unverified instead of failed and still names the reinstall command. `ccinfobar doctor` and the status line say when that happened
- `git-worktree` can show the worktree's branch, original branch, path or original directory (`show`), shortened like `cwd` (`style`, `segments`), and append the branch it was created from (`showOrigin`); without options it shows the name as before
- `spend-limit` gains `show: amount | percent | remaining | both`, `showPeriod` (`/day`, `/wk`, `/mo`) and optional threshold colours (`thresholdColors`, off by default)
- `sandbox` widget (Session & model): a chip when the effective Claude Code settings layer enables the sandbox, with `showOff` and `showStrict`; reads only the settings files, never `~/.claude.json`, voice or account data; not in any preset

### Changed
- Turkish: `cache-miss-cause` translates the known prompt-cache miss causes (tools changed, system prompt changed, TTL expired 5m/1h, likely server side); unknown names stay as Claude Code sends them, humanized. English output is unchanged (owner decision 2026-10-28)
- The `fun` category (pet, kaomoji, quip) is listed last in the web editor palette, the TUI palette, `ccinfobar widgets` and docs/WIDGETS.md; the widgets themselves are unchanged (reason: owner decision 2026-10-28, they stay in core but should not sit among the working categories).
- `workspace-repos` and the `git` rule metric no longer treat every folder as inside a repo when `~/.git` exists (reason: a dotfiles repo in the home directory made `workspace-repos` hide itself everywhere and `showWhen: git` always true); both also honour `GIT_CEILING_DIRECTORIES`. The git widgets still show what git itself finds.
- All `command` widgets of one refresh now share a time budget (`commandBudgetMs`, default 3000 ms); each still has its own `timeout`, and once the budget is spent the remaining command widgets show their cached output or nothing instead of waiting one after another (reason: a slow or hanging command no longer stalls the whole status line). Layouts with up to three default-timeout commands see no difference.

- The cost ledger (`ledger/YYYY-MM.jsonl`) now stores a short hash of the project folder instead of the folder path (reason: privacy); existing ledger lines keep counting toward `cost-project`, and `ccinfobar report` names projects from your transcripts, showing 'unknown project' only for sessions whose transcript is gone and whose ledger lines are new.
- `spend-limit` shows the used percentage (`63%`) when Claude Code or a gateway sends only `used_percentage` and no dollar amounts, instead of staying empty; with the dollar fields it still shows `$12/$50`
- Resuming a session with a very long transcript no longer stalls the first refresh: ccinfobar reads about 8 MB per refresh, shows the totals so far and catches up over the next refreshes (`ccinfobar explain` still reads everything).
- The `agents` widget now reads subagent transcripts incrementally (about 1 MB per agent and 4 MB in total per refresh) and caches the subagent listing, so a busy subagent no longer slows the status line.
- `ccinfobar install` no longer imports the previous status line's layout over an existing ccinfobar config unless you answer yes (the default is now no) or pass `--import`; `--yes` alone no longer imports in that case, and the import runs only after the settings were written
- `jj-changes` no longer snapshots the working copy by default, so a status line refresh never writes to the jj operation log; set `snapshot: true` to get the old behaviour
- Git widgets reuse the last `git status`/`diff` result for about 2 seconds, provided none of `.git/HEAD`, `index`, `packed-refs`, `config`, the branch ref or `logs/HEAD` changed, so most refreshes in a repository spawn no git process; worktrees, submodules and old git without `--show-stash` keep working. The cache lives in the cache dir as `git-*.json`
- The terminal width is probed (`ps`/`stty`) only when neither the payload nor `COLUMNS` carries one and `maxWidth` is not a fixed number. A known width is reused for a minute and a failed probe for ten, and `/dev/tty` is asked first on Linux and macOS. A numeric `maxWidth` skips the probe entirely.
- Upgrading rebuilds the per-transcript token cache once because its format changed: the first refresh after the update does one budgeted rescan, and very long transcripts show partial totals until it catches up
- The `agents` widget's cache files are now `agent3-*.json` and `agents-dir-*.json` in the cache folder; the background worker deletes the old `agent2-*.json` files (see the worker cleanup note above)
- When `ccinfobar install` replaces another tool's status line after you confirm, the other keys of that `statusLine` entry are carried over into ccinfobar's entry instead of being dropped (`type`, `command`, `padding` and `refreshInterval` are ccinfobar's)
- The automatic update no longer falls back to installing the GitHub release tarball when GitHub publishes no checksum for it: nothing is installed, `ccinfobar doctor` says so and the update is retried at the next check; a rollback whose reinstall has no checksum is recorded as failed instead of installing unverified bytes (reason: never install unverified bytes). Manual `ccinfobar update` uses the same digest-checked fallback and never installs a tarball without a checksum.

### Fixed
- `doctor`: with several managed settings files, the later file (`managed-settings.d/*.json` after `managed-settings.json`, alphabetical) now wins for the progress-bar and editor-mode checks, as in Claude Code
- The web editor no longer shows the "editor stopped" banner after a single failed request; it waits a second, pings the server once and shows the banner only when that ping fails too (a transient failure shows a short toast instead)
- The per-session hook log (`install --hooks`) is capped at 2 MiB: when it is full the current file becomes `<session>.old.jsonl` and a new one starts, so a long session no longer grows the cache without bound; turn and agent counts stay exact across the switch
- `ccinfobar install` and `uninstall` on a `settings.json` with a comment or a trailing comma now say it must be strict JSON and name the line and column; nothing is written and no backup is made
- A status-line refresh that starts while `npm` is replacing ccinfobar's files retries loading itself once instead of failing immediately; a refresh caught mid-swap can still print nothing once, the next one runs the new version
- `ccinfobar update` now verifies the new install the same way the automatic update does and rolls back to the running version when the check fails; it prints the outcome and exits with status 1 in that case, `ccinfobar doctor` and the status line show the rejected version, and the web editor's update button reports a rejected version instead of claiming success
- Each refresh now writes the last-payload file only when the payload changed (at most once per 5 s), reads the usage-limits store once and reads each background-job result once (once more only right before a worker would be started), instead of repeating the same file operations; the saved payload the editor preview and `explain` use can therefore be up to 5 s old. The limits store is still read once more right before a write, so concurrent sessions keep merging
- The status line reads at most 4 MiB from stdin and treats a larger payload like invalid JSON (short message, exit 0) instead of buffering it, and it releases stdin after the read or the 3 s timeout, so a refresh whose pipe is never closed no longer lingers
- The `agents` widget counts every usage entry of a subagent transcript that has no message or request id instead of collapsing them into one
- git config keys that contain a space (such as `filter.a b.clean`) are now read correctly when ccinfobar disables repo-local filters; the git cache is rebuilt once after the update
- Two background workers can no longer both take over the same stale lock: a stale lock is moved aside and checked before a new one is created
- A marketplace publish whose answer was lost no longer leaves the entry stuck on a conflict: the next publish links the existing marketplace entry when it holds the same content, otherwise it publishes under `<slug>-2` and says so; a planned slug that another of your marketplace entries already uses is suffixed before publishing and the plan says so
- Theme and preset ids that are Windows device names (`con`, `nul`, `com1`, `lpt1`, with or without an extension) are refused on every platform so a shared config stays portable; installing a marketplace theme named `Dracula` uses the builtin `dracula` instead of writing a copy. Existing files with such names still load on Linux and macOS; on Windows such an id is treated as missing, so a shared config with `theme: con` can no longer make the status line wait on the console
- `ccinfobar import ccstatusline` turns `git-insertions` + `git-deletions` (and the jj pair) into one changes widget instead of two and says so in the import notes; `jj-root-dir` is noted as approximated by `project-dir`
- The update notice (`update: notify`) no longer pushes the last status line past the terminal width; when it does not fit it moves to its own line
- `--flag=false`, `--flag=0`, `--flag=true` and `--flag=1` on switch flags such as `--yes`, `--detach` and `--open` are read as booleans, so `--yes=false` no longer confirms and `--detach=1` detaches
- `--width`, `--refresh` and `--port` now accept only whole numbers in range (1-10000, 1-86400, 1-65535); an invalid or missing value prints a usage error and exits non-zero instead of being silently accepted (previously `--width abc` rendered without a width and `--refresh 0` dropped the interval)
- A background `command` that runs up to its longest timeout can no longer be started a second time by the next refresh: the job lock is now held longer than the job may run.
- Links a marketplace reports for a version held for review are cleaned of control and bidirectional characters before they are saved in the catalog.
- `ccinfobar import` no longer offers an import for a command that only contains a tool's name inside a longer word or folder (for example `starship-claude-tools/run.sh` or `my-byebyecode-wrapper`); the tool must be one of the command's own words, as a program name, package name or install folder.
- A `command` widget with `background` set as the string `"true"` (a hand-edited or imported config) now runs in the background worker; it used to show nothing because the widget and the worker disagreed on the value.
- Admin review of a held marketplace version now shows that version's own name, description and columns (not the live entry's) and lists the links it adds, so an admin approves what they saw.
- The marketplace Worker refuses an overwrite (`409`) while a held version of the entry waits for review, like a new version does, so approving later cannot publish a document whose hash no longer matches the live body.
- The marketplace Worker now answers `503` for publish, new version, overwrite, withdraw and sign-in when its `WRITES` or `SIGNIN` rate limit binding is missing (it used to run unlimited without any sign), and `/v1/meta.json` lists the configured bindings under `limiters`; `ALLOW_OPEN_LIMITERS=true` keeps the old open behaviour for self-hosted development.

- The subagent panel line no longer hides a running agent whose row would be empty (Claude Code keeps its default row), fits very narrow panes instead of assuming 120 columns, and honours `glyphMode` and `ambiguousWidth` when measuring.
- `install --subagents` keeps extra keys on an existing ccinfobar `subagentStatusLine`, `install --yes` never waits on the vim-indicator offer, `uninstall --subagents --project` no longer removes the project status line, and `--hide-vim-indicator` is ignored with `--project` with a notice.
- A detached web editor (`ccinfobar edit --detach`) no longer shuts down while its tab is open: the page pings it every five minutes while visible, and if the editor has stopped, saving shows an "editor stopped" notice with an Export button instead of a bare fetch error. Only requests with the right token count as activity.
- In the web editor, Delete or Backspace while a slider, switch, button or inspector field has focus no longer removes the selected widget, and Tab no longer leaves an open dialog (the page behind a dialog is inert)
- `install`, `uninstall`, the hooks commands and the background update takeover now update ccinfobar's manifest under a lock and re-read it first, so two of them running at once no longer lose each other's entries; a command that cannot get the lock within five seconds reports it instead of overwriting.
- When Claude Code rewrites `settings.json` at the same moment as `ccinfobar install` or `uninstall`, the backup is now taken from the bytes that were read before the change check, the check runs right before the file is swapped, and a retried attempt leaves no extra backup behind.
- Token and cost totals no longer stay wrong when a transcript file is replaced by one of equal or larger size (for example after `--resume` into a reused path); ccinfobar now checks the file identity and content anchors and re-reads from the start.
- Git widgets hide instead of running `git status` without the repository's filter protections when `git config` itself fails or times out
- Windows: the background update and the `where`/`npm` lookups run from a defined safe folder (home, temp, then Node's folder) instead of falling back to the current folder when neither home nor temp exists
- `git-is-fork` with `showParent` keeps the host in the parent label when the two remotes live on different hosts, so it no longer prints the same name as the repo itself
- Windows: PATH entries written with forward slashes (`C:/Program Files/Git/cmd`) are accepted when looking for `git` and `jj`, so those widgets no longer disappear
- `install` and `uninstall` decide whether the status line is ccinfobar's by comparing only the keys ccinfobar owns (`type`, `command`, `padding`, `refreshInterval`), so a hand-added key such as `hideVimModeIndicator` no longer makes the next install lose your original line. Uninstall still restores it and still never removes another tool's status line
- `--help` and the README now list `ccinfobar editor`, `ccinfobar update --check` and the internal `ccinfobar repos` command
- Docs and CLI hints now describe Claude Code's real refresh triggers (session start, assistant message, `/compact`, permission and vim mode, command change, `resets_at`, `expires_at`, `refreshInterval`) and say the line is hidden, not paused, during permission prompts and the help menu; the README names which usage-limit fields come from the payload and which from the usage-API fallback
- `install` keeps other keys inside Claude Code's `statusLine` object (such as `hideVimModeIndicator`) when it rewrites the command
- Minute-based theme rotation now restarts at local midnight as documented, so `every: 7` does not drift across days
- Usage widgets no longer print `Infinity%` or `NaN%` when the payload carries a non-finite `used_percentage`; they show the loading state instead
- `git-is-fork` compares the remote host and the full path, so GitLab subgroups and same-path repos on different hosts are detected correctly (`git-repo` output is unchanged).
- `git-changes` hides when `git diff` times out or there is no commit yet instead of showing `+0 -0`, and has a new `hideZero` option.
- `git-ahead-behind` hides when the branch has no upstream instead of showing `↑0 ↓0`.
- `git-stash` hides when git does not support `--show-stash`.
- `git-conflicts` has a `hideZero` option.
- `model`'s `showId` option treats the string `"false"` as off.
- `showWhen`/`hideWhen` rules on `cost.*` and `usage.*` metrics now work on every widget type (the ledger or limits store is turned on by the rule itself), and `ccinfobar explain` says when a rule's metric has no data source.
- Secret masking no longer slows the status line on very long tool arguments or subagent descriptions: `maskSecrets` caps its input at 1024 characters and every rule runs in linear time (the URL-credential rule was quadratic on long words).
- `ccinfobar install` offers to import a previous status line only when the command really runs a known tool (binary, script or npm package name as an argument), so a wrapper such as `my-ccstatusline-wrapper` or a script under a `ccline-tools` folder no longer triggers the offer; `ccinfobar` itself is recognised only as the binary or package.
- `ccinfobar doctor` run from your home folder no longer reads `~/.claude/settings.json` a second time as a project settings file; its `disableAllHooks` warning was printed twice

### Security

- The web editor page is served with a Content-Security-Policy that allows only its own inlined script (by hash), forbids framing and form posts, and the editor compares its session token in constant time.
- Marketplace: a trusted publisher's new version that adds a link to a host and path the live version did not have is held for admin review (`202 pending`, reason `new-link`) while the entry stays live at its approved version; the review flow (`catalog admin pending|show|approve|reject`) covers it. The documentation now states that the first approval trusts a publisher, what the data-only rule still prevents and how reports and takedowns work.
- Catalog: after a version is held for new links, `catalog publish` says why it waits and names the hosts (English and Turkish), the local review state is kept until the marketplace lists the version as approved, and `catalog admin pending` shows held versions as `new version N (new link: hosts)`.
- The marketplace Worker refuses write and sign-in floods at Cloudflare's rate-limit bindings (`WRITES`, `SIGNIN`) before reading the body or touching the database, so unauthenticated junk requests no longer cost D1 writes.
- Marketplace moderation: approving an entry enforces the same live caps as publishing (`413 over-quota` when full), and the sign-in limit now counts failed attempts per address and successful sign-ins per handle, so a shared network address is not locked out by a neighbour's failed attempts.
- Marketplace and catalog names, descriptions, authors and notes are stored and shown without zero-width, bidi-mark, BOM and tag characters (U+200B–200F, U+2060–2064, U+FEFF, U+061C, U+E0000–E007F), on your machine and on the marketplace Worker; entry content and its hashes are unchanged, so published entries keep verifying.
- The GitHub tarball fallback of the updater checks the release's published sha256 digest when GitHub provides one, and stops before npm runs on a mismatch.
- The `agents` widget and its cache now mask tokens, passwords and URL credentials inside subagent tool arguments and show file names instead of full paths, with the same rules as the running-tools display, and subagent descriptions are masked before they are shown or cached; masking (running-tool arguments and `agents` rows, descriptions and cache files) now also hides `curl -u`/`--user` passwords, `--password <x>`, `Authorization`/`X-Api-Key`-style header values and bare `sk-`, `ghp_`/`github_pat_` tokens; the old `agent2-*` cache files are no longer read.
- `env` widgets now need the same consent as command, HTTP and link widgets wherever a layout comes from outside (import, `catalog apply`, share codes, editor Open…/Import, marketplace install); without it they are dropped, so a pasted layout cannot show an environment variable.
- Share codes keep only `http:`/`https:` links; other schemes (`file:`, `ftp:`, `vbscript:`, `javascript:`, `data:`) are dropped at decode and named at the consent step.
- On Windows, git and jj are now run by the absolute path found in `PATH` (`.com` then `.exe`) and never from the repository folder, so a repository that ships its own `git.exe` or `jj.exe` can no longer run it during a refresh or `ccinfobar install`. When neither is on `PATH` the git and jj widgets hide instead of falling back to the bare name. Linux and macOS are unchanged
- On Windows, ccinfobar sets `NoDefaultCurrentDirectoryInExePath=1` for itself and the programs it starts (unless you set it), and runs `where`, the `npm.cmd` fallback and the browser launch of `ccinfobar edit` from a safe folder, so `where`, `npm` and the `command` widget's shell no longer look in the current folder first; a script in the current folder needs `.\script.bat`
- Marketplace content, config files, share codes and status line payloads nested deeper than 64 levels are refused with a clear error (`400 invalid` on the marketplace Worker, a config issue, a corrupt share code, an ignored payload) instead of overflowing the stack.
- The catalog folder (which holds your marketplace token in `credentials.json`) is now created readable by your user only on Linux and macOS, `ccinfobar catalog login` tightens an existing folder before writing the token, and `ccinfobar doctor` warns when the folder is readable by other users.

## [0.8.2] - 2026-10-20

### Added

- Preset and bundle entries in the catalog and the marketplace remember the preview width they were saved at (`cols`): **Save current as…** records the editor's width, `catalog save --cols <n>` (40 to 400) sets it from the CLI, and an update without one keeps the previous width. Themes carry no width. Previews render at that width (the hover preview shrinks a wide one to fit the window), applying an entry sets the editor's preview width to it, cards and details show an "N cols" tag, and `catalog list`/`show` (also `--remote`) print it. Installs copy it, installing the same content again picks up a changed width, and publishing sends it only to a marketplace that advertises `capabilities.cols`; the width is metadata, so changing only the width publishes no new version. The public marketplace stores it in a new nullable D1 column (migration `0009_entry_cols.sql`)

### Changed

- The editor's width slider goes up to 400 columns (was 240)
- The marketplace cache is fetched again once after the upgrade, so entries cached by 0.8.x show their width

## [0.8.1] - 2026-10-20

### Added

- Marketplace cards and the marketplace details dialog show a live preview of your config with the entry applied, as local cards do; point at a preview or move keyboard focus to a card to see it full size. Each shown entry's latest version is downloaded once, checked against the hash in the index and validated like an install, at most 24 entries per request and 4 downloads at a time, only when a marketplace tab is shown or after **Refresh**

### Changed

- The Marketplace page splits the marketplace into **Bundles**, **Presets** and **Themes** tabs (Bundles opens first), followed by **User** and **Built in**. The three tabs share one cached list and one **Refresh**, so switching between them sends nothing
- The web editor no longer shows the address of the shipped marketplace; it says "ccinfobar marketplace" in the publish, sign-out and Marketplace texts. A marketplace you set yourself is still shown by its address

## [0.8.0] - 2026-10-20

### Added

- Nine built-in presets for `ccinfobar init <id>`, both editors and the catalog, in English and Turkish: `cost` (session, daily and weekly cost with a budget bar), `limits` (5h and weekly limits with pace, projection and resets), `git` (repo, branch, sync, staged/unstaged files, stash, worktree, PR), `workspace` (every repo in a folder of projects), `compact` (one dense line), `two-line` (a balanced two-line layout), `agents` (turn timer, tools, subagents, permission waits, tasks), `charts` (sparklines) and `session` (session stats). Existing presets are unchanged
- A System catalog with 15 ready preset + theme bundles, in English and Turkish: Mocha cockpit (Cockpit + Catppuccin Mocha), Nord minimal, Dracula arrows (Powerline + Dracula), Gruvbox git, Tokyo limits, Mono compact (no colors, plain text style without powerline glyphs), Everforest repos (Workspace), Kanagawa agents, Rosé Pine 2-line, One Dark cost, Solarized GSD, Panel dashboard (boxed), Paper default (light terminals), Neon charts and Amber session, plus every built-in preset and theme as its own entry
- A page in the web editor called Marketplace (`ccinfobar edit`, **Marketplace** button; the `ccinfobar catalog` command keeps its name) with Marketplace, User and Built in tabs: with a marketplace on, the Marketplace tab opens first and shows only the marketplace entries; User holds your entries with **Save current as…**, **Publish…** and the GitHub sign-in, and the built-in entries show only in the Built in tab, grouped as bundles, presets and themes, each with a live preview. The Apply button applies an entry, `Ctrl+Z` undoes it, and nothing is written until you save. Command, HTTP, link and env widgets in your own entries are listed first and dropped unless you keep them, as in `catalog apply`. A bundle's own theme is installed first, under a `-2` id if a different theme already has that id; a theme that looks the same, such as the user theme the bundle was saved from, is reused
- **Save current as…** on the User tab of the Marketplace page saves your setup as a preset, a theme or a preset + theme bundle with a name, a description and an author, and the author is remembered for the next save. **Share to marketplace** is on by default and can be switched off. If the name already exists, choose Update (adds a new version and keeps the history) or Overwrite (replaces the current version), with an optional note
- Your entry cards have Version history with Restore (which adds a new version), Share / Stop sharing, and Delete with a confirmation; deleted entries go to the catalog trash. Preset and theme files that are not catalog entries (labelled Preset file and Theme file) get the same actions, and deleting one also moves its old file to the trash, except a theme file your config uses, which stays with a note
- `ccinfobar catalog list|show|history`, in English and Turkish: `list` shows your saved entries (and presets/themes saved before the catalog) first, then the built-in bundles, presets and themes, with ref, version, author and publish state (`--kind preset|theme|bundle`, `--user`, `--system`); `show <ref>` prints an entry's details and a preview of your config with it applied (`--scenario`, `--width`) and never writes anything; `history <ref>` lists versions with time, note and restores. Refs are a built-in `bundle/nord-minimal`, your entry id or `<kind>/<slug>`, or a unique bare name. `--json` gives one English object with `schema: 1`
- `ccinfobar catalog apply <ref>` applies a built-in or saved entry in one step. Only the layout and/or theme change, and your budget, profiles, language and other personal settings stay. The previous config is backed up, and an embedded theme is installed, as `<id>-2` if a different theme already uses the id. Command, HTTP, link and env widgets follow the import consent rules (`--allow-commands`, a prompt in a terminal, dropped with `--yes` or without a terminal)
- `ccinfobar catalog save <name>` saves your current setup as a bundle, preset only or theme only (`--kind`), with `--description`, `--author` (remembered for next time), `--note` and `--no-share`. A name that already exists needs `--update` (adds a version) or `--overwrite` (replaces the latest version); in a terminal it asks
- `ccinfobar catalog restore <ref> <version>` restores an older version as a new one, `share`/`unshare <ref>` change the publish state, `delete <ref>` asks first (or takes `--yes`) and moves the entry to the catalog trash, `author [<name>]` shows or sets the remembered author, and `endpoint [<url>]` shows where the marketplace endpoint comes from (environment, set by you, default) and checks and sets it without sending anything; `endpoint --off` switches the marketplace off and `--clear` returns to the default. Built-in entries are read-only. Every catalog write command supports `--dry-run` and `--json` (English)
- `ccinfobar catalog publish [<ref>...]` sends your shared entries to the marketplace. It first prints exactly what goes out for each entry (action, name, description, author and the content as JSON), the endpoint and, before a first publish, the publisher handle it registers, and sends only after you confirm in a terminal or pass `--yes`. The review reads the marketplace's meta.json, so the action shown is the one the server will do, and after you confirm the plan is made again: if an entry changed meanwhile, nothing is sent and the new list is shown, and each entry is sent only while it is exactly as reviewed; it runs even with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set because you asked for it. `--dry-run` shows the plan and sends nothing, and with the marketplace off nothing is sent and entries stay waiting to publish. Results show per entry (published vN, withdrawn, or the reason). Entries whose names map to one marketplace id, such as a preset and a theme both called Nord, are published as `nord-preset` and `nord-theme`. Unshared entries are withdrawn on the next publish; withdrawn ids stay reserved, so sharing a withdrawn entry again is refused with a note to save it under a new name. `--json` prints one English object
- `ccinfobar catalog publisher [<handle> | --forget | --check]` shows or sets the publisher handle a first publish registers on a self-hosted marketplace, or forgets the handle and token there; the editor's publish review has the same field. Handles and tokens are kept per marketplace endpoint (origin and path). On a marketplace with GitHub sign-in the handle comes from GitHub, so setting one is refused, and `--check` shows your marketplace account and refreshes the review state of your entries
- `ccinfobar catalog list --remote` and `catalog show <publisher/slug> --remote` browse the marketplace, with the author next to the publisher handle, the version history, and the commands or URLs an entry would run or open. The list uses a 24-hour cache and shows when the marketplace was last checked; `--refresh` checks again with one small request, and if the marketplace cannot be reached, the saved list is shown
- `CCINFOBAR_MARKETPLACE_URL` sets the marketplace endpoint for one run and wins over the stored one; `CCINFOBAR_MARKETPLACE_URL=off` switches the marketplace off for one shell
- With the marketplace on, the User tab of the web editor's Marketplace page has a **Publish…** button. Its review lists every entry that would be sent with its action, kind and exact payload as JSON and names the endpoint; nothing is sent until you click Publish there, and if the entries changed since the review opened, the new list is shown and nothing is sent until you confirm again. The result is shown per entry, and the cards change to Published vN or Withdrawn
- A Marketplace tab in the Marketplace page, only while the marketplace is on, lists marketplace entries with author, @publisher and version; each entry opens its version history and the commands or URLs it would run or open, with **Install** and **Report…**. Install lists every command and URL the entry keeps and installs only what you reviewed, Report needs a sign-in, and the tab has a **Refresh** button with the time of the last check. Entries installed from the marketplace show "From the marketplace" and cannot be shared as your own. The editor never contacts the marketplace on its own. With the marketplace off the page has no Marketplace tab, opens on User, says how to turn the marketplace on, and sends nothing
- `ccinfobar catalog install <publisher>/<slug>[@version]` installs a marketplace entry into your catalog. It checks the entry's hash and asks about its commands and URLs first (`--yes` skips the question, `--dry-run` writes nothing, `--json` for scripts). Applying it stays a separate `ccinfobar catalog apply` step, and `catalog list` and `catalog show` mark the entry "From the marketplace"
- `ccinfobar catalog login` signs in to the marketplace with GitHub (device code, no password, GitHub token never stored); `--open`/`--no-open` control opening https://github.com/login/device, Ctrl+C stops waiting. `ccinfobar catalog logout` signs out (revokes the marketplace token on the server when it can and forgets it on this computer). On a marketplace with GitHub sign-in, `ccinfobar catalog publish` asks you to run `catalog login` first
- The web editor's publish dialog can sign in with GitHub. It shows the code and the github.com/login/device link and can be cancelled. The User tab of the Marketplace page has the same **Sign in with GitHub** button, and signed-in users can sign out there or in the publish dialog
- On the GitHub-backed marketplace a new publisher's first entry shows "Waiting for review" (after publish, in `catalog list`, `catalog show` and on its card in the editor) until an admin approves it
- `ccinfobar catalog report <publisher>/<slug> --reason "…"` reports an entry to the marketplace admins (signed in, once per entry). The admin commands (`ccinfobar catalog admin pending|show|approve|reject|remove|ban|unban|reports|resolve`) are documented in docs/MARKETPLACE.md
- The ccinfobar marketplace server: a Cloudflare Worker with a D1 database (free, open source and non-commercial), speaking the same protocol v1 as the reference server. Publishers sign in with GitHub, a new publisher's entries wait for an admin's review, signed-in users can report entries, and admins approve, reject, remove and ban. Reads answer `304` to a matching ETag, published versions cannot be overwritten, and `GET /` says that published content is public and how to ask for removal. It is not part of the npm package and runs at https://ccinfobar-market.alp-adalar.workers.dev
- The marketplace at https://ccinfobar-market.alp-adalar.workers.dev is the default endpoint; ccinfobar contacts it only when you browse, install, publish, sign in or report, never during a status line refresh or in the background. `ccinfobar catalog endpoint --off` (or `CCINFOBAR_MARKETPLACE_URL=off`) switches it off, and an endpoint you set wins
- `ccinfobar --help` lists the catalog commands
- A reference marketplace server for self-hosting, built with `node scripts/build.mjs --market` into `market/ccinfobar-market.mjs` (`--data`, `--port`, `--host`, `--no-overwrite`). It supports publish, versions, overwrite, withdraw, rate limits and a paged index (500 entries per page, up to 5000), and the client reads back everything it accepts (index pages up to 1 MiB, entry and version documents up to 320 KiB). It is not part of the npm package
- docs/CATALOG.md, a user guide to the Catalog: kinds, tabs, applying, saving with update or overwrite, version history, sharing states, where files live and every `ccinfobar catalog` command
- docs/MARKETPLACE.md: marketplace protocol v1 with the sign-in, account, report and moderation routes, client rules, the requests budget, the Cloudflare server, sign-in, moderation, privacy, a runbook for deploys, migrations, moderation, backups with D1 Time Travel, secrets and free limits, how to self-host the reference server with its limits, and the serving decision (Cloudflare Workers + D1 with GitHub sign-in, decided 2026-10-17) with dated costs and sources
- The README has a Catalog section with the 15 bundles and the `catalog` commands and a Marketplace section, and docs/CONFIGURATION.md lists the `catalog/` folder and `CCINFOBAR_MARKETPLACE_URL`
- `ccinfobar import` reads 17 more status lines and the `ccstatusline-zh` alias, each from the file the tool itself reads, with the same report of what was imported, approximated and dropped, `--dry-run` and consent step, in English and Turkish: `best-claude-hud` and `byebyecode` (CCometixLine forks, themes and `-t` included; byebyecode's `line_break_after` becomes a second line), `claudebar` (segments, its 16 themes and 8 styles, `--theme`/`--style`/`--segments` in the command), `statusline-pro` (also `ccsp` or `claude-code-statusline-pro`: preset or component order, component options, icons, text colors, the classic, powerline and capsule themes), `claude-code-statusline` (also `rz1989s`: each configured line with its components and theme), `starship-claude` (`${env_var.CLAUDE_*}` modules, `palette` colors and powerline templates), `pyccsl` (the fields and flags in the status line command and its `--env` file), `coralline` (segment lines, style, clock, bars, theme and `VL_BG_*` colors, with the colors of coralline-only themes from its theme files), `claude-statusbar` (its lines from the `show_*` toggles, style and theme), `nycu-cc-statusline` (the boxed dashboard as a `tui` panel, one line per enabled row), `claude-ultimate-hud` (its lines from the `display.show*` toggles, `plan` picks the limits), `ccpet` (the pet as the `pet` widget, token, context and cost items, `#RRGGBB:bold` colors), `cc-statusline` (chongdashu: the theme, colors and features in the generated script's header), `claudeline` (its command flags on claudeline's fixed order), `claude-usage-monitor` (the `CQB_*` toggles in the `env` block of `~/.claude/settings.json`, `CQB_MAX_WIDTH`), `glauberlima-statusline` (also `glauberlima`: its one line, the theme and bar style from `statusline.toml`) and `token-tracker` (its four fixed rows and the Catppuccin, Nord or Dracula theme). Tools that have a default layout import it when no config file exists
- Importers only read: coralline.conf and pyccsl's `--env` file are parsed as plain assignments and never sourced or run, a cc-statusline script is read only for its header and never run, and secrets are never copied: byebyecode's 88code API keys, claude-code-statusline-pro widget URLs and headers, rz1989s plugin keys, ccpet's `supabase` block, and everything in settings.json except the `CQB_*` keys (`CQB_EMAIL` is dropped too)
- `ccinfobar import --help` lists every importable tool with its id, aliases, project and the file it reads (also shown by `ccinfobar import` without a tool); the usage line and `ccinfobar --help` point to it instead of naming every tool
- docs/IMPORTERS.md classifies the 41 reviewed status line projects (config, verdict, effort, import id or the reason it is left out) with notes per tool on what maps, what is approximated and what is dropped. The README's Coming from another status line section lists every supported tool with its import command and, collapsed, the 18 left out with the reason

### Changed

- New ccinfobar logo, a context gauge mark, in the web editor top bar (it follows the light and dark color scheme) and as its favicon. The README shows the logo and fresh 1920-wide dark and light screenshots of every editor screen in a collapsed Screenshots section
- `tool-activity`, `turn-timer` and `permission-wait` are now used by the `agents` preset and `workspace-repos` by the `workspace` preset; they stay opt-in and the default layout does not use them, and the README and docs/CONFIGURATION.md say so
- The Marketplace page shows compact cards with a small preview, several per row. Pointing at a preview or focusing a card with the keyboard shows it full size, and clicking, tapping or pressing Enter opens the entry's details with the full preview and all its actions. Each card has an Apply button
- The install import offer recognises every supported status line by its command, a cc-statusline script by its "Generated by cc-statusline" header, and `~/.claude/statusline/statusline.sh` by its contents, because claude-code-statusline (rz1989s) and ClaudeCodeStatusLine both install it there (the script is read, never run). It names arcade-statusline, awesome-statusline, yet-another-statusline and ClaudeCodeStatusLine instead of "a custom status line", and a best-claude-hud status line is no longer mistaken for claude-hud. Tools whose command does not name them (the NYCU-Chung/cc-statusline plugin, a glauberlima `statusline` binary outside `~/.claude`) get no offer; `ccinfobar import <id>` still works for them
- The ccstatusline importer maps more widgets: Claude status, spend limit amount, staged/unstaged/untracked file counts and worktree branch

### Fixed

- Escape in a dialog opened over another one (the Presets save dialog, or a delete confirmation over the Marketplace page) now closes only that dialog instead of every open one
- GSD widgets count a phase that the roadmap lists only as a `### Phase N:` heading (what `gsd-sdk phase.add` writes), so a newly added phase no longer shows as `Phase 11 (11/10)` at 100% with no plan count
- In the web editor's Save current as… dialog, choosing Update or Overwrite on an existing name no longer clears the entry's description or switches its sharing back on: the share switch shows the entry's setting, the entry keeps its own author unless you type another (the remembered author changes only when you change it), and the save is one write, so the entry backup still holds the version an overwrite replaced
- A restored version no longer shows its restore twice in the history ("restored v1  restored from v1"); it is marked "restored from vN" only
- `ccinfobar import <tool>` reads `--config`, `--theme` and other flags only from a status line command that runs that tool (also inside a quoted `sh -c` script). With ccinfobar's own or another tool's command it uses the tool's default files and says why, instead of reading that command's flags, so `import ccstatusline` after `install --config <file>` no longer re-imports ccinfobar's own config
- `ccinfobar import` and the install import offer no longer hang on a FIFO, or fail on a folder, where a config file is expected: anything but a regular file is skipped and the default layout is imported
- Marketplace approval works through the weakened ETags Cloudflare sends on compressed answers, admin actions without a note and resolving a report work on the live Worker, and the Worker answers `HEAD` requests
- The marketplace server no longer counts every entry on each write: the entry and tombstone caps read counts the database keeps up to date, and the index rebuild reads the live summaries from one index, so a refused or pending write costs a few database rows and one signed-in user can no longer use up the free daily read budget (migration `0002_counts.sql`)
- On the marketplace server, entries waiting for review no longer fill the shared caps: they have small caps of their own (50 in total, 3 and 1 MiB per publisher; `PENDING_ENTRIES`, `PENDING_PER_PUBLISHER`, `PENDING_BYTES`, advertised in `meta.json` under `quota`), so throwaway accounts cannot lock trusted publishers out. Banning a publisher deletes their pending entries, the 10,000-publisher cap is enforced at sign-in, and stored bytes are kept by the database itself (migration `0003_pending.sql`)
- The marketplace server's account route reads only your live and pending entries, and old rate-limit rows are deleted in bounded batches through an index (migration `0004_rate_index.sql`), so neither cost grows with the database
- A marketplace write whose index rebuild fails now still answers success instead of `500`, so a retry no longer gets `409` and the local entry stays linked; the index is marked stale in the write's own transaction and the next write, the next index read or a new six-hourly cron job rebuilds it. Rebuilds share a daily database budget (`INDEX_REBUILD_ROWS`), after which they run at most every 10 minutes, and the cron job also deletes old address salts and rate rows, so the two-day deletion promise holds even when nobody signs in (migration `0005_index_dirty.sql`); withdraws, removals and bans never wait for that budget and leave the index at once (migration `0006_takedown.sql`); one rebuild runs at a time under a lease that also claims the budget, so concurrent requests cannot multiply rebuilds (migration `0007_rebuild_lease.sql`), and the database size guard is checked again inside each write
- The marketplace server allows 60 reads a minute per address instead of 600, so one address can no longer use up the shared 100,000 requests a day on its own
- The marketplace server answers `403` to writes on another publisher's entry before looking it up, so signed-in users can no longer find out whether a hidden pending entry exists
- The marketplace's moderation log tells a publisher withdrawing their own pending entry apart from admin actions (migration `0008_moderation_actor.sql`)
- After a GitHub sign-in the marketplace server revokes the GitHub token at GitHub, so the token ccinfobar sent once is no longer valid anywhere
- Installing an older version of an approved marketplace entry whose unreviewed content was dropped says the version is no longer available and to install the latest one, instead of "entry withdrawn" (new error code `version-dropped`)
- Marketplace index pages carry the generation of their build, and ccinfobar starts the walk over when a later page comes from another build, so a write during the walk can no longer hide an entry for a day; if the pages still differ, `catalog list --remote` says entries may be missing and the list is not cached
- Marketplace entries with ids like `con/nul` or `com1/x` no longer break caching or hang on Windows: cached entry and version files are named by a hash of the id
- **Refresh** in the Marketplace tab no longer returns the cached list when it is pressed while the tab is still loading; it always checks the marketplace
- The web editor's Marketplace tab says when the list may be incomplete because the marketplace changed while it loaded (the CLI already did)
- ccinfobar never follows a redirect on a marketplace request that carries your token (account and admin reads, like writes before), so a same-host redirect cannot hand the token to another marketplace path
- Cancelling the editor's GitHub sign-in while the marketplace exchange is running no longer leaves you signed in: the new marketplace token is revoked and nothing is stored, matching the "cancelled" the dialog shows
- A marketplace entry an admin rejected no longer stays "Waiting for review" forever or fails every publish: `catalog publisher --check` and the next publish notice the rejection, say so, and put the entry back to not shared, so sharing it again submits it as a new entry instead of being refused as reserved. An entry removed on the marketplace is marked withdrawn instead of failing on every publish
- `ccinfobar catalog admin approve` without `--tag` now prints what goes live (name, id, version, content hash) and asks in a terminal, and needs `--yes` elsewhere, so a version a publisher added after `admin show` is never approved unseen
- The marketplace deploy workflow records a D1 Time Travel bookmark in the job log before it applies migrations, and the runbook no longer claims that wrangler backs up the database first; its checkout and setup-node actions are pinned by commit SHA

### Security

- Published text is sanitized the same way on both sides (control characters, escape sequences and bidi marks removed) before it is shown, hashed and sent, so an entry with a tab or an escape code stays Published vN instead of being re-sent on every publish
- Marketplace content is data only: the client and both marketplace servers refuse `command`, `http` and `env` widgets, `link` widgets whose URL is not http or https, personal settings (budget, profiles, language and the like), unknown keys and content over 256 KiB. Every downloaded version is hash-checked, also against the hash listed in the entry's separately fetched version history, and validated like an untrusted import, and browsing shows the commands or URLs an entry would run or open
- ccinfobar contacts a marketplace or GitHub only when you ask (browse, refresh, install, publish, sign-in, report): never during a status line refresh, never in the background and never from an editor left open. The endpoint must be https (plain http only for `localhost`, `127.0.0.1` and `[::1]`), writes never follow redirects, and every publish shows the exact payload and the endpoint and needs your confirmation. Marketplace tokens are written to `catalog/credentials.json` (mode 0600) only after a sign-in or a first publish, and are kept per endpoint (origin and path), so a token is never sent to another marketplace on the same host; the GitHub token is never stored
- The reference server is hardened for self-hosting: rate limits (5 registrations and 600 reads a minute per IP, 30 writes a minute per IP and per token) with a 50,000-key limiter that fails closed, caps on publishers, live entries (5000, 200 per publisher), withdrawn entries (50,000, 1000 per publisher, so a publish and withdraw loop stops) and versions, answered with `413 over-quota`, a withdrawn entry that keeps no name, description, author or notes and is left out of the index, a 1 MiB request body, at most 256 connections with request and header timeouts, path parts checked before any file path is built, and error messages that never echo input
- The marketplace server signs in fail closed: a GitHub token is accepted only after GitHub's check-token API confirms it was issued to the ccinfobar OAuth app, and without the `GITHUB_CLIENT_SECRET` secret sign-in answers `503` before any GitHub call; self-hosters can opt out with `ALLOW_UNVERIFIED_GITHUB_TOKENS=true`, which is weaker (any GitHub token of the user signs them in). Admins are pinned by numeric GitHub id, and the GitHub token is never stored or logged
- On the marketplace server, untrusted publishers cannot change live entries until their next approval, an approval covers only the exact revision the admin reviewed, and public ids never go back to pending. It stores only the GitHub id, login and display name of a publisher; IP addresses are kept only as hashes with a daily random salt that is deleted after two days. Writes, sign-ins and reports are rate limited, and storage guards refuse writes before the free 500 MB database is full (400 MiB in total, 20 MiB per publisher)

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

[Unreleased]: https://github.com/alpadalar/ccinfobar/compare/v0.8.2...HEAD
[0.8.2]: https://github.com/alpadalar/ccinfobar/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/alpadalar/ccinfobar/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/alpadalar/ccinfobar/compare/v0.7.0...v0.8.0
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
