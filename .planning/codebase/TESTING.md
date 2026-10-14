# Testing Patterns

**Analysis Date:** 2026-10-14

## Test Framework

**Runner:**
- Vitest ^5 (`vitest.config.ts`: include `test/**/*.test.ts`, environment `node`).
- Imports are explicit: `import { describe, expect, it } from 'vitest'` (no globals).

**Assertion Library:** Vitest `expect`.

**Run Commands:**
```bash
npm test                       # vitest run (all)
npm run test:watch             # watch mode
npx vitest run test/core       # subset by area
npm run check                  # typecheck + lint + test (run before finishing)
```
No coverage tooling or threshold is configured.

## Test File Organization

**Location:** separate `test/` tree mirroring `src/` areas (not co-located).

**Naming:** `test/<area>/<topic>.test.ts`.

```
test/
├── helpers.ts            # ctxWith, renderWidget, NOW
├── fixtures/             # payload.json, transcript.jsonl, gsd/*, import/*
├── core/ commands/ data/ editor/ gsd/ importers/ integration/ themes/ tui/ widgets/
```

## Test Structure

**Suite Organization:**
```typescript
describe('history', () => {
  it('merges samples closer than five seconds and keeps the newest last', () => {
    const env = tmpEnv();
    recordHistory('s1', { t: 0, tok: 1 }, env);
    expect(loadHistory('s1', env)).toEqual(out);
  });
});
```

**Patterns:**
- One `describe` per unit; `it` titles are behavior sentences.
- Several related `expect`s per `it`; regex assertions for rendered strings (`toMatch(/^[▁-█]{16} \d+ t\/s$/)`).
- `toMatchObject` for partial structures, `toEqual` for exact.
- Reducer-style tests chain actions: `const run = (s, ...actions) => actions.reduce(reduce, s)` (`test/tui/state.test.ts`).
- `beforeEach`/`afterEach` for servers and temp dirs (`test/editor/server.test.ts`); `beforeAll`/`afterAll` for a git repo fixture (`test/data/git.test.ts`).

## Mocking

**Framework:** none; no `vi.mock`/`vi.fn`/`vi.spyOn` usage. Use dependency injection and real temp dirs instead.

**Patterns:**
```typescript
// test/helpers.ts
const c = ctxWith({ payload, config: { colorLevel: 0 }, git: sampleGit, width: 120 });
renderWidget('session-cost', c, { options: { decimals: 1 } });
```
- Inject data via `RenderContext` providers (`git`, `gsd`, `transcript`, `history`, `agents`); sample data comes from `src/core/sample.ts`.
- Pass an `env` object (`CCINFOBAR_CACHE_DIR`, `CCINFOBAR_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`) pointing to `fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-...'))` rather than touching real dirs.
- Use the fixed clock `NOW = new Date('2026-10-12T12:00:00Z')` from `test/helpers.ts`; set `colorLevel: 0` for plain text output.

**What to Mock:** nothing; stub inputs (env, clock, data providers).
**What NOT to Mock:** filesystem (use temp dirs), git (real repo created in a temp dir), HTTP (real server on 127.0.0.1).

## Fixtures and Factories

- `test/fixtures/payload.json`: Claude Code stdin payload; `test/fixtures/transcript.jsonl`.
- `test/fixtures/gsd/<scenario>/.planning/{STATE,ROADMAP}.md`: GSD parser scenarios.
- `test/fixtures/import/*.json`: ccstatusline and claude-powerline settings.
- Inline factories such as `const cfg = (): Config => ({ ...defaultConfig(), lines: [...] })`.

## Coverage

**Requirements:** None enforced. Add tests for every new widget and parser, and for edge cases returning `null`.

## Test Types

**Unit Tests:** most suites (core, widgets, data parsers, tui state/keys/view, themes, importers).

**Integration Tests:** `test/integration/cli.test.ts` spawns `dist/ccinfobar.js` via `spawnSync` with piped payload; wrapped in `describe.skipIf(!fs.existsSync(bin))`, so run `npm run build` first (CI does build before test). `test/editor/server.test.ts` exercises the editor HTTP API with `http.request` and the `x-ccinfobar-token` header.

**E2E Tests:** Not used. Git tests skip when git is unavailable (`hasGit()` in `test/data/git.test.ts`).

## Common Patterns

**Async Testing:**
```typescript
const res = await request('GET', '/api/config');
expect(res.status).toBe(200);
```

**Error/absence Testing:**
```typescript
expect(renderWidget('context-graph', at(NOW.getTime()))).toBeNull();
recordHistory('../../etc/x', ...); // unsafe ids fall back to default.json
```

**Cross-platform:** tests strip ANSI/OSC8 with a `strip` helper and avoid OS-specific paths; CI (`.github/workflows/ci.yml`) runs typecheck, lint, build, then tests.

---

*Testing analysis: 2026-10-14*
