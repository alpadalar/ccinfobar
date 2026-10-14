# Coding Conventions

**Analysis Date:** 2026-10-14

## Naming Patterns

**Files:**
- kebab-case, lowercase `.ts`: `src/editor/web/panel-inspector.ts`, `src/editor/web/theme-builder.ts`, `src/core/renderer.ts`.
- Widgets are grouped by category, one module per category, e.g. `src/widgets/cost.ts`, `src/widgets/git.ts`; registered through `src/widgets/index.ts`.
- Tests mirror the area: `test/<area>/<topic>.test.ts`.

**Functions:** camelCase verbs (`recordHistory`, `loadHistory`, `parseShortstat`, `detectOperation`, `formatCurrency`).

**Variables/constants:** camelCase; module-level constants are UPPER_SNAKE (`TIMEOUT` in `src/data/git.ts`, `PRESETS`, `STYLE_GLYPHS`, `RESET`).

**Types:** PascalCase interfaces/types (`GitInfo`, `WidgetDef`, `RenderContext`, `Config`). Shared types live in `src/core/types.ts`.

**Widget types / ids:** kebab-case strings (`session-cost`, `token-rate-graph`, `git-branch`).

## Code Style

**Formatting (Biome, `biome.json`):**
- 2-space indent, line width 110, single quotes, semicolons always, trailing commas all, LF endings, final newline (`.editorconfig`).

**Linting:**
- `biome check .` with the recommended preset. `noNonNullAssertion` is off (`!` allowed); `noControlCharactersInRegex` is off (ANSI regexes allowed). `noExplicitAny` is off only under `test/**`.
- Run `npm run lint:fix` to auto-fix; `npm run check` = typecheck + lint + test.

**TypeScript (`tsconfig.json`):**
- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax` (use `import type` / inline `type` specifiers), `isolatedModules`, target ES2022, NodeNext modules.

## Import Organization

**Order (Biome-organized, alphabetical by module path):**
1. Node builtins with `node:` prefix (`node:fs`, `node:path`)
2. Third-party (only vitest in tests; no runtime deps)
3. Relative modules, always with `.js` suffix (`'../core/types.js'`)

Named imports are sorted case-insensitively with `type` specifiers inline (`type Level, RESET, sanitize`).

**Path Aliases:** None; use relative imports.

## Error Handling

- Widgets return `null` when data is missing and must never throw: guard with `typeof x === 'number'` and return `null` (`src/widgets/cost.ts`).
- Data/IO helpers swallow failures and return `null`/defaults using bare `catch { return null; }` (`git()` in `src/data/git.ts`).
- CLI-level errors print `✗ message` via `console.error` and set a non-zero exit (`src/cli.ts`); user-facing output uses `console.log` only in `src/cli.ts` and `src/commands/`.
- Untrusted input is validated (session ids sanitized in `src/data/history.ts`, hrefs in `src/editor/web/ansi-html.ts`).

## Logging

**Framework:** plain `console` in CLI/commands only. The render path (`src/core`, `src/widgets`, `src/data`) does not log.

## Comments

- Rare and only a few words, lowercase, e.g. `// spawning git is slow on Windows`.
- No JSDoc blocks; types document the API.

## Function Design

- Small pure functions; render path kept fast (no needless I/O, git calls bounded by timeout `CCINFOBAR_GIT_TIMEOUT`).
- Widgets are declarative `WidgetDef` objects: `type, name, category, description, icon{nerd,emoji}, color, sample, options[], render(ctx, item)`. Read options via `opt(item, 'key', default)` from `src/widgets/shared.ts`.
- `render` returns `string | { text } | null`.
- Dependencies injected via `RenderContext` (`src/core/context.ts`) with lazy `data.*` providers so tests can substitute them.

## Module Design

**Exports:** named exports only (no default exports); widget modules export `const widgets: WidgetDef[]`.

**Barrel Files:** `src/widgets/index.ts` and `src/importers/index.ts` aggregate; elsewhere import directly.

**Platform/purity rules:** Node 20+, ESM, cross-platform (use `path`, `windowsHide: true`). `src/core/edit.ts` must stay pure and browser-safe; `src/editor/web/` must not import Node modules.

**Generated files:** after changing widgets run `npm run docs` (regenerates `docs/WIDGETS.md`, `schema/config.schema.json`).

---

*Convention analysis: 2026-10-14*
