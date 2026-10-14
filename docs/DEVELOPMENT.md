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
├── bin.ts               entry point
├── cli.ts               re-exports cli/main.ts
├── cli/                 main.ts (dispatch), args.ts, render.ts (status line), help.ts
├── commands/            install, update, doctor, manage, config-cmd; loaded with import() per command
│   ├── install.ts       planInstall / applyInstall / uninstall
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
│   ├── edit.ts          pure edit operations shared by both editors
│   ├── presets.ts, sample.ts, preview.ts, paths.ts
├── data/                git, transcript, GSD and terminal readers; store.ts, provider.ts
├── widgets/             one file per category, registered in index.ts
├── editor/              web editor: HTTP server + browser app (web/)
└── tui/                 terminal editor: state, view, keys, IO loop
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

### Messages and providers

User-facing messages go through `t(id, params)` from `core/i18n/`. Each area has its own table in `src/core/i18n/en/` (`install.ts`, `config.ts`, `doctor.ts`, `widgets.ts`). `data/provider.ts` detects API-key, Bedrock, Vertex, Foundry, Mantle, Anthropic AWS and gateway sessions from the environment (presence only), so plan-limit widgets and the OAuth usage fetch only run for Claude subscriptions.

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

- `test/core`: renderer, colors, config, edit operations
- `test/themes`: built-in themes, styles, overrides and user themes
- `test/widgets`, `test/data`: widgets and data readers
- `test/gsd`: GSD parser against fixture projects in `test/fixtures/gsd`
- `test/editor`: editor HTTP API and ANSI to HTML conversion
- `test/tui`: TUI reducer, key parsing and view
- `test/commands`: install, settings file, manifest, doctor and `config`
- `test/foundations`: test isolation, atomic writes, import graph and config round trips
- `test/integration`: the built CLI end to end (safe mode, install prompts)

`test/setup.ts` runs before every test file. It points HOME, the config, cache and Claude dirs at a per-run temp folder and throws on any write outside temp dirs, so a test can never touch your real `~/.claude/settings.json`. Wrap code in `withoutSideEffects()` from `test/helpers.ts` to also fail on config saves, spawns or `fetch` (used for the render path).

CI runs the suite on Linux, macOS and Windows with Node 20, 22 and 24.

## Releasing

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading.
2. `npm version <patch|minor|major>`
3. `git push --follow-tags`

The `Release` workflow runs the checks, creates a GitHub release from the changelog section with the packed `ccinfobar.tgz` attached (the README install command points at it), and publishes to npm with provenance when an `NPM_TOKEN` repository secret exists.
