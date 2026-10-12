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
├── cli.ts               argument parsing and commands
├── commands/            install / uninstall
├── core/
│   ├── types.ts         payload, config and widget types
│   ├── config.ts        defaults, validation, load and save
│   ├── renderer.ts      lines → ANSI text (styles, separators, flex, truncation)
│   ├── themes.ts        built-in themes, user theme loading and resolution
│   ├── ansi.ts          colors, width measurement, truncation
│   ├── context.ts       render context with lazy data sources
│   ├── edit.ts          pure edit operations shared by both editors
│   ├── presets.ts, sample.ts, preview.ts, paths.ts
├── data/                git, transcript, GSD and terminal readers
├── widgets/             one file per category, registered in index.ts
├── editor/              web editor: HTTP server + browser app (web/)
└── tui/                 terminal editor: state, view, keys, IO loop
```

Rendering flow:

1. Claude Code pipes a JSON payload to `ccinfobar` on stdin.
2. `cli.ts` loads the config and builds a `RenderContext`. Git, transcript and GSD data are read lazily, only if a widget asks for them.
3. Each widget's `render(ctx, item)` returns a string, `{ text, color }` or `null` to hide itself.
4. `renderer.ts` adds labels, colors and separators, fills `flex` space and truncates to the terminal width.
5. Spaces become non-breaking spaces and every line starts with a reset code, so Claude Code's dim style and whitespace trimming don't alter the output.

The transcript reader keeps an incremental cache in the cache directory, so only newly appended bytes are parsed on each refresh.

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

CI runs the suite on Linux, macOS and Windows with Node 20, 22 and 24.

## Releasing

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading.
2. `npm version <patch|minor|major>`
3. `git push --follow-tags`

The `Release` workflow runs the checks, publishes to npm with provenance and creates a GitHub release from the changelog section. It needs an `NPM_TOKEN` repository secret.
