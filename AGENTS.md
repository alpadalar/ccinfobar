# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

ccinfobar is a Claude Code status line written in TypeScript with zero runtime dependencies. Claude Code pipes a JSON payload on stdin; `src/cli/main.ts` dispatches commands and `src/cli/render.ts` renders the configured widgets as ANSI lines.

## Commands

- `npm run check`: typecheck, lint and test. Run it before finishing.
- `npx vitest run test/<area>`: run a subset of tests.
- `npm run build`: bundle to `dist/ccinfobar.js`.
- `npm run docs`: regenerate `docs/WIDGETS.md` and `schema/config.schema.json` after changing widgets.

## Rules

- No runtime dependencies. Node 20+, ESM, `.js` suffix on relative imports.
- Must work on Linux, macOS and Windows.
- Widgets return `null` when there is no data and must never throw.
- Keep the render path fast; it runs on every refresh.
- Comments: rare and only a few words.
- `src/core/edit.ts` is shared by the web editor and the TUI; keep it pure and browser-safe.
- The browser bundle (`src/editor/web/`) must not import Node modules.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for architecture details.
