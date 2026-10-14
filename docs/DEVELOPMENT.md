# Development

## Setup

```sh
git clone https://github.com/alpadalar/ccinfobar.git
cd ccinfobar
npm install
npm run build
```

Requirements: Node.js 20 or newer. There are no runtime dependencies; everything in `package.json` is a dev dependency.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Bundle `src/` into `dist/ccinfobar.js`, with the web editor inlined |
| `npm run dev` | Rebuild on change |
| `npm test` | Run the test suite (Vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | Biome lint and format |
| `npm run check` | Typecheck, lint and test |
| `npm run docs` | Regenerate `docs/WIDGETS.md`, `schema/config.schema.json` and `schema/theme.schema.json` |
| `npm run demo` | Regenerate `docs/images/demo.gif` from the sample data (needs Chrome or Chromium and ImageMagick; set `CHROME` to pick a browser) |
| `npm run example` | Render `test/fixtures/payload.json` |

Try your build against a real session without installing it:

```sh
node dist/ccinfobar.js preview --last     # last payload Claude Code sent
node dist/ccinfobar.js edit --config /tmp/try.json
```

## Architecture

```
src/
├── bin.ts               entry point; sends `… hook <Event>` to cli/hook.ts before anything else loads
├── cli.ts               re-exports cli/main.ts
├── cli/                 main.ts (dispatch), args.ts, render.ts (status line), help.ts
│   └── hook.ts          `ccinfobar hook <Event>`: silent, append one line, exit 0
├── commands/            install, update, doctor, manage, config-cmd; loaded with import() per command
│   ├── install.ts       planInstall / applyInstall / uninstall
│   ├── hooks-install.ts hook planner, version floor, applyHooks / uninstallHooks
│   ├── hooks-doctor.ts  doctor's Hooks block: entry state, missing binaries, hook gates
│   ├── explain.ts       `ccinfobar explain` and the read-only loader doctor shares
│   ├── bench.ts         `ccinfobar bench`
│   ├── repos.ts         `repos --background`: the workspace-repos dirty job
│   ├── io.ts            CliIo and the config-issue printer shared by explain, preview and bench
│   ├── settings-file.ts format-preserving settings.json reads, writes and backups
│   ├── manifest.ts      what ccinfobar wrote, for uninstall and ownership
│   └── command.ts       statusLine command quoting per platform
├── core/
│   ├── types.ts         payload, config and widget types
│   ├── config.ts        defaults, validation, load and save
│   ├── payload.ts       ingestPayload: parse and sanitize stdin
│   ├── sanitize.ts      control, escape and bidi stripping, safe URLs
│   ├── json-locate.ts   line and column of a JSON error or key
│   ├── config-path.ts   dotted paths for `ccinfobar config`
│   ├── i18n/            t() and the English message tables
│   ├── renderer.ts      lines → ANSI text (styles, separators, flex, truncation)
│   ├── themes.ts        built-in themes, user theme loading and resolution
│   ├── ansi.ts          colors, width measurement, truncation
│   ├── context.ts       render context with lazy data sources
│   ├── inspect.ts       per-widget value, source and empty reason
│   ├── trace.ts         records what a widget read during render
│   ├── scenarios.ts     named payload and data situations
│   ├── cache-rule.ts    Claude Code's cache miss rule and the latest-miss check (pure)
│   ├── time.ts          epoch seconds, milliseconds and ISO to ms (pure)
│   ├── edit.ts          pure edit operations shared by both editors
│   ├── presets.ts, sample.ts, preview.ts, paths.ts
├── data/                git, transcript, GSD and terminal readers; store.ts, provider.ts
│   ├── limits.ts        shared plan limits store, keyed per account
│   ├── ledger.ts        cross-session cost ledger
│   ├── live.ts          trusted turn, permission wait and running tools (pure)
│   ├── environment.ts   CLAUDE.md, rules, MCP and hook counts from config files
│   ├── repos.ts         child repos of a workspace folder and the dirty cache
│   └── hooks.ts         hook log line format, fold and reader
├── widgets/             one file per category, registered in index.ts
│   ├── live.ts          tool-activity, turn-timer, permission-wait
│   └── projection.ts    usage projection, ETA and risk math (pure)
├── editor/              web editor: HTTP server + browser app (web/)
│   └── detach.ts        `edit --detach`: reuse or spawn a background editor
└── tui/                 terminal editor: state, view, keys, IO loop
.claude-plugin/
└── marketplace.json     this repo as a Claude Code marketplace
plugin/                  the ccinfobar plugin
├── .claude-plugin/plugin.json
└── skills/              edit, doctor, theme, install, uninstall (one SKILL.md each)
scripts/
├── clean-install.mjs    pack, install, render and uninstall in an empty profile
└── sync-plugin-version.mjs  copy the package version into plugin.json and INSTALL.md
```

Rendering flow:

1. Claude Code pipes a JSON payload to `ccinfobar` on stdin.
2. `cli/render.ts` sanitizes the payload with `ingestPayload`, loads the config and builds a `RenderContext`. Git, transcript and GSD data are read lazily, only if a widget asks for them.
3. Each widget's `render(ctx, item)` returns a string, `{ text, color }` or `null` to hide itself.
4. `renderer.ts` adds labels, colors and separators, fills `flex` space and truncates to the terminal width.
5. Spaces become non-breaking spaces and every line starts with a reset code, so Claude Code's dim style and whitespace trimming don't alter the output.

The transcript reader keeps an incremental cache in the cache directory, so only newly appended bytes are parsed on each refresh.

### Writing files

`src/data/store.ts` is the only module that calls `writeFileSync` or `renameSync`. `writeAtomic` writes a temp file and renames it, retrying on Windows when antivirus briefly locks the file. `test/foundations/atomic-writes.test.ts` fails if any other file under `src/` writes directly.

### Lazy CLI

`cli/main.ts` parses arguments and loads each command with `await import()`. The status line path (`cli/render.ts`) never pulls in install, update, doctor, the editors or the TUI. `test/foundations/import-graph.test.ts` checks this, and that the pure modules (`core/edit.ts` and others) have no `node:` imports.

### Install and uninstall

- `commands/settings-file.ts` reads and writes `settings.json`. It keeps BOM, line endings, indent, trailing newline, mode, owner and symlinks, refuses to write a file that does not parse, merges again if the file changed during the write, and stores a 0600 copy in `<configDir>/backups/` before every change (newest 10 per file plus a never-rotated `-original.json`).
- `commands/manifest.ts` keeps `<configDir>/manifest.json`: each statusLine and `.git/info/exclude` line ccinfobar wrote, and how to restore what was there. Ownership is deep equality with the recorded value, never a search for "ccinfobar" in the command.
- `commands/install.ts`: `planInstall` works out the change without writing; `applyInstall` writes it and refuses to replace another tool's statusLine unless `confirmed`. The CLI, `--project`, the GSD takeover, the background update, the editor and the TUI all go through this pair. `uninstall` restores from the manifest.

### Untrusted text

Text from outside is sanitized where it enters, not in each widget: the stdin payload (`ingestPayload`), git output, the transcript, subagents and GSD planning files go through `core/sanitize.ts`. The `command` widget with `preserveColors` keeps only SGR colors and safe links; PR and `link` URLs must pass `safeUrl`; `env` values are plain text. Git calls add `core.fsmonitor=false` and `--no-optional-locks` and blank repo-local filter drivers (`gitHardening`, on by default).

### Broken config

`inspectConfigText` in `core/config.ts` reports a config that does not parse, or whose `lines` is not an array, with its line and column (from `core/json-locate.ts`). The status line then shows `config error at line N` instead of the default layout, and `saveConfig` throws `ConfigBrokenError`, so the editor, TUI, `theme`, `install` and `config set` never overwrite the file. Only `init --force` and `import` replace it, after a backup. `doctor` prints the line, column and message. Rendering never writes the config.

### Explain and inspect

`core/inspect.ts` turns a render context into one row per widget: its value, its sources and, when it is empty, a reason code. It has no I/O and no `node:` imports. `commands/explain.ts` holds `loadInspectInput`, the read-only loader shared by `explain` and `doctor`: it picks `--payload`, `--scenario`, the last saved payload or the sample, and reads the transcript, subagents and history without writing caches. `explain` replaces `env` and `command` values with `<redacted N chars>`; only `--show-values` in a terminal prints them, and `--json` never does.

`inspectRows` wraps the render context with a trace from `core/trace.ts`, which the normal render path never does. The trace records the payload paths, env key names and data calls each widget makes, never their values. Widgets whose reads the trace cannot see (system info, `command`) declare `WidgetDef.sources` as a hint. Tests: `test/core/inspect.test.ts`, `test/core/trace.test.ts` and `test/commands/explain.test.ts`.

### Scenarios

`core/scenarios.ts` is a pure module (it is in the import-graph test's PURE list). Each scenario is a payload, an env and a `Required<DataSources>` set of injectors, built against the fixed clock `SCENARIO_NOW`, so its output never depends on the machine or the date. Because the type is `Required<DataSources>`, every new `DataSources` member must ship with an injector in every scenario, or `npm run typecheck` fails. `preview --scenario`, `explain --scenario`, `bench --scenario` and the editor's Scenario picker all use it.

### Cache rule

`src/core/cache-rule.ts` is pure and holds Claude Code's miss rule. `classify` calls a request a miss when its cache reads fall below 95% of the smaller of the previous and the current input and the shortfall is at least 2,000 tokens; the request after a compaction is `expected`. `latestMiss` says whether the latest request missed (`last_miss_at` within 2 s of `expires_at − ttl`), or `unknown`. When the payload has `prompt_cache` it is the only source; the transcript reader applies `classify` only when it is missing.

### Limits store

`src/data/limits.ts` shares plan limits between sessions. `accountKey(env)` hashes the provider kind, the resolved Claude config dir (lowercased on win32 only) and `CLAUDE_SECURESTORAGE_CONFIG_DIR` into 16 hex chars. The store is `<cacheDir>/limits/<accountKey>.json`; the OAuth usage cache is `<cacheDir>/usage-<accountKey>.json` (a legacy `usage.json` is only read, when `CLAUDE_CONFIG_DIR` is unset; it may come from another config dir, so its values count as an unknown capture and lose to any known one).

- Capture time is the transcript's last assistant message (`lastAssistantAt`), else the transcript mtime, else unknown. The usage worker stamps its result with `fetchedAt`.
- Merge (`pick`): only plausible windows (pct in range, reset in the future and no further than one window length plus 10 minutes ahead). The latest reset wins, then the newest capture, then the payload over the API, then the higher pct; a payload value (0.1% steps) beats an API value (whole percents) that is less than 1 point away, whatever their capture times. Expired windows are dropped and never stored. With nothing plausible, this session's own unexpired payload window, then an API `resets_at: null` bucket, is shown but not stored.
- Each window keeps a ring of up to 32 samples for the projection widgets, fed by payload observations only. Within 60 s (5h) or 20 min (7d) of the last point an unchanged pct is skipped and a changed one replaces a still-open last point; otherwise a point (flat or not) is added. A new window clears the ring. The `recent` pace fits these samples plus the current value, with gaps filled linearly, so an idle stretch lowers the slope.
- Two gates in `effectiveUsage`: `limitsOn` (the provider has plan limits and a limits widget is configured) controls the store read; `usageOn` (`limitsOn`, `usageApi` not disabled, and data missing) controls the usage cache read and the worker.
- `recordLimits` runs after stdout with the unmerged payload, writes 0600 and only on change, and never throws. There is no lock: just before writing it reads the file again and, if another writer got in, merges its observations into that version instead (up to three tries). `recordUsageApi` does the same for the worker and empties the store when the login changes; the worker keys the login on a hash of `oauthAccount.accountUuid` (from the credentials or `.claude.json`), else the refresh token, else the access token, keeps it through error and no-login caches, and never writes it to the limits file.
- `explain`, `doctor`, `preview` and the editor read the store and never write it.

### Cost ledger

`src/data/ledger.ts` keeps estimated cost across sessions. `recordLedger` runs after stdout, only when `ledgerOn(config)` (a `cost-today`, `cost-week`, `cost-project` or daily `budget` widget), and appends one line through `appendLine` in `store.ts` (flag `a`, mode 0600) to `<cacheDir>/ledger/YYYY-MM.jsonl`:

```json
{"v":1,"t":1760400000000,"a":"<accountKey>","s":"<session id>","p":"<project root>","tp":"<transcript hash>","c":4.12}
```

`c` is the raw `cost.total_cost_usd`, so the summary can be rebuilt from the files (Phase 9 `report`). A line is written only when the session is new or `c` matches none of its segment highs.

- Fold (`credit`): per session up to 16 segments, each with its high-water total. The first sighting is a baseline and credits nothing. A total at or above a segment high credits the difference to the closest high below it, raises that high and moves the segment to the front; a seventeenth segment drops the least recently updated one. A total below every high starts a new segment and credits nothing (only a reset to about 0, such as `/login`, credits its few cents), so two processes interleaving or a restored older total never count twice.
- `summary.json` holds per-file byte offsets, per-session segments, and per-day and per-project totals by account. `readLedger` folds only the bytes after the stored offsets, up to the last newline, skips invalid lines, and rebuilds when a file shrank. A cold rebuild folds month files oldest first, so a session that spans two months keeps its high across the boundary; the render reads at most 256 KB before stdout (`RENDER_BUDGET`), `recordLedger` continues an unfinished fold after stdout with up to 16 MB (`BYTE_BUDGET`), and the view is `partial` (the cost widgets add `…`) until the build is done.
- Widgets get `ledgerView`: today, ISO week, month and project totals for the current account, plus this render's pending delta.
- Retention (`pruneLedger`, when an append creates a new month file): month files older than 13 months, day and project rows older than 400 days, and sessions not seen for 30 days.
- `explain` and `preview` read with `persist: false` and never call `recordLedger`. `test/data/ledger-concurrency.test.ts` checks that 8 processes appending at once never tear a line.

Every new `DataSources` member (`limits`, `ledger`) has a sample injector in `core/sample.ts` and one in every scenario, and `ctxWith()` in tests defaults to the sample.

### Hooks

Hooks are optional. The render path never loads the hook writer; it reads the folded state through `DataSources.hooks` (see [Live session data](#live-session-data)).

- **Entry.** `bin.ts` takes the hook path only for `hook …` or `[--flags] [--config <file>] hook <Event>` (the event matches `/^[A-Z][A-Za-z]+$/`), so `ccinfobar --config X hook Stop` and a bare `ccinfobar hook` match but `ccinfobar config set hook 1` is a normal command. Before the first import it calls `silence()` (`cli/silence.ts`, no imports, inlined into the entry chunk): stdout and stderr become no-op sinks through `Object.defineProperty`, so the real streams are never created; it drops the warning listeners, exits 0 on any uncaught error and starts a 2 s self-exit timer, then imports `cli/hook.js`. `main.ts` also has a `hook` case for `main()` callers; it does not silence.
- **Closure.** `cli/hook.ts` may only reach `cli/args.ts`, `data/hook-line.ts` (the event list, line format and paths: the writer half of `data/hooks.ts`, which re-exports it), `data/store.ts`, `core/builtins.ts`, `core/paths.ts` and `core/sanitize.ts`; `test/foundations/import-graph.test.ts` fails on anything else, and checks that bin.ts imports `./cli/hook.js` before `./cli.js`. It also fails on a static `node:fs` or `node:crypto` import or `process.stdin` in that closure and, after a build, in the hook chunk and the chunks it imports: a static ESM `node:fs` import costs about 8 ms at startup, so `core/builtins.ts` loads it through `process.getBuiltinModule` (`createRequire` on older Node 20), and `store.ts` loads `node:crypto` only when it names a temp file. The update check is a dynamic `import('../data/update-state.js')`, loaded only on `SessionStart` with source `startup`, which also prunes `<sid>.jsonl` and `<sid>.fold.json` files older than 7 days (at most 200 deletions and 15 ms per run, so stale files behind many fresh ones are still reached).
- **Input.** stdin is read with `fs.read` on fd 0 instead of the `process.stdin` stream (about 9 ms), except on Windows, where `cli/hook-stream.ts` keeps the stream because the pipe may be overlapped. It is capped at 1 MB with a 1 s deadline, and reading stops as soon as the bytes so far parse as a JSON object. Node joins its thread pool on exit, so an `fs.read` still waiting holds the process: a partial payload whose writer never closes keeps it alive until the writer closes or Claude Code's 5 s hook timeout ends it. On overflow the fields come from a regex scan of the first 64 KB and then the last 64 KB (so a `prompt_id` after a huge prompt is still found); the head wins, and nested keys can match but escaped keys inside strings cannot. The stdin `hook_event_name` wins over argv. The event must be on the allowlist and `session_id` must match `/^[A-Za-z0-9_-]{1,128}$/`, else nothing is written. `CCINFOBAR_DEBUG` writes fixed reason codes (never payload content) to `hooks/debug.log`, up to 256 KB.
- **Line format.** One `appendLine` per event to `<cacheDir>/hooks/<session_id>.jsonl` (mode 0600; missing dirs are created 0700), with only allowlisted fields, each sanitized and capped at 256 chars (1024 for the transcript path):

  ```json
  {"v":1,"t":1760400000000,"e":"Stop","p":"<prompt id>","sa":false}
  ```

  `s` (SessionStart source), `p` (prompt id), `sa` (`stop_hook_active`), `a`/`at`/`tp` (agent id, type, transcript path), `n` (notification type), `tn` (PermissionRequest and PermissionDenied tool name). Prompt text, `last_assistant_message` and tool input are never stored.
- **Fold.** `foldHookLog(lines)` is pure. It skips lines that are not objects, have `v !== 1`, an unknown event, a non-finite `t` or a wrong-typed field. A line whose `e|p|a|tn|n` key was seen within 2 s (`DUP_WINDOW_MS`) is a duplicate and ignored; the window map is pruned as it goes, capped at 512 and saved with the fold, so a duplicate split across two reads is still caught. Turns pair by `prompt_id` (earliest UserPromptSubmit, latest Stop), because async hooks can write Stop first; a Stop without `p` pairs with the latest unkeyed prompt. Agents are keyed by `agent_id`. `pendingPermission` means a prompt was shown at `since`, not that it is still open (Claude Code hides the status line while the dialog is up, and approving fires no registered event). It is set by `Notification(permission_prompt)` or `PermissionRequest` and cleared by any later activity: Stop, UserPromptSubmit, SessionStart, SubagentStart, SubagentStop or another Notification. Stop, UserPromptSubmit, SessionStart and `PermissionDenied` (auto mode denials) first close an open wait into `lastPermission` (`since`, `end`, tool), which `permission-wait` shows. Fold cache version 3. It keeps the newest 50 keyed and 50 unkeyed turns and 100 agents.
- **Reader.** `readHookState(sid, env, { persist })` advances by byte offset like `transcript.ts`, consumes only up to the last newline, skips lines over 64 KB and caches `{ v, offset, ino, state }` in `<sid>.fold.json`. A damaged cache, another version, an offset past the end or a new inode refolds from 0. It returns null on any error; `persist: false` (doctor) never writes the cache.
- **Install.** `planHooks` is pure: per requested event it returns `add`, `keep`, `rewrite`, `skip-unmanaged` or `skip-version`. `NEVER_EVENTS` (PreToolUse, PostToolUse, PostToolBatch, PreModelSwitch, SessionEnd) are filtered out before planning. Every group is `{ "type": "command", "command": "<statusLine command> hook <Event>", "async": true, "timeout": 5 }`; Notification has the `permission_prompt` matcher.

  | `HOOK_FLOOR` key | Claude Code |
  | --- | --- |
  | `core` (any hook) | 2.1.101 |
  | `async` | 2.1.101 |
  | `notificationMatcher` | 2.1.101 |
  | `PermissionRequest` | 2.1.101 |
  | `PermissionDenied` (default set, cannot block) | 2.1.89 |

  Before 2.1.101 Claude Code ignored the whole settings file when it held an event name it did not know, so an unknown or older version refuses hooks (`detectClaudeCode` runs `claude --version`, on Windows `claude.exe` then `cmd.exe /d /s /c`, with a 2 s timeout, from the home dir with `NoDefaultCurrentDirectoryInExePath=1` so a planted `claude` in cwd never runs, and falls back to the last payload's `version`). `applyInstall` writes the statusLine and the hook groups in one `patchSettings` call, user settings only. When the statusLine command changes, owned groups are rewritten to the new command, so hooks never point at an old binary. A command whose first word is `npx`, `pnpx`, `bunx` or `pnpm`/`yarn`/`bun dlx` gets a warning (`isRunnerCommand`), since every event would start the runner. `applyHooks` is the hooks-only write the editor uses (`POST /api/hooks`); its `remove` list drops owned events in the same patch, so turning Permission requests off is one write. The editor runs `detectClaudeCodeAsync` once, right after it starts listening (aborted on close), so no request blocks on `claude --version`.
- **Manifest.** Each group is a `kind: 'hook'` entry (`file`, `event`, `matcher`, `value`, `claudeCode`, `writtenHash`). Ownership is deep equality with `value`. After every write `refreshWrittenHash` stores the new file hash for all entries of the file; `noteWrite` first voids the statusLine's byte restore when the file changed outside ccinfobar since its last write.
- **Uninstall.** `removeOwnedHooks` removes the first group per event that deep-equals the record and keeps edited ones (reported). A file that still hashes to ccinfobar's last write is restored byte for byte; a file ccinfobar created is deleted only when nothing but owned content is left; otherwise the statusLine and owned groups go in one patch. The foreign, gone and not-installed statusLine paths still remove the hooks. `uninstall --hooks` (`uninstallHooks`, with an optional event filter) keeps the statusLine.
- **Doctor.** `hooks-doctor.ts` lists the entries and their state, hook commands whose first token no longer resolves (no spawn), and `disableAllHooks` / `allowManagedHooksOnly` in user, project, local and file-based managed settings, plus the last event age from `readHookState(…, { persist: false })`.

Tests: `test/cli/hook.test.ts`, `test/data/hooks.test.ts`, `test/commands/hooks-*.test.ts`, `test/editor/hooks-route.test.ts` and `test/integration/hook-*.test.ts` and `install-hooks-cli.test.ts` (built CLI, parallel appends, SessionStart).

### Live session data

Phase 5 added three optional `DataSources` members, `hooks`, `repos` and `environment`. They are lazy and never spawn in the render path. Each has a sample injector in `core/sample.ts` and one in every scenario (`waiting-permission` and `workspace-folder` exercise them), and `ctxWith()` defaults to the samples.

- **Transcript fields.** `TranscriptInfo` gained `runningTools` (id, name, a 32-char arg, start; at most 8), `turnToolCounts`, `sessionToolCounts`, `lastToolResultAt`, `promptId`, `promptStart` and `turnEnd`. The cache `VERSION` is 8; bump it once if a field changes shape. Sidechain lines are skipped, a tool result removes its running tool, and an interrupt clears them.
- **Trusted turn.** `trustedTurn(hooks, transcript, promptId, now)` in `src/data/live.ts` uses the hook turn when it has a start, its prompt id matches, the transcript shows no prompt more than 5 s after it (missed UserPromptSubmit), and it is not still open while the transcript turn ended more than 60 s ago (missed Stop). Otherwise it uses the transcript's `promptStart`/`turnEnd`. `turn-timer`, `tool-activity` and the agent scoping all go through it. `activeTools` drops a tool once the turn ended at or after its start, or after 10 minutes.
- **Hook fold.** `PermissionDenied` is on the allowlist and in the default install set (floor 2.1.89). Closing a wait writes `lastPermission { since, end, tool }`; `lastWait` also closes a pending wait with a later transcript tool result. Waits longer than `maxAgeMin` or older than the turn are ignored, and an open wait is never shown. `FOLD_VERSION` is 3. SubagentStart/Stop give `agents` and `agent-count` exact start, stop and type.
- **Environment.** `readEnvironment(projectDir, cwd, env, opts)` in `src/data/environment.ts` only stats memory and rules files and reads settings, `.claude.json`, `.mcp.json` and `managed-mcp.json` through a nonblocking, fstat-checked reader with size caps. The cache `env-<key>.json` (VERSION 2) stores per-file `[path, mtimeMs, size, facts]`, where facts are counts, flags and sanitized server names, never configs; a file is reparsed only when its mtime or size changes, and rules are rescanned when a scanned dir changes or after 60 s. Tests inject `managedDir` and `stopAt` so `/etc/claude-code` and the filesystem root are never read.
- **Repos.** `readRepos` in `src/data/repos.ts` returns null inside a repo (an lstat walk for `.git`, no git), else scans child folders' `.git/HEAD` into `repos-<key>.json` (10 s TTL plus the folder mtime). The dirty marker comes from `repos-dirty-<key>.json`.
- **Dirty job.** `src/commands/repos.ts` (`repos --background <root>`, not in help) runs a hardened `git status` in at most 50 repos, 2 s each and 15 s in total, and writes the dirty cache atomically. `cli/render.ts` schedules it after stdout through `scheduleRepoDirty` (60 s TTL, a lock, `spawnSelf`), which is the only spawn on the render side.
- **Workspace mode.** Before rendering, `workspaceMode(ctx)` in `core/renderer.ts` renders each `workspace-repos` item once; when one shows repos, the other git widgets hide instead of showing `—` (`hideGitPlaceholders: false` opts out).
- **Time-based widgets.** `WidgetDef.timeBased` marks widgets that need a refresh interval; `needsRefresh` in `core/edit.ts` (pure) drives the `install`, `doctor` and editor hints.

`test/widgets/performance.test.ts` renders all five live widgets through the real readers on temp fixtures with `child_process` spies and asserts no call; `test/core/scenarios.test.ts` renders them under every scenario and checks that no preset or default layout uses them.

### Plugin

`.claude-plugin/marketplace.json` lists one plugin with `source: "./plugin"`. `plugin/` holds only `.claude-plugin/plugin.json` and five `skills/<name>/SKILL.md`. Every skill has `disable-model-invocation: true`, an `allowed-tools` list that pre-approves only read-only commands (`ccinfobar --version`, the dry runs, `doctor`, `edit --detach`, `themes --list`, `theme <id>`; never `--yes` or `uninstall`, so those always ask) and a ``!`ccinfobar --version || echo ccinfobar-missing` `` preflight, stops when that (or the `npx ccinfobar@latest --version` it runs before installing) prints 0.6.2 or lower, and only runs `ccinfobar` commands. There are no commands, hooks, agents, bin, MCP or settings in the plugin.

`claude plugin validate --strict` checks the schema but not these rules, so `test/plugin/structure.test.ts` pins them: the manifest shape, the five skill dirs, no forbidden paths, no `"statusLine"` key or `CLAUDE_PLUGIN_ROOT`, the exact frontmatter, the preflight, the version gate and each skill's commands in order.

`plugin.json`'s `version`, the pins in `INSTALL.md` (`ccinfobar@<v>`, `/blob/v<v>/`) and the README's `alpadalar/ccinfobar#v<v>` follow `package.json`. The npm `version` lifecycle script runs `scripts/sync-plugin-version.mjs` and stages the three files, so `npm version` keeps them in step; `test/plugin/version-sync.test.ts` fails on drift. When HEAD is exactly at `v<version>` (the release workflow's `npm run check`), `--check` also fails if that tag lacks `INSTALL.md` or `.claude-plugin/marketplace.json`. INSTALL.md first runs `npx ccinfobar@<v> --version` and stops at 0.6.2 or lower (no dry run, no ask-before-replace); that floor is fixed text the script never rewrites. CI's `plugin` job installs a pinned `@anthropic-ai/claude-code` into a temp prefix, with HOME and `CLAUDE_CONFIG_DIR` in `$RUNNER_TEMP`, runs `plugin validate --strict` on `.` and `./plugin`, and checks that `plugin details` shows `Skills (5)` and `Hooks (0)`. Never run `claude plugin install` against your own config to test; use `--plugin-dir ./plugin`.

`edit --detach` (`editor/detach.ts`) pings the editor recorded in `<cacheDir>/editor.json` (`{ url, pid, startedAt, config }`, 0600) with its token and reuses it when `config` is the same resolved config path and, with `--port`, the port matches. Otherwise it takes `editor.json.lock` (a second `--detach` waits for the first and reuses its editor), checks again, spawns `edit --serve-detached` as a detached session leader and waits up to 5 s for that file. The detached server stops after 30 minutes without requests, on `POST /api/shutdown` or on SIGTERM, and removes `editor.json` only if it still holds its own pid.

### Messages and providers

User-facing messages go through `t(id, params)` from `core/i18n/`. Each area has its own table in `src/core/i18n/en/` (`install.ts`, `config.ts`, `doctor.ts`, `widgets.ts`, `explain.ts`, `preview.ts`, `bench.ts`). `data/provider.ts` detects API-key, Bedrock, Vertex, Foundry, Mantle, Anthropic AWS and gateway sessions from the environment (presence only), so plan-limit widgets and the OAuth usage fetch only run for Claude subscriptions.

## Adding a widget

1. Pick the category file in `src/widgets/` and add a `WidgetDef`:

   ```ts
   {
     type: 'my-widget',
     name: 'My widget',
     category: 'system',
     description: 'One line shown in the editors and docs',
     label: 'my ',
     color: 'cyan',
     sample: '42',
     options: [{ key: 'precision', label: 'Precision', kind: 'number', default: 0 }],
     render(ctx, item) {
       const value = ctx.payload.cost?.total_cost_usd;
       if (value === undefined) return null;
       return value.toFixed(opt(item, 'precision', 0));
     },
   }
   ```

2. Return `null` when there is nothing to show. Never throw; the renderer drops widgets that do, but it hides real bugs.
3. Prefer payload fields. Use `ctx.data.git()`, `ctx.data.transcript()` or `ctx.data.gsd()` only when the payload lacks the data.
4. Add tests in `test/widgets/` using `ctxWith()` and `renderWidget()` from `test/helpers.ts`.
5. Run `npm run docs` and commit the regenerated files.

Both editors pick up new widgets and their options automatically.

## Testing

- `test/core`: renderer, colors, config, edit operations, inspect, trace and scenarios
- `test/themes`: built-in themes, styles, overrides and user themes
- `test/widgets`, `test/data`: widgets and data readers
- `test/gsd`: GSD parser against fixture projects in `test/fixtures/gsd`
- `test/editor`: editor HTTP API and ANSI to HTML conversion
- `test/tui`: TUI reducer, key parsing and view
- `test/commands`: install, settings file, manifest, doctor, explain, preview, bench and `config`
- `test/foundations`: test isolation, atomic writes, import graph and config round trips
- `test/cli`: argument parsing and the hook command
- `test/plugin`: plugin structure and version sync
- `test/integration`: the built CLI end to end (safe mode, install prompts, shared limits, the cost ledger, hooks)

`test/setup.ts` runs before every test file. It points HOME, the config, cache and Claude dirs at a per-run temp folder and throws on any write outside temp dirs, so a test can never touch your real `~/.claude/settings.json`. Wrap code in `withoutSideEffects()` from `test/helpers.ts` to also fail on config saves, spawns or `fetch` (used for the render path).

CI runs the suite on Linux, macOS and Windows with Node 20, 22, 24 and 26.

### Clean-install check

```sh
node scripts/clean-install.mjs [--case a..g] [--skip-build]
```

The script builds (unless `--skip-build`) and packs ccinfobar, then for each settings fixture (no file, no statusLine, another tool's statusLine, BOM, CRLF, 4-space indent with no final newline, mode 0600) installs the tarball into an empty temp profile, runs `install --yes`, renders the exact `statusLine.command` through every shell (sh and bash; on Windows Git Bash, powershell.exe, pwsh and cmd.exe), uninstalls, and checks that the settings bytes and mode match the seed, that no ccinfobar process is left, that the background workers ran and that the version did not change. Each case then runs a hooks cycle: `install --hooks --yes` with a fake `claude` 2.1.299 first on PATH, checks the seven hook events, runs the UserPromptSubmit hook command through every shell (silent, exit 0, one new log line) and checks that `uninstall` restores the seed bytes with no `hooks` key. `--case` runs one fixture.

The build, `npm pack` and every case run with HOME, USERPROFILE, APPDATA, LOCALAPPDATA, the XDG dirs, TMPDIR, the npm prefix, cache, logs and user config pointed inside the script's own `mkdtemp` roots under `RUNNER_TEMP` or the OS temp dir. `CLAUDE_CONFIG_DIR` is left unset so the default `<HOME>/.claude` path is exercised, and `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set to it, so on macOS the usage worker asks the keychain for a hashed service name and can never read your real Claude token. Before the build it exits 2 if HOME or USERPROFILE would be your real home or any of those paths is outside its root. Apart from rebuilding `dist/` (skipped with `--skip-build`), it only creates and removes those roots. It is a plain script, not a Vitest test, because `test/setup.ts` patches `fs` and `child_process`.

A process still running from the temp root after 30 s fails the case and is killed before the root is removed, and a root that cannot be removed fails the case instead of stopping the run.

CI runs it in the `clean-install` job on Linux, macOS and Windows with Node 20 and 26, with a 20-minute job timeout.

## Benchmark

```sh
ccinfobar bench [--runs N] [--scenario <name>] [--json] [--config <file>]
```

`bench` times your own layout. N defaults to 20 and is clamped to 1..1000. `--json` prints the same data as one object.

Rows:

- `node -e 0`: the control, the time it takes Node itself to boot.
- `cold`: every run gets fresh ccinfobar cache, config copy and Node compile-cache dirs. The OS file cache stays warm, so "cold" means ccinfobar's and Node's caches, not the disk.
- `warm`: shared dirs after 2 discarded warm-up runs. This is what Claude Code sees on most refreshes.
- `warm, compile cache off`: the warm dirs with `NODE_DISABLE_COMPILE_CACHE=1`.
- `hook UserPromptSubmit`: `ccinfobar hook UserPromptSubmit` with a small hook payload in the warm dirs, after 2 warm-up runs. This is what one optional hook costs per event.

Method:

- Each run spawns `process.execPath` with the same entry script (`spawnSync`) and measures from spawn to exit with `process.hrtime.bigint()`.
- The payload goes on stdin. It is the sample (or `--scenario`) payload with `cwd` set to the current dir, so a real git repo is exercised when there is one, and `transcript_path` set to a synthetic transcript of about 200 entries. `--scenario` applies only the scenario's payload and env (provider keys from your env are dropped first). Its data injectors (subagents, GSD state, no git) cannot reach the child process, so the child reads the real git repo, the real `.planning` and the synthetic transcript.
- The child env gets temp `CCINFOBAR_CACHE_DIR`, `CCINFOBAR_CONFIG_DIR`, `CLAUDE_CONFIG_DIR` and `NODE_COMPILE_CACHE`, plus `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (no update or usage workers) and `COLUMNS=140` (like Claude Code, so no width probe). Your config and user themes are copied in read-only; the real caches and `~/.claude` are never touched, and the temp dirs are removed afterwards.
- Stats: median (mean of the two middle values when N is even), nearest-rank p95, min and max.

Measure at nice 0, for example after `renice -n 0 -p $$` in your shell (lowering the nice value may need privileges). On a machine that starts tools at nice 10, `nice -n -10 ccinfobar bench` also reaches 0; the header shows the priority and warns when it is above 0. Measure when the machine is idle and note the load average, because the numbers move with machine state.

`ccinfobar overhead = warm median − control median` is the cost ccinfobar adds on top of Node boot. Phase 10 (F2, a single binary) compares this number, taken the same way, to decide whether a compiled binary is worth it. `hook overhead = hook median − control median` is the same figure for one hook event. The clean-install CI job also prints `bench --runs 10 --json` for each OS; that step never fails the job.

Baseline, 2026-10-14, `nice -n -10` (priority 0), Node v22.23.1, Intel i7-1165G7 (8 threads), Linux 7.2.9 (Fedora 44), load average 2.10 → 1.85, cwd this git repo, default layout, N = 20:

| Row | median (ms) | p95 (ms) | min (ms) | max (ms) |
|-----|------------:|---------:|---------:|---------:|
| `node -e 0` | 73.1 | 78.3 | 69.8 | 83.1 |
| cold | 141.4 | 148.6 | 134.6 | 157.6 |
| warm | 130.1 | 136.0 | 123.4 | 136.3 |
| warm, compile cache off | 137.2 | 142.0 | 129.7 | 145.5 |

ccinfobar overhead: 57.0 ms. The compile cache saves about 7 to 11 ms. A git repo as cwd adds about 9 ms: the same run from a non-git dir gave a warm median of 121.2 ms (overhead 47.6 ms).

Phase 3 (shared limits, cost ledger, projections), 2026-10-14, same machine and method, load average about 9.3, default layout, N = 20:

| Row | median (ms) | p95 (ms) | min (ms) | max (ms) |
|-----|------------:|---------:|---------:|---------:|
| `node -e 0` | 69.2 | 72.9 | 67.2 | 80.9 |
| cold | 144.5 | 151.0 | 141.6 | 151.2 |
| warm | 136.9 | 143.9 | 131.1 | 144.0 |
| warm, compile cache off | 141.7 | 150.0 | 134.9 | 152.2 |

The machine was busier than for the baseline, so the absolute numbers are higher. Run back to back under the same load, the build before Phase 3 gave warm medians of 138.7 and 133.5 ms and the Phase 3 build 135.1 and 132.2 ms: no measurable change. Layouts without limits or cost widgets do no limits or ledger I/O.

Phase 4 (hooks and plugin), 2026-10-14, same machine and method, load average about 1.6, default layout, N = 20:

| Row | median (ms) | p95 (ms) | min (ms) | max (ms) |
|-----|------------:|---------:|---------:|---------:|
| `node -e 0` | 67.5 | 70.7 | 64.9 | 73.3 |
| cold | 141.1 | 146.1 | 138.0 | 147.6 |
| warm | 130.1 | 136.7 | 127.5 | 137.8 |
| warm, compile cache off | 135.1 | 144.6 | 133.3 | 144.9 |
| hook UserPromptSubmit | 94.1 | 103.0 | 92.0 | 106.6 |

ccinfobar overhead 62.7 ms; hook overhead 26.6 ms. A second run right after gave warm 131.6 ms and hook 98.5 ms (hook overhead 31.2 ms). The render path is unchanged: the warm median matches the baseline. The hook overhead is above the 20 ms target. A minimal ESM script that reads the same stdin and appends one line costs about 18 ms over the control on this machine, so ccinfobar's own code adds about 10 ms. The hook runs async, so Claude Code never waits for it.

Hook path after the Phase 4 review fixes, 2026-10-15, same machine and method, load average about 1.3, N = 20, run back to back with the build before the fixes:

| Row | before (ms) | after (ms) |
|-----|------------:|-----------:|
| `node -e 0` | 68.1 | 66.4 |
| warm | 117.6 | 116.5 |
| hook UserPromptSubmit | 97.4 | 79.4 |

Hook overhead 29.3 ms → 13.0 ms, within the 20 ms target; the render path is unchanged. Against an empty ESM file with piped stdio (40 interleaved runs of `hook Stop`) the overhead went from 26.5 to 8.2 ms. The savings: no stdout/stderr streams (silent sinks), `fs.read` instead of `process.stdin`, `node:fs` through `process.getBuiltinModule`, and no `node:crypto`. The compile cache still saves 1 to 2 ms on this path, so `bin.ts` keeps enabling it.

Phase 5 (live session widgets), 2026-10-15, same machine and method, `nice -n -10` (priority 0), load average about 1.0 to 1.3, N = 20. Layouts: `default`; `live`, the default plus `tool-activity`, `turn-timer`, `permission-wait`, `env-counts` and `workspace-repos` (`dirty: true`) on line 1; `placebo`, the default plus five `text` widgets, to separate the cost of a longer line. Warm medians are the mean of interleaved runs (3 in this repo, 2 in a synthetic workspace folder holding two repos):

| cwd | default warm (p95) | placebo warm | live warm (p95) | live − default |
|-----|-------------------:|-------------:|----------------:|---------------:|
| this git repo | 123.8 (131.1) | 125.4 | 127.5 (136.0) | +3.7 |
| workspace folder | 115.5 (122.3) | 115.7 | 118.5 (125.0) | +3.0 |

The live widgets cost about 2 to 3 ms warm, slightly above the 2 ms target. One source at a time in the workspace folder: `env-counts` +2.2 ms, `workspace-repos` +0.6 ms, the three transcript and hook widgets together +0.7 ms. In-process, a warm `readEnvironment` takes 0.1 to 0.2 ms, but the first call in a fresh process takes 1.7 to 2.2 ms, so its cost is mostly first-run code, not I/O; it never spawns and rewrites its cache only on change. Cold runs with `dirty: true` are about 11 ms slower, because each fresh cache dir starts the detached dirty job; in a real session that happens at most once a minute. Nothing changes for layouts without these widgets.

## Releasing

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading.
2. `npm version <patch|minor|major>` (its `version` script also updates `plugin/.claude-plugin/plugin.json` and the pins in `INSTALL.md` and the README)
3. `git push --follow-tags`

The `Release` workflow runs the checks, creates a GitHub release from the changelog section with the packed `ccinfobar.tgz` attached (the README install command points at it), and publishes to npm with provenance when an `NPM_TOKEN` repository secret exists.
