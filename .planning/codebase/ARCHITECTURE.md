<!-- refreshed: 2026-10-14 -->
# Architecture

**Analysis Date:** 2026-10-14

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                     Entry / Commands                         │
├──────────────────┬──────────────────┬───────────────────────┤
│  Render (stdin)  │  Web editor      │  TUI editor           │
│  `src/cli.ts`    │ `src/editor/`    │  `src/tui/`           │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Core (`src/core/`)                          │
│  context → renderer → panel (tui style) / ansi / themes      │
│  config, presets, edit (pure), load, preview, sample         │
└──────┬───────────────────────────────────┬──────────────────┘
       │ ctx.data.*()                       │ getWidget(type)
       ▼                                    ▼
┌───────────────────────┐        ┌───────────────────────────┐
│ Data readers          │        │ Widgets                    │
│ `src/data/`           │        │ `src/widgets/`             │
└──────────┬────────────┘        └───────────────────────────┘
           ▼
┌─────────────────────────────────────────────────────────────┐
│ Disk/Network: transcript, git, .planning, cache dir, Claude  │
│ settings, config file, usage API                             │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Bin | Node entry, compile cache, error swallow | `src/bin.ts` |
| CLI | Arg parsing, command dispatch (`main`), stdin render path | `src/cli.ts` |
| Types | Payload, Config, WidgetDef, RenderContext, DataSources | `src/core/types.ts` |
| Config | Defaults, normalization/validation, load/save | `src/core/config.ts` |
| Load | `loadForUse`: config + starter preset + GSD auto line | `src/core/load.ts` |
| Context | Builds `RenderContext` with lazy data sources | `src/core/context.ts` |
| Renderer | Widget parts to styled lines (separators, flex, truncation, align) | `src/core/renderer.ts` |
| Panel | Boxed "tui" theme style: grid, columns, breakpoints | `src/core/panel.ts` |
| ANSI | Color levels, width measurement, truncation, style | `src/core/ansi.ts` |
| Themes | Built-in and user themes, resolution | `src/core/themes.ts` |
| Edit ops | Pure config mutations shared by both editors | `src/core/edit.ts` |
| Presets / sample | Preset configs, sample payload for previews | `src/core/presets.ts`, `src/core/sample.ts` |
| Widget registry | `ALL_WIDGETS`, `CATEGORIES`, `getWidget` | `src/widgets/index.ts` |
| Data readers | git, transcript (incremental cache), GSD, agents, usage, history, terminal width | `src/data/*.ts` |
| Importers | ccstatusline / claude-powerline to Config | `src/importers/` |
| Install/update/doctor | Claude settings patching, self-update, diagnostics | `src/commands/` |
| Web editor server | Local HTTP JSON API + inlined HTML | `src/editor/server.ts` |
| Web editor client | Browser bundle (no Node imports) | `src/editor/web/` |
| TUI | Elm-style reducer, keys, view, IO loop | `src/tui/` |

## Pattern Overview

**Overall:** Single-process CLI pipeline with a registry-driven widget plugin model, plus two editors (web, TUI) sharing pure edit logic.

**Key Characteristics:**
- Data-driven: a `Config` (`lines: WidgetItem[][]`) is rendered by looking up each item's `type` in the widget registry.
- Lazy data: `RenderContext.data.git()/transcript()/gsd()/agents()` are memoized thunks, evaluated only if a widget calls them (`src/core/context.ts`); failures yield `null`.
- Widgets are pure `render(ctx, item) => string | {text,color} | null`; `null` hides the widget.
- Editors are generic: widget options (`OptionSpec`) drive inspector UIs and docs generation (`scripts/gen-docs.ts`).
- TUI follows reducer/effect: `reduce(state, action)` is pure (`src/tui/state.ts`); side effects returned as `Effect` and run by `runEffect` (`src/tui/index.ts`).
- Zero runtime deps; esbuild bundles into one ESM file with split chunks.

## Layers

**Core:**
- Purpose: types, config, rendering, theming, pure edit ops
- Location: `src/core/`
- Depends on: `src/data/` (only `context.ts`, `load.ts`), `src/widgets/` (renderer, panel lookups)
- Used by: cli, editors, commands, scripts

**Widgets:**
- Purpose: one `WidgetDef[]` per category, aggregated in `src/widgets/index.ts`; helpers in `src/widgets/shared.ts` (`opt`, `BAR_STYLES`)
- Depends on: core types, `ctx.data`
- Used by: renderer, editors, docs generator

**Data:**
- Purpose: IO readers with caches (`src/data/cache.ts`, `src/data/history.ts`)
- Depends on: `src/core/paths.ts`, `src/core/types.ts`
- Used by: `context.ts`, `cli.ts`, widgets via ctx

**Presentation (editors):**
- `src/editor/server.ts` (Node) and `src/editor/web/*` (browser); `src/tui/*` (terminal)

## Data Flow

### Primary Render Path

1. Claude Code pipes payload JSON to stdin; `main()` dispatches default command (`src/cli.ts`, `runRender`).
2. Config loaded via `loadForUse` (`src/core/load.ts`); usage cache merged into payload when needed (`mergeUsage`, `src/data/usage.ts`).
3. `renderStatus` builds context with `createContext` and `terminalWidth` (`src/cli.ts:157`).
4. `render(ctx)` (`src/core/renderer.ts`): resolves appearance/theme; for style `tui` delegates to `renderPanel` (`src/core/panel.ts`), otherwise `renderLine` per line then `alignLine`.
5. `renderPart` calls `getWidget(type).render(ctx, item)`; output decorated with label/icon/colors.
6. `finalizeLine` (non-breaking spaces, leading reset) and stdout write; update notice appended; background update/usage refresh scheduled (`scheduleCheck`, `scheduleUsage`).

### Web editor flow

1. `ccinfobar edit` calls `startEditor` (`src/editor/server.ts`), serving `__EDITOR_HTML__` (injected at build) and `/api/*` routes (`/api/state`, `/api/preview`, `/api/config`, `/api/themes`, `/api/presets`, `/api/install`, `/api/update`, `/api/shutdown`...).
2. Browser app (`src/editor/web/app.ts`, `store.ts`, `api.ts`) edits config with `src/core/edit.ts`, POSTs for ANSI preview rendered server-side, converts with `ansi-html.ts`.

### TUI flow

1. `runTui` (`src/tui/index.ts`) reads raw keys/mouse, `keys.ts` maps to `Action`, `reduce` yields new `State`, `renderScreen` (`view.ts`) draws, `Effect`s (save, saveTheme, install) executed by `runEffect`.

**State Management:**
- Render path is stateless; persistence via config file (`src/core/paths.ts`), cache dir (transcript, usage, history, update state, last payload).
- Editors keep in-memory config (browser `store.ts`, TUI `State`).

## Key Abstractions

**WidgetDef / WidgetItem:** `src/core/types.ts`; definitions in `src/widgets/*.ts`.
**RenderContext / DataSources:** lazy accessors, injectable for tests (`test/helpers.ts`).
**Theme:** styles `text|blocks|powerline|capsule|tui` (`src/core/themes.ts`).
**Config normalization:** `normalizeConfig` coerces untrusted JSON (`src/core/config.ts`).

## Entry Points

**CLI:** `src/bin.ts` -> `src/cli.ts#main`; subcommands: edit, tui, install, uninstall, import, init, preview, themes, theme, widgets, update, usage, doctor.
**Docs generator:** `scripts/gen-docs.ts` (via `npm run docs`); demo `scripts/demo-gif.ts`.
**Build:** `scripts/build.mjs`.

## Architectural Constraints

- **Threading:** single-threaded; background work (update check, usage fetch) is detached via schedule functions.
- **Global state:** module-level registry in `src/widgets/index.ts`; lazy thunks per context; no mutable singletons otherwise.
- **Build-time globals:** `__VERSION__`, `__EDITOR_HTML__` declared and replaced by esbuild `define`.
- **Browser safety:** `src/editor/web/` and `src/core/edit.ts` must not import Node modules.
- **Imports:** ESM with `.js` suffix on relative imports; Node 20+; cross-platform (Linux/macOS/Windows).
- **Performance:** render path runs on every refresh; avoid eager IO.

## Anti-Patterns

### Eager data reads in widgets

**What happens:** reading files/spawning git directly in a widget.
**Why it's wrong:** slows every refresh and bypasses test injection.
**Do this instead:** use `ctx.data.git()`, `ctx.data.transcript()`, `ctx.data.gsd()`; prefer payload fields.

### Throwing from widgets

**What happens:** widget throws on missing data.
**Why it's wrong:** hides real bugs; renderer must drop it.
**Do this instead:** return `null` (see `src/widgets/cost.ts` style).

### Node imports in shared edit code

**Do this instead:** keep `src/core/edit.ts` pure; do IO in `src/editor/server.ts` or `src/tui/index.ts`.

## Error Handling

**Strategy:** Fail soft. Render never crashes the status line.

**Patterns:**
- `lazy()` catches reader errors and returns `null` (`src/core/context.ts`).
- Invalid stdin JSON prints a short message (`runRender`); `bin.ts` only logs when stdin is a TTY.
- Save failures swallowed in `loadForUse`; editors report via `HttpError`/`effectDone`.

## Cross-Cutting Concerns

**Logging:** none in render path; `doctor` command prints diagnostics (`src/commands/doctor.ts`).
**Validation:** `normalizeConfig`/`normalizeTui` in `src/core/config.ts`; JSON schemas in `schema/`.
**Authentication:** Claude OAuth token read for usage API (`src/data/usage.ts`); editor server is local-only.

---

*Architecture analysis: 2026-10-14*
