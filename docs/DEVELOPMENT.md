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
| `npm run screenshots` | Regenerate the README editor screenshots in `docs/images/screenshots/` (dark and light, 1920x1080) from a temp config and a reference marketplace on 127.0.0.1 (built with `--market` when missing, so the Marketplace shots need no network); needs `npm run build`, Node 22+ and Chrome or Chromium; set `CHROME` to pick a browser, `--only editor,themes` for a subset |
| `npm run example` | Render `test/fixtures/payload.json` |

`node scripts/build.mjs --market` builds the reference marketplace server into `market/ccinfobar-market.mjs`, and `node scripts/build.mjs --worker` builds the Cloudflare Worker into `worker/dist/index.js`. Both outputs are gitignored and not in the npm package.

Two scripts are not wired into npm or CI: `node scripts/homebrew-formula.mjs` fills in the Homebrew formula for the owner after a release (see [DISTRIBUTION.md](DISTRIBUTION.md#publishing-the-formula-owner)), and `node scripts/startup-probe.mjs` is a dev-only breakdown of where startup time goes, in temp dirs only.

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
│   ├── hook.ts          `ccinfobar hook <Event>`: silent, append one line, exit 0
│   ├── progress.ts      syncProgress: the wanted OSC 9;4 value after stdout
│   └── progress-tty.ts  the tty progress channel: find and write the parent's terminal
├── commands/            install, update, doctor, manage, config-cmd; loaded with import() per command
│   ├── catalog.ts       `ccinfobar catalog`: list, show, history, apply, save and the other local subcommands
│   ├── catalog-market.ts `catalog publish`, `install`, `login`, `logout`, `report` and `--remote`, the one lazy entry for marketplace code
│   ├── catalog-admin.ts `catalog admin`, loaded by catalog-market.ts only when asked for
│   ├── install.ts       planInstall / applyInstall / uninstall
│   ├── hooks-install.ts hook planner, version floor, applyHooks / uninstallHooks
│   ├── hooks-doctor.ts  doctor's Hooks block: entry state, missing binaries, hook gates
│   ├── explain.ts       `ccinfobar explain` and the read-only loader doctor shares
│   ├── bench.ts         `ccinfobar bench`
│   ├── report.ts        `ccinfobar report`: flags, output, progress line, `--rebuild`
│   ├── repos.ts         the `repos --background` alias
│   ├── worker.ts        hidden `ccinfobar worker <key>...`: runs due background jobs
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
│   ├── i18n/            t(), the language registry and resolver, en/ and tr/ message tables, tr/meta/
│   ├── renderer.ts      lines → ANSI text (styles, separators, flex, rules, priority, truncation)
│   ├── themes.ts        theme logic, user theme loading and resolution
│   ├── themes/          builtin.ts (theme data) and style.ts (types and style tables), both pure
│   ├── ansi.ts          colors, gradient stops and style(); re-exports the width functions
│   ├── width.ts         grapheme-aware width and truncation (pure)
│   ├── eaw-table.ts     generated Unicode width ranges (scripts/gen-eaw.mjs)
│   ├── conditions.ts    showWhen/hideWhen parser and evaluator (pure)
│   ├── metrics.ts       rule metrics, computed lazily on the render side
│   ├── glyphs.ts        glyph mode resolution and folding (pure)
│   ├── context.ts       render context with lazy data sources
│   ├── inspect.ts       per-widget value, source and empty reason
│   ├── trace.ts         records what a widget read during render
│   ├── scenarios.ts     named payload and data situations
│   ├── cache-rule.ts    Claude Code's cache miss rule and the latest-miss check (pure)
│   ├── jsonpath.ts      the http widget's JSON path subset (pure)
│   ├── http-spec.ts     http URL templates, header specs and the env deny-list (pure)
│   ├── http-report.ts   redacted http URLs and headers for doctor and explain (pure)
│   ├── profiles.ts      built-in model profiles and resolveProfile (pure)
│   ├── time.ts          epoch seconds, milliseconds and ISO to ms; day, ISO week and month keys (pure)
│   ├── prices.ts        dated Anthropic list prices, model id normalization, requestCost (pure)
│   ├── report-types.ts  report contracts and caps (pure)
│   ├── report-model.ts  parseRange and buildReport: periods, one cost source per session, totals (pure)
│   ├── report-format.ts report table, CSV and JSON (pure)
│   ├── edit.ts          pure edit operations shared by both editors
│   ├── presets.ts, sample.ts, preview.ts, paths.ts
├── data/                git, transcript, GSD and terminal readers; store.ts, provider.ts
│   ├── limits.ts        shared plan limits store, keyed per account
│   ├── ledger.ts        cross-session cost ledger
│   ├── report-index.ts  transcript walk, scan, dedup and the persisted report index
│   ├── live.ts          trusted turn, permission wait and running tools (pure)
│   ├── environment.ts   CLAUDE.md, rules, MCP and hook counts from config files
│   ├── repos.ts         child repos of a workspace folder and the dirty cache
│   ├── repos-dirty.ts   the dirty check the repos job runs
│   ├── self-update.ts   latest-release check and npm install for the update job and `ccinfobar update`
│   ├── jobs/            background job runner, registry and one module per job
│   ├── progress.ts      progress sequence, terminal allowlist and want files (hook-safe)
│   └── hooks.ts         hook log line format, fold and reader
├── widgets/             one file per category, registered in index.ts
│   ├── live.ts          tool-activity, turn-timer, permission-wait
│   ├── activity.ts      activity-strip
│   ├── fun.ts           pet, kaomoji, quip
│   └── projection.ts    usage projection, ETA and risk math (pure)
├── importers/           `ccinfobar import` and the install offer; loaded only by manage.ts and install-cli.ts
│   ├── index.ts         source registry, discovery, readSource (1 MB cap), importFrom, toConfig
│   ├── confirm.ts       sanitizeImport and the command/URL targets of the confirmation step
│   ├── toml.ts          TOML 1.0 parser with positioned errors (pure)
│   ├── colors.ts        c16/c256/rgb, Starship style and claude-hud color mapping (pure)
│   └── ccstatusline.ts, claude-powerline.ts, ccometixline.ts (+ -themes.ts), cship.ts, claude-hud.ts
├── catalog/             the catalog; used by the catalog commands, the editor and market/client.ts, never by the render
│   ├── model.ts         entry schema, version ops and share states (pure)
│   ├── system.ts        built-in bundles, presets and themes as entries
│   ├── snapshot.ts      current config to preset, theme or bundle content
│   ├── store.ts         entry files, legacy adoption, theme install, profile and credentials
│   ├── share.ts         content hash and share state
│   ├── publish.ts       publish plan and run, remote list and show
│   ├── install.ts       verified install plan and run, with origin and consent targets
│   ├── market-cache.ts  24-hour index cache, conditional refresh, cached version documents
│   └── signin.ts, login-flows.ts  finish a GitHub sign-in; the editor's device-flow sessions
├── market/              marketplace protocol, client, reference server and Worker
│   ├── protocol.ts      v1 paths, parsers, limits, error codes and content policy (pure)
│   ├── rules.ts         pure server rules shared by the reference server and the Worker
│   ├── endpoint.ts      endpoint check
│   ├── client.ts        bounded marketplace client
│   ├── github.ts        bounded GitHub device-flow client (CLI and editor server only)
│   ├── server.ts, serve.ts  reference server, built with `node scripts/build.mjs --market`
│   └── worker/          Cloudflare Worker, built with `node scripts/build.mjs --worker`
├── editor/              web editor: HTTP server + browser app (web/)
│   └── detach.ts        `edit --detach`: reuse or spawn a background editor
└── tui/                 terminal editor: state, view, keys, IO loop
.claude-plugin/
└── marketplace.json     this repo as a Claude Code marketplace
worker/                  wrangler.jsonc and D1 migrations/ for the Worker; dist/ is gitignored
plugin/                  the ccinfobar plugin
├── .claude-plugin/plugin.json
└── skills/              edit, doctor, theme, install, uninstall (one SKILL.md each)
scripts/
├── clean-install.mjs    pack, install, render and uninstall in an empty profile
├── gen-eaw.mjs          regenerate src/core/eaw-table.ts by hand from pinned Unicode data
└── sync-plugin-version.mjs  copy the package version into plugin.json and INSTALL.md
```

Rendering flow:

1. Claude Code pipes a JSON payload to `ccinfobar` on stdin.
2. `cli/render.ts` sanitizes the payload with `ingestPayload`, loads the config and builds a `RenderContext`. Git, transcript and GSD data are read lazily, only if a widget asks for them.
3. Each widget's `render(ctx, item)` returns a string, `{ text, color }` or `null` to hide itself.
4. `renderer.ts` checks each widget's visibility rules before rendering it, adds labels, colors and separators, fills `flex` space and then wraps, truncates or drops widgets by priority to fit the terminal width.
5. Spaces become non-breaking spaces and every line starts with a reset code, so Claude Code's dim style and whitespace trimming don't alter the output. This holds in every glyph mode; `paste-safe` gets plain spaces and stripped links only in `ccinfobar preview` (`finalizeLine(line, { pasteSafe: true })`).

The transcript reader keeps an incremental cache in the cache directory, so only newly appended bytes are parsed on each refresh. After stdout, `syncProgress` records the terminal progress value when `progress` is configured (see [Terminal progress](#terminal-progress)), and `scheduleJobs` starts at most one detached worker for the background jobs that are due (see [Background jobs](#background-jobs)).

### Writing files

`src/data/store.ts` is the only module that calls `writeFileSync` or `renameSync`. `writeAtomic` writes a temp file and renames it, retrying on Windows when antivirus briefly locks the file. `test/foundations/atomic-writes.test.ts` fails if any other file under `src/` writes directly.

### Lazy CLI

`cli/main.ts` parses arguments and loads each command with `await import()`. The status line path (`cli/render.ts`) never pulls in install, update, doctor, report, the importers, the editors or the TUI. `test/foundations/import-graph.test.ts` checks this, and that the pure modules (`core/edit.ts` and others) have no `node:` imports.

### Install and uninstall

- `commands/settings-file.ts` reads and writes `settings.json`. It keeps BOM, line endings, indent, trailing newline, mode, owner and symlinks, refuses to write a file that does not parse, merges again if the file changed during the write, and stores a 0600 copy in `<configDir>/backups/` before every change (newest 10 per file plus a never-rotated `-original.json`).
- `commands/manifest.ts` keeps `<configDir>/manifest.json`: each statusLine and `.git/info/exclude` line ccinfobar wrote, and how to restore what was there. Ownership is deep equality with the recorded value, never a search for "ccinfobar" in the command.
- `commands/install.ts`: `planInstall` works out the change without writing; `applyInstall` writes it and refuses to replace another tool's statusLine unless `confirmed`. The CLI, `--project`, the GSD takeover, the background update, the editor and the TUI all go through this pair. `uninstall` restores from the manifest.
- Install kinds (`data/update-state.ts`): `brew` is detected from `/Cellar/ccinfobar/` in the realpath of the entry script, after `npx` and `local` and before `npm-global`. `effectiveUpdate` turns `auto` into `notify` for a brew copy, so the status line notice, `ccinfobar update`, the background check, `doctor` and the web editor only point at `brew upgrade ccinfobar` and never run npm. `install` writes `<brew prefix>/bin/ccinfobar` as the statusLine command, never a `/Cellar/` path.

### Untrusted text

Text from outside is sanitized where it enters, not in each widget: the stdin payload (`ingestPayload`), git output, the transcript, subagents and GSD planning files go through `core/sanitize.ts`. The `command` widget with `preserveColors` keeps only SGR colors and safe links; PR and `link` URLs must pass `safeUrl`; `env` values are plain text. Git calls add `core.fsmonitor=false` and `--no-optional-locks` and blank repo-local filter drivers (`gitHardening`, on by default).

### Broken config

`inspectConfigText` in `core/config.ts` reports a config that does not parse, or whose `lines` is not an array, with its line and column (from `core/json-locate.ts`). The status line then shows `config error at line N` instead of the default layout, and `saveConfig` throws `ConfigBrokenError`, so the editor, TUI, `theme`, `install` and `config set` never overwrite the file. Only `init --force` and `import` replace it, after a backup. `doctor` prints the line, column and message. Rendering never writes the config.

### Width engine

`src/core/width.ts` measures text the way Claude Code does (string-width rules) and is pure: it imports only `eaw-table.ts` and reads no env. `ansi.ts` re-exports `visibleWidth`, `truncate`, `charWidth` and `stripAnsi`, so callers did not change. Three tiers:

1. Every code unit below U+0300 (below U+00A1 with `ambiguousWidth: 2`): a plain loop, so ASCII lines cost what they did before.
2. No grapheme-joining code point (ZWJ, variation selectors, skin tones, regional indicators, keycap, combining marks): one table lookup per code point. Box drawing, blocks, Braille, CJK and Nerd Font icons stay here; the segmenter is the slow part.
3. Anything else: one cached `Intl.Segmenter`, summing cluster widths. An RGI emoji or a pictograph with VS16 counts as the emoji width (2, or 1 in jetbrains mode); a cluster otherwise takes the width of its first non-zero code point.

Tier 2 must give the same result as tier 3; a seeded property test in `test/core/width.test.ts` checks it in every mode, next to a fixture table of about 150 rows. `truncate` cuts only between clusters, keeps escapes inside a cluster with it, closes open links and resets SGR.

The width mode (`{ emoji, ambiguous }`) is a module default: `render()` sets it with `setWidthMode(widthModeFor(...))` and restores the previous one in `finally`, and `inspect` does the same, so editor previews with different configs never leak into each other. `visibleWidth` keeps one argument (it is passed to `map()`); measure in an explicit mode with `visibleWidthIn(text, mode)`.

`src/core/eaw-table.ts` (WIDE, AMBIGUOUS, ZERO and JOIN ranges, Unicode 16.0.0) is generated by `node scripts/gen-eaw.mjs`, which is run by hand, never by a build or CI. It downloads four Unicode data files, checks each against a pinned sha256 and fails on any mismatch; `--from <dir>` reads local copies instead. `string-width` is not a dependency, and the import-graph test fails if `src/` imports it.

### Visibility rules

- `src/core/conditions.ts` is pure (in the PURE list) and shared with both editors: a sticky-regex tokenizer, `parseRule` (an AND of ORs, never `eval`; 256 characters, 8 terms and 8 strings at most), error codes with positions, `formatRule`, and `evaluate(rule, get, prev?)`, where a `null` value makes every comparison false and a `~N` band walks the earlier samples back from the newest: it stays on if the last sample past the threshold came before any sample outside the band. `itemRules` memoizes the parse per rule value. `itemVisible` fails open: an invalid rule counts as absent and is reported.
- `src/core/metrics.ts` is the render side: a `Map` of getters, each run only when a rule names its metric, wrapped in `try` and memoized per `ctx.data` in a `WeakMap`, so the `{ ...ctx }` copies the renderer makes share one memo. Percentages are rounded and costs kept to cents, like the widgets show them. `git` and `gsd` presence is a stat walk for `.git` or `.planning` (`findUp` in `data/repos.ts`), never a git call. `metricPrev` returns the earlier limits samples or session history values (rounded, oldest first) for bands; nothing is written.
- `visible(ctx, item)` in `renderer.ts` runs at the top of `renderPart`, before the widget renders, so a hidden widget does no I/O of its own; items without rules skip all metric work. The workspace pre-pass uses it too. `inspect` runs `ruleDecision` on the traced context, so `explain` lists the rule's reads as sources.
- `edit.ts` has the editor helpers (`ruleQuickState`, `setRuleQuick`, `setItemRule`, `RULE_PRESETS`) and `timeRuleFeed`, which adds items with `time.*` rules to the refresh hint.

### Priority overflow

`compose(parts, a, level, max)` groups the rendered parts, runs the style renderer and fills `flex` space; `renderLine` calls it once and, when `overflowOf(config)` is `priority` and the line is too wide, runs the drop loop. `toUnits` turns the parts into units (a run joined by `merge` is one unit with the highest member's priority; layout parts belong to the chain they are merged into and never form a unit of their own), and `dropByPriority` removes the lowest unit (the rightmost on a tie) and composes again, without rendering any widget again, until the line fits or one unit is left; then the line is truncated. Below-lines go with their part. `overflowOf` is `overflow ?? (autoWrap ? 'wrap' : 'truncate')`; the other modes take the old path untouched. `CATEGORY_PRIORITY` holds the category defaults. The panel style does not use this loop. `renderLine` can report the dropped ids, which `explain` (`dropped-by-priority`) and the web editor's badge use.

### Glyph modes

`src/core/glyphs.ts` is pure: `resolveGlyphMode(config, env)` (the caller passes the env, for `auto`), `widthModeFor`, `foldText` (VS16 after a pictograph, fullwidth ASCII, then the `NARROW` table of one-column forms) and `pasteSafeText`. `render()` resolves the mode once and passes `glyphMode` on the context. `normalizeResult` folds widget text after sanitizing it and `renderPart` folds labels; `paste-safe` also resolves the charset to `text`, strips Nerd Font private-use glyphs and OSC 8 links, and `finalizeLine({ pasteSafe })` keeps plain spaces. Defaults are byte-identical to before, which a fixture rendered from the code before glyph modes checks.

Bars: `gradientColor(pct, stops)` in `ansi.ts` takes the theme's `gradient` stops (or the built-in ones) and caches per array. A gradient bar emits only foreground codes and ends with `\x1b[39m`; `style()` swaps that 39 for the part's own foreground, so backgrounds and part colors survive in every style.

### Explain and inspect

`core/inspect.ts` turns a render context into one row per widget: its value, its sources and, when it is empty, a reason code. It has no I/O and no `node:` imports. `commands/explain.ts` holds `loadInspectInput`, the read-only loader shared by `explain` and `doctor`: it picks `--payload`, `--scenario`, the last saved payload or the sample, and reads the transcript, subagents and history without writing caches. `explain` replaces `env`, `command`, `http` and `tool-activity` values with `<redacted N chars>`; only `--show-values` in a terminal prints them, and `--json` never does.

The editor preview needs no trace: `renderPreviewReport` renders once with a `sink` on the context, where `renderPart` records the ids a rule hid and `renderLine` the ids priority overflow dropped, and a per-context `values` map keeps each widget to one render. `lineReport` (doctor) also renders each line once; `LineReport.natural` is its width before overflow handling.

`inspectRows` wraps the render context with a trace from `core/trace.ts`, which the normal render path never does. The trace records the payload paths, env key names and data calls each widget makes, never their values. Widgets whose reads the trace cannot see (system info, `command`) declare `WidgetDef.sources` as a hint. Tests: `test/core/inspect.test.ts`, `test/core/trace.test.ts` and `test/commands/explain.test.ts`.

### Scenarios

`core/scenarios.ts` is a pure module (it is in the import-graph test's PURE list). Each scenario is a payload, an env and a `Required<DataSources>` set of injectors, built against the fixed clock `SCENARIO_NOW`, so its output never depends on the machine or the date. Because the type is `Required<DataSources>`, every new `DataSources` member must ship with an injector in every scenario, or `npm run typecheck` fails. `preview --scenario`, `explain --scenario`, `bench --scenario` and the editor's Scenario picker all use it.

### Cache rule

`src/core/cache-rule.ts` is pure and holds Claude Code's miss rule. `classify` calls a request a miss when its cache reads fall below 95% of the smaller of the previous and the current input and the shortfall is at least 2,000 tokens; the request after a compaction is `expected`. `latestMiss` says whether the latest request missed (`last_miss_at` within 2 s of `expires_at − ttl`), or `unknown`. When the payload has `prompt_cache` it is the only source; the transcript reader applies `classify` only when it is missing.

### Limits store

`src/data/limits.ts` shares plan limits between sessions. `accountKey(env)` hashes the provider kind, the resolved Claude config dir (lowercased on win32 only) and `CLAUDE_SECURESTORAGE_CONFIG_DIR` into 16 hex chars. The store is `<cacheDir>/limits/<accountKey>.json`; the OAuth usage cache is the `<cacheDir>/jobs/usage-<accountKey>.json` envelope, falling back to the older `<cacheDir>/usage-<accountKey>.json` (a legacy `usage.json` is only read, when `CLAUDE_CONFIG_DIR` is unset; it may come from another config dir, so its values count as an unknown capture and lose to any known one).

- Capture time is the transcript's last assistant message (`lastAssistantAt`), else the transcript mtime, else unknown. The usage worker stamps its result with `fetchedAt`.
- Merge (`pick`): only plausible windows (pct in range, reset in the future and no further than one window length plus 10 minutes ahead). The latest reset wins, then the newest capture, then the payload over the API, then the higher pct; a payload value (0.1% steps) beats an API value (whole percents) that is less than 1 point away, whatever their capture times. Expired windows are dropped and never stored. With nothing plausible, this session's own unexpired payload window, then an API `resets_at: null` bucket, is shown but not stored.
- Each window keeps a ring of up to 32 samples for the projection widgets, fed by payload observations only. Within 60 s (5h) or 20 min (7d) of the last point an unchanged pct is skipped and a changed one replaces a still-open last point; otherwise a point (flat or not) is added. A new window clears the ring. The `recent` pace fits these samples plus the current value, with gaps filled linearly, so an idle stretch lowers the slope.
- Two gates in `effectiveUsage`: `limitsOn` (the provider has plan limits and a limits widget is configured) controls the store read; `usageOn` (`limitsOn`, `usageApi` not disabled, and data missing) controls the usage cache read and the worker.
- `recordLimits` runs after stdout with the unmerged payload, writes 0600 and only on change, and never throws. There is no lock: just before writing it reads the file again and, if another writer got in, merges its observations into that version instead (up to three tries). `recordUsageApi` does the same for the worker and empties the store when the login changes; the worker keys the login on a hash of `oauthAccount.accountUuid` (from the credentials or `.claude.json`), else the refresh token, else the access token, keeps it through error and no-login caches, and never writes it to the limits file.
- `explain`, `doctor`, `preview` and the editor read the store and never write it.

### Cost ledger

`src/data/ledger.ts` keeps estimated cost across sessions. `recordLedger` runs after stdout, only when `ledgerOn(config)` (a `cost-today`, `cost-week`, `cost-project`, `activity-strip` or daily `budget` widget), and appends one line through `appendLine` in `store.ts` (flag `a`, mode 0600) to `<cacheDir>/ledger/YYYY-MM.jsonl`:

```json
{"v":1,"t":1760400000000,"a":"<accountKey>","s":"<session id>","p":"<project root>","tp":"<transcript hash>","c":4.12}
```

`c` is the raw `cost.total_cost_usd`, so the summary can be rebuilt from the files (Phase 9 `report`). A line is written only when the session is new or `c` matches none of its segment highs.

- Fold (`credit`): per session up to 16 segments, each with its high-water total. The first sighting is a baseline and credits nothing. A total at or above a segment high credits the difference to the closest high below it, raises that high and moves the segment to the front; a seventeenth segment drops the least recently updated one. A total below every high starts a new segment and credits nothing (only a reset to about 0, such as `/login`, credits its few cents), so two processes interleaving or a restored older total never count twice.
- `summary.json` holds per-file byte offsets, per-session segments, and per-day and per-project totals by account. `readLedger` folds only the bytes after the stored offsets, up to the last newline, skips invalid lines, and rebuilds when a file shrank. A cold rebuild folds month files oldest first, so a session that spans two months keeps its high across the boundary; the render reads at most 256 KB before stdout (`RENDER_BUDGET`), `recordLedger` continues an unfinished fold after stdout with up to 16 MB (`BYTE_BUDGET`), and the view is `partial` (the cost widgets add `…`) until the build is done.
- Widgets get `ledgerView`: today, ISO week, month and project totals for the current account, plus this render's pending delta.
- Step function: `stepLine(sessions, text)` validates one line, applies `credit` and returns `{t, a, s, p, c, delta, first}`; `foldLine` and `stepText` (complete lines only) are built on it, so the summary and the report credit the same deltas. `rebuildSummary(env)` refolds every month file from zero with no byte budget, prunes and writes `summary.json` atomically (mode 0600); it never touches the month files. Day, ISO week (`YYYY-Www`, ISO week-year) and month keys live in the pure `core/time.ts`. `accountKeysForDir(env)` gives the keys of all eight provider kinds for one config dir.
- Activity slots (`activity-strip`): `summary.slots` holds, per account, the credited delta per UTC 15-minute slot (`slotKey(t) = floor(t / 900000)`, which lines up with local quarter-hours in every real offset), filled in `foldLine`, so it rebuilds from the month files like everything else. `parseSummary` keeps only valid accounts, numeric keys and finite costs. Slots older than 7 days are dropped by `pruneLedger` and whenever a fold moved (the summary is written then anyway), so the render never parses months of slots. `ledgerView(...).slots` covers the last 7 days, with this render's pending delta in the current slot. A summary without `slots` (written before slots existed, or rewritten by an older ccinfobar that does not know them) is kept: its offsets and totals stay valid, `slots` starts empty and the activity history starts from that point. It never triggers a rebuild, so an older pinned ccinfobar sharing the cache only costs the slots it strips.
- Retention (`pruneLedger`, when an append creates a new month file): month files older than 13 months, day and project rows older than 400 days, and sessions not seen for 30 days.
- `explain` and `preview` read with `persist: false` and never call `recordLedger`. `test/data/ledger-concurrency.test.ts` checks that 8 processes appending at once never tear a line.

Every new `DataSources` member (`limits`, `ledger`) has a sample injector in `core/sample.ts` and one in every scenario, and `ctxWith()` in tests defaults to the sample.

### Reports

`ccinfobar report` (`commands/report.ts`) reads one Claude config dir per run (`claudeDir(env)`), and two sources only:

- **Ledger** (`<cacheDir>/ledger/YYYY-MM.jsonl`): cost. `report-index.ts` folds the raw month files through `stepText`, the same step function as `summary.json`, so both credit the same deltas; it does not read `summary.json`. Ledger lines count when their account key is one of `accountKeysForDir(env)` (all eight provider kinds of this dir).
- **Transcripts** under `<claudeDir>/projects/`: tokens, active time, the session's project and the cost fallback. Main transcripts are `projects/<enc>/<sid>.jsonl`; subagent files (`<sid>/subagents/*.jsonl`) belong to the parent session. The walk has a fixed depth, skips symlinks and stops at `MAX_REPORT_FILES` (100,000) with a note. Lines are read in chunks, a substring check skips lines that cannot hold usage before `JSON.parse`, and lines over 16 MB are skipped and counted. `<synthetic>` models and `toolUseResult.usage` never count.

Dedup is global across every file of the dir: the key is `message.id:requestId`. Inside a file the last line's usage wins (later lines carry the final `output_tokens`); across files one file owns it, so subagent files, sidechain copies and forked or resumed transcripts never count a request twice. Files are read in content order (the timestamp of the first entry, then the birth time, then the path), not by mtime, because resuming the original after a fork makes it the newer file; when a main transcript that starts earlier meets a key another main transcript owns, it takes the key and its tokens over, so a cold scan, a warm one and `--rebuild` agree. Lines with neither id (missing, `null` or empty) count each time, as in the render-path reader. Each request goes to the day of its own timestamp, in the local time zone. Every file entry and the ledger part record the zone (`Intl` IANA id) their days were cut in; when it changes, present transcripts are read again and the ledger part is folded again, while deleted transcripts keep their old days and an `old-zone` note says so.

- **Cost, one source per session** (`report-model.ts`): the ledger when it saw the session from its start; else the transcript estimate when every request has a price; else the partial ledger value (row marked `*`); else unknown. Never a sum of sources. Prices (`core/prices.ts`): a `costUSD` on the entry, then `profiles.models` overrides, then the built-in Phase 6 profiles for non-`claude-` ids, then the dated Anthropic table (`PRICES_UPDATED`), with 5m and 1h cache writes, fast mode and a long-prompt tier where the table has one. Non-USD profile costs stay apart.
- **Project**: the ledger's `p`, else the first absolute `cwd` in the main transcript (normalized like `projectRoot`), else the decoded `projects/<enc>` name, marked approximate.
- **Active time**: gaps between timestamped entries of the main transcript, each capped at 5 minutes, on the day of the later entry. Subagents add no time. Lines that a fork or resume copied from another main transcript move a copy horizon, and gaps before it are not counted again.
- **Periods**: local `dayKey`, ISO week (`YYYY-Www`, ISO week-year) and month keys from `core/time.ts`; `parseRange` turns `--period/--since/--until/--all` into inclusive day keys.
- **Output** (`report-format.ts`): the table fits `columns` on a TTY by dropping cache write, cache read, input and output, then middle-truncating the project (all width math through `visibleWidth`); CSV has a fixed English header, CRLF, RFC 4180 quoting and a `'` guard for cells starting with `= + - @` (or their full-width forms), TAB, CR or LF; JSON is a `v: 1` object with English note texts. Notes are codes with params; only the table translates them.

`report.ts`, `report-model.ts`, `report-format.ts`, `report-types.ts`, `prices.ts` and `report-index.ts` are on `EXCLUDED_FILES` in `test/foundations/import-graph.test.ts`, and after a build the cli and hook chunks must not contain `report-index` or `TomlError`. A lazy entry that reaches only part of a render chunk splits it, so `cli/main.ts` hands `runReport` a `ReportDeps` object (`loadConfig`, `applyLanguage`, the ledger fold helpers, `accountKeysForDir` and the built-in model profiles) and report code imports none of `config.ts`, `cli/lang.ts`, `ledger.ts`, `limits.ts` or `profiles.ts`; `normalizeRoot` and `displayRoot` live in `core/paths.ts` for the same reason. The guard test checks that closure. Report code still reaches `widgets/shared.ts`, `ansi.ts` and `time.ts` without `repos.ts` and `cache.ts`, which costs the render one chunk (19 instead of 18); closing it would mean handing formatting and day helpers into the pure model and format modules.

### Report index

`<cacheDir>/report/<first 16 hex of sha256(resolved config dir, NFC, lowercased on win32)>/` (dir 0700) holds two files written with `writeAtomic` (0600), only when something changed:

- `index.json`: `{ v: 1, claudeDir, at, keys: { n, stamp }, order, files, ledger }`. Per transcript file: kind, session id, `dev:ino` identity (bigint stat), size, mtime, read offset, a cyrb53 hash of the 256 bytes before the offset, per-day/model buckets, time, the last 64 keys, the skipped-line count, the first entry timestamp and the birth time. The first cwd is kept normalized (lowercased on Windows, which is the project key) and, on Windows, also in its own letter case, which rows, CSV and JSON show. `ledger` keeps month-file offsets and per-session credit state.
- `keys-<stamp>.bin`: the request key set, a 16-byte header (`CCRK`, version, count, the random stamp that `index.json` names) and 12 bytes per key (float64 key hash, uint32 index into `order`). It is named after its stamp and written before `index.json`; older key files are removed only after `index.json` is written (one younger than 10 minutes is left for a concurrent run), so a crash between the two writes leaves the pair the last `index.json` names. A missing key file or a count or stamp that does not match means the present transcripts are read again from 0, while deleted ones keep their totals and seed the key set with their last 64 keys; a `keys-lost` note says copies of them may count twice. An entry that fails validation is dropped on its own, a bad ledger part is folded again, and the `claudeDir` check uses the same NFC and Windows lowercase form as the index dir hash.

A file with the same identity, size and mtime is not opened. A grown file is read from its offset after the tail hash matches; a shrunk, rewritten or re-identified file is read again from 0 and its keys are released. The key set is loaded lazily, only before a file is read. Files that are gone keep their totals and keys for the current month and the 12 before it (the ledger's retention), so history survives Claude Code's `cleanupPeriodDays`; they show up as a note. `--rebuild` re-reads every walked file, refolds the ledger part from zero and calls `rebuildSummary(env)`; without it, report never writes the ledger or `summary.json`. The index holds only numbers, key hashes, sanitized model ids, session ids and normalized paths.

### TOML subset

`importers/toml.ts` is a pure, single-pass recursive-descent parser for TOML 1.0: comments, bare/quoted/dotted keys, `[table]` and `[[array of tables]]` with sub-tables of the last element, the four string kinds with every escape, integers (`_`, `0x`/`0o`/`0b`), floats (`inf`, `nan`), booleans, the four date-time kinds kept as source text, multi-line arrays and single-line inline tables. One BOM is stripped and CRLF is accepted.

Everything else is a `TomlError { code, line, col }` (1-based line, code-point column at the offending token; header errors point at the `[`), never a guess: duplicate keys, table redefinition, extending an inline table, mixing arrays of tables with other values, bad escapes and numbers, control characters, unsafe integers, and `__proto__`/`constructor`/`prototype` keys. TOML 1.1 constructs (`\e`, `\xHH`, a newline or trailing comma in an inline table, a time without seconds) get a message that names them and the 1.0 form. Input is capped at 1 MB (`MAX_TOML_CHARS`) and nesting at 32 (`MAX_TOML_DEPTH`); tables have a null prototype. Echoed keys and characters are shown as `U+XXXX` when they are control, bidi or BOM code points. The importer prints `<file>:<line>:<col> <message>`.

There is no TOML devDependency. The oracle is hand-written vectors with exact error positions (`test/importers/toml.test.ts`) plus a seeded round trip: `test/importers/toml-serialize.ts` writes generated values in header, dotted, inline and mixed styles, and `parse(serialize(v))` must deep-equal `v` (`toml-roundtrip.test.ts`; the seed is in the failure message).

### Importers

Each importer turns a raw source into `{ config, notes, file, source }` (`ImportResult`). Notes are `{ kind: 'approx' | 'drop' | 'info', text }`, already translated, with every foreign name sanitized. Importers only read files; nothing in a config is run, sourced or expanded, and secrets (API keys, auth headers, service keys) are dropped with a note and never copied.

- `importers/index.ts`: `IMPORT_SOURCES`, `IMPORT_ALIASES` (built from the registry), `importFrom`, the discovery of the five Phase 9 tools (`ccstatuslinePath`, `powerlinePaths`, `cshipDiscover`, `hudPaths`; `ccometixlinePaths` is in `ccline-load.ts`, shared with best-claude-hud and byebyecode), `detectTool` and `sniffTool` for the install offer.
- `importers/io.ts`: `readSource` (opens the file without blocking, fstats the fd and refuses anything but a regular file, reads at most 1 MB + 1 byte, `SourceTooLargeError` above that, strips a BOM), `isFile`, `isPlainFile`, `readToml`, `readJsonTool`, `tableOf`, `safeThemeName`, `expand(p, home)`, `homeOf(env)` (the `os.homedir()` order: `USERPROFILE` first on Windows, `HOME` elsewhere) and `shownFile(file, home)`, which tildes against the injected home; `readToml` and `readJsonTool` take that home for their error paths.
- `importers/args.ts`: `commandArgs` splits a status line command (quotes group, backslashes stay literal so Windows paths survive), `flagValue`, `boolFlag` (Go style `-x=false`), `firstPathToken`, `binName`/`isBin` (a token's program name without `@version` or `.exe`) and `toolArgs`, the argv from the tool's own token on (also inside a quoted `sh -c` script), or `null` when the command runs something else.
- `importers/themes-map.ts`: `mapTheme(name, { exact, approx, fallback }, tool)` gives a built-in theme id plus an approx or missing note. `colors.ts` has `namedColor` and `rgbColor` next to the ANSI and Starship helpers.
- `importers/shell-env.ts`: `parseShellEnv` reads plain `NAME=value` and `export` lines with shell quoting, keeps the basename and path of a `.`/`source` include and reports every other line by number (coralline; pyccsl has its own `parsePyccslEnv` that mirrors pyccsl's reader). It never runs or expands anything.
- `importers/registry.ts`: an `ImporterDef` per tool (`source`, `name`, `repo`, `aliases`, `shown` for the help, `detect` regexes, `tool(token)` for tools that read command flags, an optional `sniff: { file, marker, bytes? }`, `hasDefault`, an optional `named(ctx)` for a file the command or env names, `discover(ctx)`, `load(file, ctx)`) in `REGISTRY`, plus `LEGACY_INFO` for the five Phase 9 tools. `importerList()` is `LEGACY_INFO` then `REGISTRY` and must match the `IMPORT_SOURCES` order. `loadFromRegistry` handles `--file`, discovery, the default layout when `hasDefault` is set (with a note naming a missing `named` file) and the `import.notFound` error, with an `ImportCtx` (`command`, `args`, `argv`, `env`, `cwd`, `home`) so tests inject everything. Flags are read from `argv` only, which is empty when the command does not run the tool; then a note says its flags were not read. The Phase 9 tools follow the same rule in `importFrom`.
- `commands/import-help.ts`: `ccinfobar import --help`, one row per `importerList()` entry. It loads through `commands/manage.ts` so the render chunks stay whole.

`detectTool` tries, first match wins: the `detect` patterns of `REGISTRY` (so `best-claude-hud` and `claude-ultimate-hud` come before `claude-hud`), the Phase 9 tools, reviewed tools with nothing to import (`OTHER_KNOWN`, `importable: false`), then ccusage and gsd. When nothing matches, `install` calls `sniffTool`, which reads the first 512 bytes (or the def's `bytes`) of the script a `sniff` def names (no symlinks, never run) and tests its `marker`; claude-code-statusline (rz1989s) is found this way because daniel3303/ClaudeCodeStatusLine installs the same `~/.claude/statusline/statusline.sh`, which `OTHER_SNIFF` names by its `# Source:` line.

`runImport` in `commands/manage.ts` is the one path for `ccinfobar import` and the install offer:

1. `sanitizeImport` (`importers/confirm.ts`) deep-sanitizes the partial config (labels, text, separators, commands), drops `__proto__` keys and `javascript:`/`data:` links.
2. The confirmation step lists every `command` string, `http` URL, `link` URL and `env` variable name in full (wrapped, runs of spaces and invisible characters made visible). On a TTY it asks, default No; `--allow-commands` keeps them; `--yes` or a non-TTY run drops them and prints a re-run command quoted for the platform (`shellArg`). Targets over 2000 characters are kept only with `--allow-commands`.
3. The mapping report (`✓ Imported N widgets`, then Approximated, Dropped and Notes). `--dry-run` adds a preview with sample data, in which `command` items are replaced by sample text so nothing runs, and writes nothing. Otherwise the config is backed up and saved, keeping its `language`.

Adding an importer: a module in `src/importers/` with the pure mapper (its `TARGETS` list holds every widget type it can produce; a test checks each exists in `ALL_WIDGETS`) and its `ImporterDef`; the id in `IMPORT_SOURCES` and the def in `REGISTRY`, both in the same order; `import.*` messages in `en/` and `tr/` (notes reuse the existing keys where the text fits); the file on `SWEPT` in `test/i18n/literal-scan.test.ts`; hand-written fixtures under `test/fixtures/import/` with a row (upstream project, modelled-on file, license) in its README, which a test requires; a row in the `TOOLS` table of `test/importers/guards.test.ts`, which checks targets, option keys, choices, themes and styles, fixture round trips, hostile labels, prototype keys and that `--dry-run` writes nothing; `test/importers/importers.test.ts`, which pins `IMPORT_SOURCES`; the README table and docs/IMPORTERS.md, which `test/importers/docs.test.ts` checks; and `## Changelog bullets` in the plan summary. The help listing and `detectTool` pick the new def up from the registry.

### Catalog and marketplace

User docs: [CATALOG.md](CATALOG.md) and [MARKETPLACE.md](MARKETPLACE.md).

| Module | Role |
| --- | --- |
| `core/edit.ts` | `LAYOUT_KEYS`, `APPEARANCE_KEYS`, `PERSONAL_KEYS` and `applyCatalogContent(current, content, kind, themeId?)`. It copies only the kind's keys (own properties, so personal and unknown keys in content are ignored) and keeps `lines`, `theme`, `autoWrap` and `widthOffset` when the content leaves them out |
| `catalog/model.ts` | Pure and browser-safe: entry schema v1, `ENTRY_LIMITS`, `slug`/`marketSlug`, the version ops (`newEntry`, `appendVersion`, `overwriteVersion`, `restoreVersion`), share states (`setShare`, `markPublished`, `markWithdrawn`, `shareView`), `mergeRaw`, `parseEntry` |
| `catalog/system.ts` | `SYSTEM_BUNDLES` (15) plus the built-in presets and themes as entries, built at call time (`systemEntries({ gsd })`, `findSystem`) |
| `catalog/snapshot.ts` | `themeFromConfig` (shared with `POST /api/themes`) and `contentFromConfig(config, kind)` |
| `catalog/store.ts` | Node: user entries, legacy adoption, `installEntryTheme`, `profile.json`, `marketEndpoint`, `credentials.json` |
| `catalog/share.ts` | `entryHash`, `sendable`, `shareState`; imports only `node:crypto`, `protocol.ts` and `model.ts` |
| `catalog/publish.ts` | `publishPlan`, `planHash`, `runPublish`, `remoteList`, `remoteShow` |
| `core/entry-keys.ts` | Pure: `EntryKind`, `LAYOUT_KEYS`, `APPEARANCE_KEYS`, `PERSONAL_KEYS` and the content types, re-exported by `edit.ts`, so the Worker gets the key lists without the editor code |
| `market/protocol.ts` | Pure: paths (including sign-in, account, report and admin routes), `ID_PART_RE`, `MARKET_LIMITS`, `ERROR_CODES`, the parsers, `canonicalJson`, `contentProblems` |
| `market/rules.ts` | Pure server rules shared by both servers: route regexes, `CAPS`, rate windows, fixed English error messages, tombstones |
| `market/github.ts` | Device flow against github.com with bounded polling; never in the browser bundle or the Worker |
| `catalog/install.ts`, `catalog/market-cache.ts` | Install plan and run (hash check, consent targets, origin), the 24-hour index cache, conditional refresh and cached version documents |
| `catalog/signin.ts`, `catalog/login-flows.ts` | Finish a sign-in and store the marketplace token; the editor server's device-flow sessions |
| `market/endpoint.ts` | `checkEndpoint` (https, or http on loopback) |
| `market/client.ts` | `createMarketClient`, `validateReceived`, `contentHash`, on top of `requestJson` in `data/jobs/fetch.ts` |
| `market/server.ts`, `market/serve.ts` | Reference server and its command line, built by `node scripts/build.mjs --market` into the gitignored `market/` |
| `commands/catalog.ts` | `ccinfobar catalog` local subcommands |
| `commands/catalog-market.ts` | `publish`, `install`, `login`, `logout`, `report`, `publisher --check` and `--remote`; also re-exports the publish functions for the editor |
| `commands/catalog-admin.ts` | `catalog admin`, loaded with `await import()` from `catalog-market.ts` only |
| `market/worker/` | The Worker: `handler.ts` (routing), `store.ts` (D1 statements), `write.ts`, `auth.ts`, `moderation.ts`, `rate.ts`, `http.ts`, `page.ts`, `tokens.ts`, `env.ts` (hand-written Workers types) |
| `editor/server.ts` | `/api/catalog*` routes |
| `editor/web/catalog.ts`, `catalog-dialogs.ts`, `catalog-market.ts` | Marketplace page (Bundles, Presets, Themes, User and Built in tabs), save/history/share/delete dialogs, publish review, account bar, marketplace section and card previews |

**Why the content op lives in `core/edit.ts`.** `core/presets.ts` imports `edit.ts`, and presets is on the render path (`cli/render.ts` → `core/load.ts` → `core/presets.ts`), so `edit.ts` is in the render closure. It must stay pure and must never import `src/catalog/`. The catalog imports the key lists and `applyCatalogContent` from it (`model.ts` re-exports them), so the CLI, the editor server's previews and the browser all apply through one function. The browser wraps it in `replaceAll`, so applying is one undo step and nothing is written until Save.

**Lazy loading.**

- `cli/main.ts` loads `commands/catalog.ts` with `await import()`, and `catalog.ts` loads `manage.ts` the same way, so the catalog chunk never reaches the importers or jobs statically.
- `catalog.ts` loads `./catalog-market.js` with `await import()` only for the marketplace subcommands, and the editor server loads `../commands/catalog-market.js` only in the marketplace routes, after the endpoint check.
- `catalog-market.ts` is the only lazy entry for marketplace code. It imports `catalog.ts`, `publish.ts` and (through publish) `client.ts` statically, with named imports, so its closure covers whole render chunks. An `await import()` of `market/client.js` or `catalog/publish.js` anywhere, or a namespace import, made esbuild split the render chunks (19 became 22 or 20). The same reason moved `checkEndpoint` into `endpoint.ts` and the share helpers into `share.ts`.
- No module under `src/data/jobs/` imports `src/catalog/` or `src/market/`, so nothing publishes in the background.
- `test/foundations/import-graph.test.ts` enforces all of this: `src/catalog/` and `src/market/` are excluded from the render closure, `model.ts` and `protocol.ts` are pure, `catalog-market.ts` is the one entry, the closures of `catalog.ts` and `editor/server.ts` have no `publish.ts`, jobs never import either dir, and the built render and hook chunks carry no catalog or marketplace text.

**Store writes.** Only `store.ts` writes catalog files, always through `writeAtomic`.

- `commitEntry(next, expectedRev)` is the only entry writer. It re-reads the file: a missing file needs `expectedRev` 0, an existing one must have `rev === expectedRev`, and an unreadable one counts as changed. It writes `mergeRaw(raw, next)` with `rev + 1`, so keys from newer versions survive (an own `__proto__` key is dropped). The result must parse again and stay within 1 MiB, or nothing is written. The previous bytes go to `<id>.json.bak` first.
- Ids are `u-` plus 12 random hex characters; names never become file names. Reads strip a BOM and skip files over 4 MiB, other file names, and files whose `id` differs from the name.
- Delete renames the file into `trash/` (with the Windows rename retry), removes the `.bak`, moves a linked legacy file to the trash too, and keeps the newest 20.
- Legacy `presets/` and `themes/` files are only read until the user deletes them; `deleteLegacy` writes a trash copy before it calls `deleteUserPreset`/`deleteUserTheme`. Applied themes are written only by `saveUserTheme`, through `installEntryTheme`, which never overwrites a different theme (`<id>-2`, `-3`, …).
- `profile.json` and `credentials.json` writes keep unknown keys; `credentials.json` is mode 0600.
- A `changed` error becomes 409 `err.catalog.changed` in the editor, so a CLI change is never overwritten.

**Text.** Catalog text is the lazy `catalog` i18n area: `src/core/i18n/en/catalog.ts` and `tr/catalog.ts`, spread into `en/lazy.ts` and `tr/lazy.ts`, with ids under `catalog.*`, `err.catalog.*` and `market.*`. Every module that uses them imports `core/i18n/lazy.js`, including the browser modules, and `api.ts` accepts lazy ids when it translates an editor API `errorId`. System entry names and descriptions stay English in `system.ts` and are translated by `bundleText`, `presetText` and `themeDescription` from `tr/meta/catalog.ts`. Only the `help.cmd.catalog*` rows and the two `web.static.catalog*` header strings are in the main tables. The reference server speaks English protocol JSON only.

**Tests.** `test/catalog/`, `test/market/`, `test/commands/catalog*.test.ts` and `test/editor/catalog-*.test.ts` use temp dirs and never the network: the client gets `test/fake-fetch.ts` with `example.com` hosts, or the reference server runs in-process on `127.0.0.1` port 0 and is closed after each test. No-endpoint tests assert zero calls on both the injected fetch and `globalThis.fetch`.

**Worker.** `src/market/worker/` is plain TypeScript that runs on workerd without `nodejs_compat`. It may import only its own files, `market/protocol.ts`, `market/rules.ts`, `core/sanitize.ts` and `core/entry-keys.ts`, and none of them may use `Buffer`, `process`, `require` or `node:` modules; it hashes with `crypto.subtle`, while ccinfobar keeps the sync `node:crypto`. Nothing outside the folder imports it. `test/foundations/import-graph.test.ts` checks all of this, and that `market/github.ts` stays out of the Worker, the browser bundle and the render and hook paths.

- **Build.** `node scripts/build.mjs --worker` bundles `src/market/worker/index.ts` with esbuild (`scripts/worker-options.mjs`: platform neutral, ES2022, a plugin that fails on any Node import) into `worker/dist/index.js`. `worker/wrangler.jsonc` has `no_bundle: true`, so wrangler uploads that file as it is. `test/market/worker-bundle.test.ts` builds it and loads it in a `vm` context without Node globals.
- **D1 in tests.** `test/market/d1-sqlite.ts` is a D1 adapter over `node:sqlite` (`prepare`, `bind`, `first`, `all`, `run`, `raw`, `batch` as one transaction, `meta.size_after`). It loads `node:sqlite` through `process.getBuiltinModule`, never a static import, and `hasSqlite` is false on Node 20 and on Node 22 releases without `?NNN` parameters or `columns()`, so the Worker tests skip there (`describe.skipIf(!hasSqlite)`). Each test applies `worker/migrations/*.sql` to a fresh database (`test/market/worker-env.ts`).
- **Conformance.** `test/market/conformance.ts` holds the protocol v1 cases every server must pass. `conformance-ref.test.ts` runs them against the reference server and `conformance-worker.test.ts` against the Worker on the D1 adapter; server-specific cases stay in `server.test.ts` and the `worker-*.test.ts` files. `test/market/client-worker.test.ts` runs the real client against the Worker.
- **GitHub.** `test/market/fake-github.ts` answers `/user` and check-token as the Worker's injected `fetch`; the device-flow client (`github.test.ts`) gets an injected `fetch` too. No test reaches github.com or Cloudflare, and no test runs wrangler: `wrangler deploy --dry-run` runs only in the deploy workflow.

### Hooks

Hooks are optional. The render path never loads the hook writer; it reads the folded state through `DataSources.hooks` (see [Live session data](#live-session-data)).

- **Entry.** `bin.ts` takes the hook path only for `hook …` or `[--flags] [--config <file>] hook <Event>` (the event matches `/^[A-Z][A-Za-z]+$/`), so `ccinfobar --config X hook Stop` and a bare `ccinfobar hook` match but `ccinfobar config set hook 1` is a normal command. Before the first import it calls `silence()` (`cli/silence.ts`, no imports, inlined into the entry chunk): stdout and stderr become no-op sinks through `Object.defineProperty`, so the real streams are never created; it drops the warning listeners, exits 0 on any uncaught error and starts a 2 s self-exit timer, then imports `cli/hook.js`. `main.ts` also has a `hook` case for `main()` callers; it does not silence.
- **Closure.** `cli/hook.ts` may only reach `cli/args.ts`, `data/hook-line.ts` (the event list, line format and paths: the writer half of `data/hooks.ts`, which re-exports it), `data/progress.ts` (for `--progress hook`, see [Terminal progress](#terminal-progress)), `data/store.ts`, `core/builtins.ts`, `core/paths.ts` and `core/sanitize.ts`; `test/foundations/import-graph.test.ts` fails on anything else, and checks that bin.ts imports `./cli/hook.js` before `./cli.js`. It also fails on a static `node:fs` or `node:crypto` import or `process.stdin` in that closure and, after a build, in the hook chunk and the chunks it imports: a static ESM `node:fs` import costs about 8 ms at startup, so `core/builtins.ts` loads it through `process.getBuiltinModule` (`createRequire` on older Node 20), and `store.ts` loads `node:crypto` only when it names a temp file. The update check is a dynamic `import('../data/update-state.js')`, loaded only on `SessionStart` with source `startup`, which also prunes `<sid>.jsonl` and `<sid>.fold.json` files older than 7 days (at most 200 deletions and 15 ms per run, so stale files behind many fresh ones are still reached).
- **Input.** stdin is read with `fs.read` on fd 0 instead of the `process.stdin` stream (about 9 ms), except on Windows, where `cli/hook-stream.ts` keeps the stream because the pipe may be overlapped. It is capped at 1 MB with a 1 s deadline, and reading stops as soon as the bytes so far parse as a JSON object. Node joins its thread pool on exit, so an `fs.read` still waiting holds the process: a partial payload whose writer never closes keeps it alive until the writer closes or Claude Code's 5 s hook timeout ends it. On overflow the fields come from a regex scan of the first 64 KB and then the last 64 KB (so a `prompt_id` after a huge prompt is still found); the head wins, and nested keys can match but escaped keys inside strings cannot. The stdin `hook_event_name` wins over argv. The event must be on the allowlist and `session_id` must match `/^[A-Za-z0-9_-]{1,128}$/`, else nothing is written. `CCINFOBAR_DEBUG` writes fixed reason codes (never payload content) to `hooks/debug.log`, up to 256 KB.
- **Line format.** One `appendLine` per event to `<cacheDir>/hooks/<session_id>.jsonl` (mode 0600; missing dirs are created 0700), with only allowlisted fields, each sanitized and capped at 256 chars (1024 for the transcript path):

  ```json
  {"v":1,"t":1760400000000,"e":"Stop","p":"<prompt id>","sa":false}
  ```

  `s` (SessionStart source), `p` (prompt id), `sa` (`stop_hook_active`), `a`/`at`/`tp` (agent id, type, transcript path), `n` (notification type), `tn` (PermissionRequest and PermissionDenied tool name). Prompt text, `last_assistant_message` and tool input are never stored.
- **Fold.** `foldHookLog(lines)` is pure. It skips lines that are not objects, have `v !== 1`, an unknown event, a non-finite `t` or a wrong-typed field. A line whose `e|p|a|tn|n` key was seen within 2 s (`DUP_WINDOW_MS`) is a duplicate and ignored; the window map is pruned as it goes, capped at 512 and saved with the fold, so a duplicate split across two reads is still caught. Turns pair by `prompt_id` (earliest UserPromptSubmit, latest Stop), because async hooks can write Stop first; a Stop without `p` pairs with the latest unkeyed prompt. Agents are keyed by `agent_id`. `pendingPermission` means a prompt was shown at `since`, not that it is still open (Claude Code hides the status line while the dialog is up, and approving fires no registered event). It is set by `Notification(permission_prompt)` or `PermissionRequest`. Any later activity (Stop, UserPromptSubmit, SessionStart, SubagentStart, SubagentStop, `PermissionDenied` for auto mode denials, or a Notification other than `idle_prompt`, which is ignored) closes it into `lastPermission` (`since`, `end`, tool), which `permission-wait` shows. Fold cache version 4. It keeps the newest 50 keyed and 50 unkeyed turns and 100 agents.
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

### Terminal progress

OSC 9;4 printed to the status line's stdout is stripped by Claude Code, and `/dev/tty` fails with ENXIO in the status line child, so there are two channels: a synchronous hook `terminalSequence` (async hooks and `SessionStart` never emit one) and, on POSIX, the parent's terminal device by path.

- **Render side.** After stdout, `cli/render.ts` calls `syncProgress(ctx, env)` (`cli/progress.ts`) in its own `try`. It returns before any I/O when `config.progress` is absent. Otherwise it computes the state and percent with `progressTarget` (through `metricGetter`: `context.pct`, `context.usable` for `scaleTo: autocompact`, or `usage.5h`; state 1, 4 from `warnAt`, 2 from `errorAt`) and writes `<cacheDir>/hooks/<session id>.progress.json` (`{ v, state, pct, channel, always }`, 0600) only when it changed. Turning `enabled` off writes state 0 once.
- **tty channel.** When the value changed and the channel is `tty` (never on win32), `writeTty` in `cli/progress-tty.ts` finds the Claude Code parent's terminal: on Linux `/proc/<ppid>/fd/0`, walking up at most 3 ancestors, on macOS one `ps -o tty= -p <ppid>` (fixed argv, 500 ms timeout), whose result is kept in `<session id>.progress-tty.json` as `{ ppid, dev }` and reused while the parent pid is the same. The path must match `TTY_RE` (`/dev/pts/N` or `/dev/ttyXXX`, never `/dev/tty`) and be a character device; it opens with `O_WRONLY | O_NOCTTY | O_NONBLOCK` (no `O_CREAT`), writes once and closes, DCS-wrapped under tmux only with `tmuxPassthrough`, and only for allowlisted terminals unless `terminals: "always"`. Every failure is silent.
- **Hook side.** `<command> --progress hook UserPromptSubmit|Stop|StopFailure` takes the silent hook path (`bin.ts`), and `runProgress` in `cli/hook.ts` reads the want file through `src/data/progress.ts`, which, like the rest of the hook closure, imports no config, widgets, renderer or crypto. On the hook channel, in an allowlisted terminal (`terminalAllowed`: `WT_SESSION`, ConEmu, WezTerm, Ghostty 1.2+, iTerm2 3.6.6+), when the value differs from `<session id>.progress-sent.json`, it prints exactly one `{"terminalSequence":"\u001b]9;4;S;P\u0007"}` line with `fs.writeSync(1, …)` and records it. It never appends to the hook log and always exits 0. `progressSeq` builds the body from integers only, and a test checks it against Claude Code's validator `^4;[0-4](;(100|\d{1,2})?)?$`. Claude Code wraps it for tmux itself; inside tmux `terminalAllowed` reads `GHOSTTY_RESOURCES_DIR`, `WEZTERM_EXECUTABLE`/`WEZTERM_PANE`, `LC_TERMINAL_VERSION` and `KITTY_WINDOW_ID` instead of `TERM_PROGRAM`. The regular `SessionStart` hook deletes the sent file, so a resumed session in a new tab gets the bar again. Session cleanup prunes the want, sent and tty files with the hook logs.
- **Install.** `planHooks({ progress: true })` adds three synchronous groups (`timeout: 5`, no `async`) with the floor `HOOK_FLOOR.terminalSequence` (2.1.141), recorded in the manifest with `role: 'progress'` under `event: 'progress:<Event>'` and `hookEvent: '<Event>'`, so a reader that only knows Phase 4 hooks never takes them for its own; `findHookEntries` maps them back and still reads the older `event: '<Event>'` shape, which the next install or uninstall rewrites or drops. Ownership and removal key on file, event and role, so the Phase 4 async hooks and the progress handlers never touch each other. `uninstall --progress` removes only that role (once it is held while a bar is showing, see `requestClear` in `data/progress-clear.ts`), the full uninstall both. On the tty channel no progress handlers are planned. The editor's `POST /api/progress` uses the same planner and writes `progress.enabled` (and `channel`) to the config file in the same request. Nothing writes `terminalProgressBarEnabled`; `progressWarnings` in `hooks-doctor.ts` reports it, missing or stray handlers, the terminal, the Claude Code version and tmux, and `explain` shows the value from `progressTarget` without calling `syncProgress`.

### Live session data

Phase 5 added three optional `DataSources` members, `hooks`, `repos` and `environment`. They are lazy and never spawn in the render path. Each has a sample injector in `core/sample.ts` and one in every scenario (`waiting-permission` and `workspace-folder` exercise them), and `ctxWith()` defaults to the samples.

- **Transcript fields.** `TranscriptInfo` gained `runningTools` (id, name, a 32-char arg, start; at most 8), `turnToolCounts`, `sessionToolCounts`, `lastToolResultAt`, `toolResultTimes` (the last 64 main-chain tool result times, ascending), `promptId`, `promptStart` and `turnEnd`. The cache `VERSION` is 9; bump it once if a field changes shape. Sidechain lines are skipped, a tool result removes its running tool, and an interrupt clears them.
- **Trusted turn.** `trustedTurn(hooks, transcript, promptId, now)` in `src/data/live.ts` uses the hook turn when it has a start, its prompt id matches, the transcript shows no prompt more than 5 s after it (missed UserPromptSubmit), and it is not still open while the transcript turn ended more than 60 s ago (missed Stop). Otherwise it uses the transcript's `promptStart`/`turnEnd`. `turn-timer`, `tool-activity` and the agent scoping all go through it. `activeTools` drops a tool once the turn ended at or after its start, or after 10 minutes.
- **Hook fold.** `PermissionDenied` is on the allowlist and in the default install set (floor 2.1.89). Closing a wait writes `lastPermission { since, end, tool }`. `lastWait` ends every wait, open or closed, at the first transcript tool result after `since` when that comes before the recorded end, and skips a wait whose first result has left the 64-entry ring. Waits longer than `maxAgeMin` or older than the turn are ignored, and an open wait is never shown. `FOLD_VERSION` is 4. SubagentStart/Stop give `agents` and `agent-count` exact start, stop and type; a transcript tool result that finished the agent's call still marks it done when SubagentStop was lost, and a hook agent with no subagent file yet shows only in the turn it started.
- **Environment.** `readEnvironment(projectDir, cwd, env, opts)` in `src/data/environment.ts` only stats memory and rules files and reads settings, `.claude.json`, `.mcp.json` and `managed-mcp.json` through a nonblocking, fstat-checked reader with size caps. The cache `env-<key>.json` (VERSION 3) also stores the last result with its probes: the signature of every settings file that exists, the mtime of every folder something was looked up in and which of those names existed, and the rule dirs. A render first runs only those stats (about 15 to 20 for a deep cwd); a folder whose mtime moved re-checks just its probed names, and the result is reused for up to 60 s, or until a busy `.claude.json` has settled. `readEnvironment` is kept small so a hit never compiles the full read. Otherwise the full read uses per-file `[path, mtimeMs, size, facts]` signatures, where facts are counts, flags and sanitized server names, never configs; a file is reparsed only when its mtime or size changes (`.claude.json`, capped at 8 MB, keeps its last facts while it is larger or changed less than 30 s ago), and rules are rescanned when a scanned dir changes or after 60 s. The `.claude.json` project entry is looked up by the git root, then by the main checkout of a linked worktree (`.git` file → `commondir`), exactly first and case-insensitively on win32 and darwin. Tests inject `managedDir` and `stopAt` so `/etc/claude-code` and the filesystem root are never read.
- **Repos.** `readRepos` in `src/data/repos.ts` returns null inside a repo (an lstat walk for `.git`, no git), else scans child folders' `.git/HEAD` into `repos-<key>.json` (10 s TTL plus the folder mtime). The dirty marker comes from the `jobs/repos-dirty-<key>.json` envelope, with the Phase 5 `repos-dirty-<key>.json` as a read-only fallback.
- **Dirty job.** `reposJob` in `src/data/jobs/repos.ts` (key `repos-dirty-<key>`, param the absolute cwd, network none, 60 s TTL, 2 min lock) runs on the shared worker, so `scheduleJobs` stays the only spawn on the render side. Its `keys()` reuses render's lazy repos scan. `run()` loads `src/data/repos-dirty.ts` lazily and runs a hardened `git status` in at most 50 repos (the ones each `workspace-repos` item shows first, by `pickRepos`), 2 s each and 15 s in total, yielding between repos. `repos --background <root>` (not in help) is a hidden alias that runs the same job through `executeJob`.
- **Workspace mode.** Before rendering, `workspaceMode(ctx)` in `core/renderer.ts` renders each `workspace-repos` item once; when one shows repos, the other git widgets hide instead of showing `—` (`hideGitPlaceholders: false` opts out). `workspace-repos` itself sets `WidgetDef.hideWhenEmpty`, so `renderPart` and `inspect` hide it when empty (status `hidden`, reason `inside-repo` or `no-child-repos`) unless the item sets `hideEmpty: false`.
- **Time-based widgets.** `WidgetDef.timeBased` marks widgets that need a refresh interval; `needsRefresh` in `core/edit.ts` (pure) drives the `install`, `doctor` and editor hints.

`test/widgets/performance.test.ts` renders all five live widgets through the real readers on temp fixtures with `child_process` spies and asserts no call; `test/core/scenarios.test.ts` renders them under every scenario and checks that no default layout uses them and that only the `agents` and `workspace` presets do.

### Background jobs

Everything slow or networked runs in one detached worker, never in the render. `src/data/jobs/`:

- `runner.ts`: the `Job` interface, envelopes, backoff, locks, `spawnSelf`, `scheduleRequests` and `executeJob`. It imports only `core/paths.ts`, `core/sanitize.ts` and `data/store.ts` (plus types), so the hook's update check can reach it.
- `index.ts`: the `JOBS` registry, `jobFor(key)` and `scheduleJobs`. Only `cli/main.ts` and `cli/render.ts` import it, so the registry and every job module land in the cli chunk; `main.ts` passes `JOBS` to `worker`, `usage --background` and `repos --background`, and doctor gets a key's network class from `keyNetwork`. It takes `updateJob` through `data/update-state.ts`, so the two share a chunk.
- One module per job: `usage.ts`, `update.ts`, `status.ts`, `http.ts`, `gh.ts`, `repos.ts`. `keys.ts` (`httpKey`, `ghKey`, `httpGroups`, `ghParam`, `keyNetwork`) is shared with the widgets and doctor.
- Worker-only code: `fetch.ts` (`fetchJson`, `retryAfterMs`) and `gh-exec.ts` (the `execFile` wrapper) import no other module, and `http.ts`, `status.ts` and `gh.ts` load them, and `core/jsonpath.js`, with `import()` inside `run()`. `update.ts` and `repos.ts` load `data/self-update.ts` and `data/repos-dirty.ts` the same way; nothing under `src/data` imports `src/commands`, not even with `import()`. The worker and `update --background` call `takeOverAfterUpdate` after the update job ran.

Each ESM chunk costs about 0.3 ms at startup, more than its bytes, and esbuild makes a new chunk for every module that a different set of entry points reaches. So a worker-only module that imports a render module splits that module into a chunk of its own. The render loads 15 chunks, the same as before the job runner. `test/foundations/import-graph.test.ts` fails when the render closure reaches `fetch.ts`, `gh-exec.ts`, `core/jsonpath.ts`, `core/http-report.ts` or `commands/`, when another module imports `index.ts`, or when `fetch.ts` or `gh-exec.ts` imports a module.

| Job | Key | Network | Lock | Refresh |
| --- | --- | --- | --- | --- |
| usage | `usage-<accountKey>` | auto | 30 s | 180 s; 429 honours Retry-After or 300 s; no login 10 min |
| update | `update` | auto | 10 min | daily, or a new session with a 60 s gap |
| status | `status` | auto | 60 s | the smallest `interval`, 120..600 s |
| http | `http-<hash16(url + \0 + headers)>` | explicit | 60 s | the smallest `interval`, at least 30 s |
| gh | `gh-<hash16(host/owner/name#n)>` | explicit | 60 s | 60 s while checks run, else 5 min; gh missing blocks 1 h, not logged in 30 min, rate limit 15 min |
| repos | `repos-dirty-<cacheKey(cwd)>` | none | 2 min | 60 s |

**Envelope.** One file per key, `<cacheDir>/jobs/<key>.json` (0600, dir 0700, `writeAtomic`): `{ v: 1, key, fetchedAt, ok, value, error?, blockedUntil?, attempts?, lastGood?, lastGoodAt?, param? }`. Success sets `value` and `lastGood`, `lastGoodAt = fetchedAt` and `attempts: 0`. A failure stores `value: null`, a fixed error code (never a response body or `err.message`), `attempts + 1` and `blockedUntil`, and keeps `lastGood`. Every read goes through `readEnvelope`, which checks the shape and runs `deepSanitize`. Widgets call `jobValue(e)`, which gives `{ value: value ?? lastGood, at, stale, error }`, and they judge the age themselves.

**Backoff.** `failEnvelope` blocks for `retryMs × 2^(attempts − 1)`, capped at 30 min; `retryAfterMs` reads `Retry-After` as seconds or an HTTP date (0 or garbage falls back to the computed backoff); it is a floor, so a `Retry-After` shorter than the backoff never makes a failing job run on every refresh. `defaultDue(e, now, ttlMs)` is false while `blockedUntil` lies ahead; otherwise it is true when there is no envelope, a failed run's block has passed, or the data is older than the TTL. `due()` also gets the request, so update's session rule and the per-item intervals fit; http requests also carry their JSON `paths` (render side only, never in argv), so a path missing from the envelope makes the key due at once.

**Scheduling.** `renderOnce` calls `scheduleJobs(config, payload, env, cwd, cfgFile, { repos })` after the stdout write. It returns at once under `CCINFOBAR_NO_JOBS`, skips `auto` jobs before their `keys()` run when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set (`blockedByTraffic`), asks each remaining job for its requests and due state (each in its own `try`), takes `jobs/<key>.lock` with `acquireLock(file, job.lockMs)` and spawns one `ccinfobar worker <key[=param]>... [--config=<file>] [--cwd=<dir>]` through `spawnSelf`. `--config` is only passed for a non-default config file, always as an absolute path. The worker starts in `safeCwd()` (home, else the temp dir), never the project dir, because Windows looks for `gh` and `npm` in the cwd before `PATH`; relative `CCINFOBAR_*`, `CLAUDE_CONFIG_DIR`, `XDG_*`, `APPDATA` and `LOCALAPPDATA` values are made absolute for it, and gh also runs in `safeCwd()`. If the spawn throws, emits `'error'` or starts nothing (`spawnSelf` only runs an entry named `ccinfobar` or `ccinfobar.js`), the locks it took are released and no key counts as scheduled. Tests that need a real spawn call `useIdleEntry()` from `test/helpers.ts`, which points `argv[1]` at an empty `ccinfobar.js`. Preview, explain, doctor, the editors, the TUI and bench never schedule.

**Worker.** `commands/worker.ts` (lazily imported, in the import-graph test's `EXCLUDED_FILES`) silences stdout and stderr, loads the config the way render does and parses at most 32 `key[=param]` arguments. Every request is checked again: the key must pass `SAFE_KEY` and the job's `keyRe`, `param` its `paramRe` (a job with `paramOptional`, such as update without a session id, may also come without one), and `accepts()` re-derives the key from the config (and for repos, the directory). A job that `CCINFOBAR_NO_JOBS` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off (`jobOff`) is skipped and its lock removed, here and in the `--background` aliases, so a hand-run worker or one started by an older binary obeys them too. A broken config runs only the update job. The accepted jobs run concurrently (`Promise.allSettled`), each under its own `timeoutMs` in `executeJob`; their slow calls are async (the dirty check's `git status`, the macOS keychain read), so one job never stalls the timers of another. On a timeout `executeJob` aborts `ctx.signal`, which `fetchJson`, gh and the update job's npm install honour, so a run never outlives its `timeout` envelope; envelopes built with the start time are stamped with the time the run ended (`ctx.clock`). `executeJob` writes the envelope and removes the lock. The worker never prints and always exits 0; a 330 s deadline ends it. Afterwards it removes `jobs/http-*` and `jobs/gh-*` files that no config item and no key it just ran uses and that are older than 7 days, and stale `*.tmp` files.

**Legacy files.** The usage reader falls back to `usage-<accountKey>.json`, then `usage.json` (only without `CLAUDE_CONFIG_DIR`); update to `update.json`; repos to `repos-dirty-<key>.json`. They are read, never written again. `usage --background`, `update --background` and `repos --background` are hidden aliases that run one job through `executeJob`.

**Hook closure.** `scheduleCheck(config, session, env)` in `data/update-state.ts` schedules only the update job, so `cli/hook.ts` reaches `runner.ts` and `jobs/update.ts` but never the registry, config loading or widgets; `jobs/update.ts` loads `data/self-update.ts` with `import()` inside `run()`. `test/foundations/import-graph.test.ts` checks this.

**Reading.** `DataSources.jobs()` gives a `JobReader` (`createJobReader(env)`), filled lazily, so a layout without job-backed widgets reads no job file. `core/sample.ts` `sampleJobs(now)` and every scenario supply one. `core/trace.ts` records `job` reads, so `explain` shows `job status, 30s old, ok`; `jobReason` and `jobEmpty` in `core/inspect.ts` turn an envelope into `job-pending`, `job-error`, `stale` or `nonessential-traffic-off`. `doctor` lists every envelope in a Background jobs block.

**Tests.** `test/setup.ts` sets `CCINFOBAR_NO_UPDATE` and `CCINFOBAR_NO_USAGE_API`; built-CLI tests that do not test jobs set `CCINFOBAR_NO_JOBS=1`. Jobs get an injected `fetch` (`test/fake-fetch.ts`) and `execFile`, so no test touches the network or the real `gh`. `test/integration/jobs-cli.test.ts` proves that one render spawns one worker that writes `jobs/update.json` and `jobs/usage-<16 hex>.json`, and `scripts/clean-install.mjs` checks the same paths.

Adding a job:

1. Add the id to `JobId` and a module in `src/data/jobs/` with `network`, `lockMs`, `timeoutMs`, `retryMs`, `keyRe` (and `paramRe` when it needs payload input), `keys`, `accepts`, `due` and `run`. Load network, exec and other worker-only code with `import()` inside `run()`, from a module that imports no render module. Pass `ctx.signal` to anything that can run long. Pass only short, non-secret params in argv; anything from the config is re-read by the worker.
2. Return `okEnvelope` or `failEnvelope` with a fixed error code; sanitize strings and keep only what the widget needs.
3. Register it in `JOBS` and add its key pattern to `keyNetwork`, and let the widget read it with `ctx.data.jobs?.()?.job(key)` and `jobValue`. Add the key to `sampleJobs` and to a scenario.
4. Choose the network class: `auto` for anything the user did not ask for by URL or option.
5. Test `keys`, `due`, `run` with injected `fetch` or `execFile`, the worker round trip and the explain reason.

### Plugin

`.claude-plugin/marketplace.json` lists one plugin with `source: "./plugin"`. `plugin/` holds only `.claude-plugin/plugin.json` and five `skills/<name>/SKILL.md`. Every skill has `disable-model-invocation: true`, an `allowed-tools` list that pre-approves only read-only commands (`ccinfobar --version`, the dry runs, `doctor`, `edit --detach`, `themes --list`, `theme <id>`; never `--yes` or `uninstall`, so those always ask) and a ``!`ccinfobar --version || echo ccinfobar-missing` `` preflight, stops when that (or the `npx ccinfobar@latest --version` it runs before installing) prints 0.6.2 or lower, and only runs `ccinfobar` commands. There are no commands, hooks, agents, bin, MCP or settings in the plugin.

`claude plugin validate --strict` checks the schema but not these rules, so `test/plugin/structure.test.ts` pins them: the manifest shape, the five skill dirs, no forbidden paths, no `"statusLine"` key or `CLAUDE_PLUGIN_ROOT`, the exact frontmatter, the preflight, the version gate and each skill's commands in order.

`plugin.json`'s `version`, the pins in `INSTALL.md` (`ccinfobar@<v>`, `/blob/v<v>/`) and the README's `alpadalar/ccinfobar#v<v>` follow `package.json`. The npm `version` lifecycle script runs `scripts/sync-plugin-version.mjs` and stages the three files, so `npm version` keeps them in step; `test/plugin/version-sync.test.ts` fails on drift. When HEAD is exactly at `v<version>` (the release workflow's `npm run check`), `--check` also fails if that tag lacks `INSTALL.md` or `.claude-plugin/marketplace.json`. INSTALL.md first runs `npx ccinfobar@<v> --version` and stops at 0.6.2 or lower (no dry run, no ask-before-replace); that floor is fixed text the script never rewrites. CI's `plugin` job installs a pinned `@anthropic-ai/claude-code` into a temp prefix, with HOME and `CLAUDE_CONFIG_DIR` in `$RUNNER_TEMP`, runs `plugin validate --strict` on `.` and `./plugin`, and checks that `plugin details` shows `Skills (5)` and `Hooks (0)`. Never run `claude plugin install` against your own config to test; use `--plugin-dir ./plugin`.

`edit --detach` (`editor/detach.ts`) pings the editor recorded in `<cacheDir>/editor.json` (`{ url, pid, startedAt, config }`, 0600) with its token and reuses it when `config` is the same resolved config path and, with `--port`, the port matches. Otherwise it takes `editor.json.lock` (a second `--detach` waits for the first and reuses its editor), checks again, spawns `edit --serve-detached` as a detached session leader and waits up to 5 s for that file. The detached server stops after 30 minutes without requests, on `POST /api/shutdown` or on SIGTERM, and removes `editor.json` only if it still holds its own pid.

### Messages and providers

User-facing messages go through `t(id, params)` from `core/i18n/`. Each area has its own table in `src/core/i18n/en/` (`install.ts`, `config.ts`, `doctor.ts`, `widgets.ts`, `explain.ts`, `cli.ts`, `editor.ts`, `tui.ts` and so on; `display.ts` covers rules, overflow, glyph modes and progress, `fun.ts` the quips). The English message is the id's meaning; `tr/` has one file per area with the same ids. `data/provider.ts` detects API-key, Bedrock, Vertex, Foundry, Mantle, Anthropic AWS and gateway sessions from the environment (presence only), so plan-limit widgets and the OAuth usage fetch only run for Claude subscriptions.

### Languages

- **Registry.** `core/i18n/languages.ts` lists each language once: id, native name, aliases, locale, and a loader. `LANGUAGE_SETTINGS` (`auto` plus the ids) feeds config validation, `config set`, the schema and both editors' selectors, so they pick up a new entry by themselves.
- **Lookup.** `t()` looks in the active language's table, then in English, then returns the id. A message can be a `{ one, other }` plural, picked with a cached `Intl.PluralRules` for the language's locale from `params.count`. `{name}` params are filled the same way in every language.
- **Resolver.** `core/i18n/resolve.ts` is pure and never reads `process`: `resolveLanguage(setting, hints)` takes the config value and the hints in order. A config id wins; otherwise the first non-empty hint decides (an unsupported tag, `C` or `POSIX` gives English from that source), else the default. `pickUiLanguage` does the same for the browser.
- **Active language.** One module-level language, switched with set-and-restore: `render()` switches to the config's `language` and restores the previous one in `finally`, and so does `inMode` in `core/inspect.ts`. Render is synchronous, so editor previews with different configs cannot interleave.
- **Edges.** Only the edges read the environment. `cli/lang.ts` builds the hints from `CCINFOBAR_LANG`, `LC_ALL`, `LC_MESSAGES` and `LANG`, and only when all are empty asks `new Intl.PluralRules().resolvedOptions().locale` (about 0.2 ms, against about 12 ms for `Intl.DateTimeFormat()`), memoized per process. `cli/main.ts` applies the config's `language` once for every command except `help`, `hook` and `worker` (help follows the environment); a missing or broken config keeps the environment's answer. The editor server sends its environment answer as `language` in `/api/state` and renders previews in it. The TUI applies the config language at boot and again after each change. The browser app picks the UI language from the config, the server's answer and `navigator.languages`, and fills `data-i18n` keys in `index.html` with `applyStatic`.
- **Loading.** English is always loaded. Other tables load with `import()` (`loadLanguage`), so an English status line never parses them: `cli/render.ts` awaits `prepareLanguage(config)` before the first `t()`, and `main.ts` loads every language for the other commands (not for `hook` and `worker`). The browser bundle and `test/setup.ts` call `installBundled()` from `core/i18n/bundled.ts`, which installs every table up front. The `report`, `import`, `toml` and `catalog` areas are not in the main tables: `en/lazy.ts` and `tr/lazy.ts` hold them, and `core/i18n/lazy.ts` installs both as each language's `lazy` table when it is imported. Every module that prints one of their ids imports it for its effect (`import '../core/i18n/lazy.js'`), so the commands that need them have them and the status line never parses them; `t()` looks in `messages`, then `lazy`. `test/foundations/import-graph.test.ts` checks both the import in every such module and that the built render and hook chunks carry none of that text.
- **Metadata.** Widget names, descriptions, labels, hints, samples and option texts stay English in the `WidgetDef`s; translations live in `tr/meta/`, one `MetaFile` per widget category keyed by widget type and option key, plus `catalog.ts` for themes, styles, presets, scenarios and style groups keyed by id. `widgetText`, `optionLabel`, `choiceLabel` (`core/i18n/widget-text.ts`) and `themeDescription`, `styleText`, `presetText`, `scenarioText` (`core/i18n/catalog-text.ts`) fall back to the English text.
- **Formats.** `core/i18n/format.ts` formats dates with an explicit locale and 24-hour times, and `foldSearch` folds search text with the language's casing rules. Numbers, units and compact durations are not localized. Ids, config keys and JSON output stay English; JSON paths run under `withLanguage('en', …)`.
- **Tests.** `test/setup.ts` pins `LANG=C` and `LC_ALL=C`, removes `LC_MESSAGES` and `CCINFOBAR_LANG`, and sets English before each test; `withLang` and `withTz` in `test/helpers.ts` switch for one test. `test/core/i18n.test.ts` checks that every language has exactly the English ids, the same params and plural shapes, and clean text; `test/i18n/widget-meta.test.ts` checks that every widget and category has metadata in every language that ships it. `test/i18n/snapshots.test.ts` keeps one plain-text file per scenario under `test/i18n/__snapshots__/tr/` (update with `-u`). `test/i18n/literal-scan.test.ts` lists every `src/` file outside `core/i18n/` as swept or not swept with a reason, `test/foundations/locale-scan.test.ts` rejects implicit-locale casing, date strings and sorting, and `test/i18n/pseudo.test.ts` renders a wide pseudo-locale (`zz`, test-only) to prove widths. The `test-tr-locale` CI job runs `npm run check` with the process started under `tr_TR.UTF-8`.

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

## Adding a language

1. Copy `src/core/i18n/tr/` to `src/core/i18n/<id>/`: one file per area with the same ids as `en/`, an `index.ts` that merges them, `lazy.ts` (the report, import and TOML areas) and `tables.ts`; add an `installLazy('<id>', …)` line to `src/core/i18n/lazy.ts`.
2. Add `<id>/meta/`: one `MetaFile` per widget category, `catalog.ts` and an `index.ts` that merges them, as in `tr/meta/`.
3. Add one entry to `LANGUAGES` in `src/core/i18n/languages.ts` (id, native name, aliases, locale, empty `messages`), its loader in `LOADERS` and one `installTables` line in `src/core/i18n/bundled.ts`.
4. Run `npx vitest run test/core/i18n.test.ts test/i18n test/core/i18n-lazy.test.ts`; the completeness tests fail until every id, widget and category is there.
5. Run `npm run docs` (the schema lists the new value). If the language gets its own snapshot suite, add it to `test/i18n/snapshots.test.ts` and write the files with `-u`.

The resolver, the editors' selectors, `config set language` and `doctor` need no change.

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
- `test/scripts`: the Homebrew formula script, offline (fixture tarballs and a stubbed `fetch`)
- `test/integration`: the built CLI end to end (safe mode, install prompts, shared limits, the cost ledger, hooks)
- `test/catalog`, `test/market`: the catalog store, publish, install and cache; the marketplace protocol, client, device flow, reference server and Worker (see [Catalog and marketplace](#catalog-and-marketplace))

`test/setup.ts` runs before every test file. It points HOME, the config, cache and Claude dirs at a per-run temp folder and throws on any write outside temp dirs, so a test can never touch your real `~/.claude/settings.json`. Wrap code in `withoutSideEffects()` from `test/helpers.ts` to also fail on config saves, spawns or `fetch` (used for the render path).

It also guards the network: `fetch`, `http.request` and `https.request` to any host other than a loopback address fail the test, so marketplace, GitHub and update code must get an injected `fetch` or talk to an in-process server on `127.0.0.1`.

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
- The child env gets temp `CCINFOBAR_CACHE_DIR`, `CCINFOBAR_CONFIG_DIR`, `CLAUDE_CONFIG_DIR` and `NODE_COMPILE_CACHE`, plus `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `CCINFOBAR_NO_JOBS=1` (no background worker, even for `http` or `pr` CI items in a copied config) and `COLUMNS=140` (like Claude Code, so no width probe). Your config and user themes are copied in read-only; the real caches and `~/.claude` are never touched, and the temp dirs are removed afterwards.
- Stats: median (mean of the two middle values when N is even), nearest-rank p95, min and max.

Measure at nice 0, for example after `renice -n 0 -p $$` in your shell (lowering the nice value may need privileges). On a machine that starts tools at nice 10, `nice -n -10 ccinfobar bench` also reaches 0; the header shows the priority and warns when it is above 0. Measure when the machine is idle and note the load average, because the numbers move with machine state.

`ccinfobar overhead = warm median − control median` is the cost ccinfobar adds on top of Node boot. Phase 10 compared this number, taken the same way, on Fedora's and the official Node builds to see whether a compiled binary or snapshot is worth it; the result is in [DISTRIBUTION.md](DISTRIBUTION.md#startup-decision-f2). `hook overhead = hook median − control median` is the same figure for one hook event. The clean-install CI job also prints `bench --runs 10 --json` for each OS; that step never fails the job.

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

After the Phase 5 review fixes, 2026-10-15, same machine and method, `nice -n -10` (priority 0), load average about 1.2 to 2.0, N = 20, with the build before the fixes and the build after them interleaved (3 rounds each; warm medians in ms):

| cwd | before: default | before: live | before: live − default | after: default | after: live | after: live − default |
|-----|----------------:|-------------:|-----------------------:|---------------:|------------:|----------------------:|
| this git repo | 125.9 | 129.7 | +3.8 | 126.8 | 129.3 | +2.5 |
| workspace folder | 118.2 | 122.5 | +4.3 | 119.6 | 122.2 | +2.6 |

80 alternating single renders per layout gave the same picture: live − default went from +3.0 to +2.4 ms in this repo and from +3.8 to +2.3 ms in the workspace folder, and `env-counts` alone from about +1.9 to +0.3 ms. The default layout did not change (120 alternating runs per build, within 0.7 ms). The saving is `env-counts`' result cache (about 64 stats down to 18 for a 14-level cwd; first call in a fresh process 3.4 → 1.7 ms in-process). `workspace-repos` now also hides itself inside a repo, so the repo row renders one widget less.

Phase 6 (background jobs and external sources), 2026-10-15, same machine and method, `nice -n -10` (priority 0), load average about 0.5 to 1.3, cwd this git repo, N = 20, warm medians in ms (mean of interleaved rounds). `before` is the build just before Phase 6 (5b208f3). `ext` is the default plus `service-status`, `http` (a loopback URL), `pr` with `ci`, `provider` and `session-cost` with `basis: "auto"` on line 1; `placebo` is the default plus five `text` widgets:

| Layout | before | after | after p95 |
|--------|-------:|------:|----------:|
| default (6 rounds) | 123.3 | 125.1 | 131.9 |
| placebo (3 rounds) | | 127.5 | 134.4 |
| ext (6 rounds) | | 128.9 | 138.2 |

Cold medians: 135.7 before, 140.9 after. The default layout is about 2 ms slower warm and 5 ms slower cold, though still at or below the Phase 5 numbers above. The render reads no more files (bench sets `CCINFOBAR_NO_JOBS`), so the cost is code: the render path now loads about 447 KB of chunks instead of 370 KB. A build without the `scheduleJobs` import ran at 123.9 against 124.8 for this build and 123.4 for the one before, so about 1 ms comes from loading the job modules and the rest from the larger widget and config chunks. The new widgets cost about 1 ms over the placebo, and with no cached data yet `http` and `provider` show nothing. Moving each job's `run()` behind an `import()` (as `jobs/update.ts` does already) would take most of the job modules out of the render.

After the Phase 6 review fixes, 2026-10-15, same machine and method, `nice -n -10` (priority 0), Node v22.23.1, load average about 0.7 to 2.0, cwd this git repo, default layout, N = 20, 10 interleaved rounds per build (means of the round medians, in ms). `before` is the build just before Phase 6 (5b208f3), `Phase 6` the build before the fixes (fe35f8a):

| Row | before | Phase 6 | after fixes |
|-----|-------:|--------:|------------:|
| `node -e 0` | 67.0 | 67.2 | 67.5 |
| cold | 137.9 | 143.5 | 141.0 |
| warm | 124.7 | 127.4 | 126.1 |
| warm p95 | 132.6 | 135.0 | 133.2 |

100 alternating single warm renders per build (`test/fixtures/payload.json`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `CCINFOBAR_NO_UPDATE` set) gave 124.5 / 126.4 / 125.1 with `CCINFOBAR_NO_JOBS` and 124.2 / 126.3 / 124.9 with jobs on and nothing due, the path a real refresh takes. The fixes took back about half of Phase 6's cost: +1.4 ms warm in `bench` and +0.6 to +0.7 ms in the alternating runs, against +2.7 and +1.9 to +2.1 before. The ~0.5 ms target is met only in the alternating runs. The render loads 15 chunks again (Phase 6: 20, before: 15). An empty-module test on this machine costs about 0.3 ms per extra ESM module, more than the bytes did, so most of the saving is the five chunks. The remaining cost is code, 441 KB against 380 KB: `core/http-spec.ts`, `core/profiles.ts`, the `http` and `service-status` widgets, and the job registry and runner (about 20 KB), which scheduling needs on every refresh. Loading the registry with `import()` only when jobs are on made `bench` faster (it sets `CCINFOBAR_NO_JOBS`) but a real refresh about 1 ms slower, so it is not done.

Phase 7 (display: width engine, rules, priority overflow, glyph modes, bars, activity strip, fun widgets, terminal progress), 2026-10-15, same machine and method, `nice -n -10` (priority 0), Node v22.23.1, load average about 1.0, cwd this git repo, default layout, N = 30, three rounds against the baseline taken before Phase 7 (4f39108):

| Row | before (ms) | after (ms, rounds) | after p95 (ms) |
|-----|------------:|-------------------:|---------------:|
| `node -e 0` | 67.2 | 66.9, 67.0, 68.0 | 71.3 |
| cold | 137.8 | 143.3, 143.9, 143.1 | 152.6 |
| warm | 124.7 | 127.1, 126.6, 126.6 | 133.6 |
| warm, compile cache off | 131.3 | 136.2, 135.8, 136.1 | 142.1 |
| hook UserPromptSubmit | 75.8 | 77.3, 76.6, 76.8 | 82.3 |

The warm median is 1.5 to 1.9% above the baseline, inside the 5% gate; the per-plan runs during the phase stayed between 123.4 and 127.3 ms. A layout without rules does no metric work, overflow other than `priority` takes the old path, and ASCII text takes the width engine's first tier, so the default layout pays only for the larger render code.

The progress hook (`--progress hook UserPromptSubmit`, `WT_SESSION=1`, a want file in a temp cache dir, 20 interleaved runs, two rounds) took 77.9 and 77.1 ms when it printed a sequence and 77.0 and 76.3 ms when the value was unchanged, against 66.7 and 66.9 ms for `node -e 0`: about 10 ms of ccinfobar code over Node's own start. Claude Code waits for the whole process, which is where the 60-110 ms per prompt in [CONFIGURATION.md](CONFIGURATION.md#terminal-progress) comes from.

Phase 8 (languages), 2026-10-15, same machine and method, `nice -n -10` (priority 0), Node v22.23.1, load average about 1.3 to 2.5, cwd this git repo, default layout, N = 30. The machine was busier than in Phase 7, so the builds ran side by side in alternating rounds: `before` is the build before Phase 8 (141a7e6), `static` the phase with every table loaded statically (8d66c49), `lazy` the phase with Turkish loaded on demand. Medians of the rounds' medians in ms (six rounds for `before` and `lazy`, three for `static`):

| Row | before | static | lazy |
|-----|-------:|-------:|-----:|
| `node -e 0` | 74.0 | 73.5 | 73.7 |
| cold | 165.7 | 174.0 | 170.1 |
| warm | 144.7 | 153.6 (+6.1%) | 150.1 (+3.7%) |
| warm, `LANG=en_US.UTF-8` | 145.9 | 157.6 (+8.0%) | 150.3 (+3.0%) |
| warm, compile cache off | 154.4 | 167.5 | 160.6 |
| hook UserPromptSubmit | 83.8 | 86.6 | 86.0 |

With every table loaded statically the warm render was 6 to 8% slower, over the 5% gate, so the Turkish tables (about 160 KB of the bundle) now load with `import()` only when Turkish is shown. What is left is the larger English table, which now also holds the editor and TUI texts (the render loads about 590 KB of chunks against 530 KB before), and two more chunks. A `LANG=tr_TR.UTF-8` warm render took 152.0 to 156.7 ms.

Phase 9 (reports and importers), 2026-10-16, same machine and method, `nice -n -10` (priority 0), Node v22.23.1, load average about 0.9 to 1.0, cwd this git repo, default layout, N = 20, six alternating rounds against the build before Phase 9 (3dc0f41). Medians of the rounds' medians in ms:

| Row | before | after |
|-----|-------:|------:|
| `node -e 0` | 65.0 | 65.1 |
| cold | 144.0 | 145.6 |
| warm | 127.7 | 129.0 (+1.0%) |
| warm p95 | 130.8 | 135.9 |
| warm, compile cache off | 137.6 | 138.0 |
| hook UserPromptSubmit | 74.4 | 74.7 |

The render closure has no new module, but the warm render is about 1.3 ms slower, in five of the six rounds. The English table gained the report, import and TOML messages (the render loads 594 KB of chunks against 579 KB), and `report` imports `config.ts`, `ledger.ts` and `limits.ts` without the rest of their chunks, so esbuild splits two more chunks off the render path (20 against 18). `report` itself, over 200 synthetic transcripts (51 MB, 60 days) with the OS file cache warm: 270 ms with no index, 139 ms with one.

After the Phase 9 review fixes (2026-10-16, same method, load average 1.0 to 2.5, eight alternating rounds against the build before them): handing report code its render-path helpers from `main.ts` takes the render to 19 chunks, and moving the report, import and TOML messages into lazy tables takes the render chunks from 610 KB to 597 KB.

| Row | before | helpers handed in | + lazy tables |
|-----|-------:|------------------:|--------------:|
| `node -e 0` | 65.0 | 65.0 | 65.3 |
| cold | 147.2 | 146.5 | 145.3 (-1.3%) |
| warm | 129.9 | 129.6 | 128.6 (-1.0%) |
| warm p95 | 134.3 | 137.9 | 136.9 |

The final build was faster warm in seven of the eight rounds.

Phase 10 (distribution), 2026-10-16, `nice -n -10` (priority 0), Node v22.23.1 (Fedora's package: no built-in startup snapshot, no code cache), Intel i7-1165G7 (8 threads), Linux 7.2.9 (Fedora 44), load average 1.05 → 1.03, cwd this git repo, default layout, N = 20, two rounds, values rounded half-up to 0.1 ms:

| Row | median (ms, rounds) | p95 (ms) | min (ms) | max (ms) |
|-----|--------------------:|---------:|---------:|---------:|
| `node -e 0` | 65.2, 64.9 | 69.9, 66.4 | 62.7, 63.1 | 71.5, 66.5 |
| cold | 143.2, 143.8 | 150.3, 153.2 | 140.9, 141.6 | 156.5, 158.4 |
| warm | 126.8, 126.1 | 131.6, 128.2 | 124.8, 124.2 | 139.2, 129.0 |
| warm, compile cache off | 136.6, 137.4 | 142.6, 142.0 | 134.5, 134.2 | 146.8, 155.2 |
| hook UserPromptSubmit | 74.8, 73.9 | 79.0, 76.5 | 73.5, 72.3 | 79.1, 76.6 |

ccinfobar overhead 61.6 and 61.3 ms; hook overhead 9.6 and 9.0 ms. The warm median is within 2 ms of Phase 9's 128.6 ms: Phase 10 adds no module to the render path.

The official Node v22.17.1 build (built-in snapshot and code cache), run back to back with the same method, gave warm medians of 59.7 and 58.5 ms and control medians of 15.9 and 15.9 ms.

ccinfobar overhead on official Node: 43.8 and 42.7 ms.

Boot ratio (control / warm): 51.4% on Fedora's Node, 26.8% on official v22.17.1 and 32.8% on official v24.21.0, so most of the gap between the two builds is Node's own boot.

See [docs/DISTRIBUTION.md](DISTRIBUTION.md#startup-decision-f2) for the decision.

## Releasing

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading.
2. `npm version <patch|minor|major>` (its `version` script also updates `plugin/.claude-plugin/plugin.json` and the pins in `INSTALL.md` and the README)
3. `git push --follow-tags`
4. As soon as npm has the new version, in the same sitting, update the Homebrew formula and the tap as described in [docs/DISTRIBUTION.md](DISTRIBUTION.md#publishing-the-formula-owner). Brew users see the update notice from the moment the GitHub release exists, and `brew upgrade ccinfobar` does nothing until the tap has the version.

The `Release` workflow runs the checks, creates a GitHub release from the changelog section with the packed `ccinfobar.tgz` attached (the README install command points at it), and publishes to npm with provenance when an `NPM_TOKEN` repository secret exists.
