# Codebase Concerns

**Analysis Date:** 2026-10-14

No TODO/FIXME/HACK markers exist in `src/`. Concerns below come from structural review.

## Tech Debt

**Large multi-purpose modules:**
- Issue: Several files are 450-700 lines and mix concerns.
- Files: `src/tui/state.ts` (695), `src/tui/view.ts` (688), `src/core/themes.ts` (678, theme data plus logic), `src/editor/web/app.ts` (673), `src/data/gsd.ts` (614, hand-rolled frontmatter/markdown parsing), `src/cli.ts` (580), `src/editor/server.ts` (490).
- Impact: Harder to modify safely; the TUI and web editor duplicate some edit logic behind `src/core/edit.ts`.
- Fix approach: Split `src/data/gsd.ts` into frontmatter, markdown and discovery modules. Move theme data out of `src/core/themes.ts`. Split `src/cli.ts` into command dispatch and render pipeline.

**Hand-rolled YAML/frontmatter parser:**
- Issue: `src/data/gsd.ts` (around lines 128-250) parses YAML-like frontmatter with regexes, not a real parser (needed because there are zero runtime dependencies).
- Impact: Unusual YAML (multiline scalars, anchors, quoted keys) silently yields missing data.
- Fix approach: Extend `test/gsd/parser.test.ts` and `test/gsd/realworld.test.ts` with each new real-world format found.

**Silent error swallowing:**
- Issue: Nearly every I/O module uses bare `catch {}` or `catch { return null }` (`src/data/git.ts`, `src/data/usage.ts`, `src/data/history.ts`, `src/data/terminal.ts`, `src/data/agents.ts`, `src/commands/update.ts`, `src/core/load.ts`, `src/editor/server.ts`). This follows the "never throw" rule.
- Impact: Failures such as a corrupt config, a missing git binary or a failed update check give no diagnostic.
- Fix approach: Add an opt-in debug channel (for example `CCINFOBAR_DEBUG` writing to stderr or a log file) in a shared helper.

**Untyped JSONL parsing:**
- Files: `src/data/agents.ts:37`, `src/data/transcript.ts:111` (both `biome-ignore noExplicitAny`).
- Impact: Changes to Claude Code's transcript schema break widgets silently.
- Fix approach: Add narrow type guards, and keep fixtures in `test/fixtures/transcript.jsonl` current.

## Known Bugs

None detected from static review.

## Security Considerations

**OAuth token handling:**
- Risk: `src/data/usage.ts` reads `~/.claude/.credentials.json` or the macOS Keychain (`security find-generic-password`, line ~144) and sends the bearer token to `https://api.anthropic.com/api/oauth/usage`. This is an undocumented endpoint that uses the user's Claude token.
- Current mitigation: Opt-out via `config.usageApi` or `CCINFOBAR_NO_USAGE_API`. Tokens are not cached (only results are). The expiry is checked.
- Recommendations: Keep the token off logs and error strings. Document the behavior in `SECURITY.md`. Never persist the token in `usage.json`.

**Self-update installs code from network:**
- Risk: `src/commands/update.ts` runs `npm install -g` (or `--prefix`) of a version resolved from a GitHub redirect, with fallback to a GitHub release tarball. A background process spawns it on its own (`scheduleCheck`, `spawnSelf`).
- Current mitigation: `assertVersion` validates the tag, `execFileSync` is used with no shell except `npm.cmd` on Windows, and updates are disabled when `CI` or `CCINFOBAR_NO_UPDATE` is set or `config.update === 'off'`. The tarball fallback has no integrity check beyond HTTPS.
- Recommendations: Verify a checksum or provenance for the tarball fallback. Keep `assertVersion` strict, since it guards the Windows `shell: true` path.

**Local web editor:**
- Risk: `src/editor/server.ts` is a local HTTP server that writes config files.
- Current mitigation: Binds to `127.0.0.1` by default, checks the Host and Origin headers (lines ~192-196), and requires a random per-run token (`x-ccinfobar-token`, line ~213).
- Recommendations: `opts.host` is configurable (line 169). The Host check hardcodes `127.0.0.1`/`localhost`, so non-loopback binding would break, but guard against it anyway. Keep the token comparison constant-time (`crypto.timingSafeEqual`) if you touch it. The token is passed in the URL query string (`?t=`), so it can land in browser history.

## Performance Bottlenecks

**Render path spawns processes on every refresh:**
- Problem: `src/data/git.ts` runs `git` via `execFileSync` (timeout 400ms, or 1500ms on Windows). `src/data/terminal.ts` also spawns a process to detect terminal width.
- Cause: The status line is re-run for each Claude Code refresh, and each run is a fresh Node process.
- Improvement path: Cache git results per cwd with a short TTL in `src/data/cache.ts`. Combine multiple git calls into one (`status --porcelain=v2 --branch`). A slow repo can still block rendering for up to the timeout times the number of calls.

**Transcript reading:**
- Problem: `src/data/transcript.ts` (line ~372 uses `statSync` size) parses large JSONL transcripts on each refresh.
- Improvement path: Keep tailing bounded and read only new bytes with an offset cache. Verify the size cap holds for multi-hundred-MB sessions.

## Fragile Areas

**Cross-platform behavior:**
- Files: `src/data/git.ts`, `src/data/terminal.ts`, `src/commands/update.ts` (`npmCommand`, `installKind`), `src/data/usage.ts` (macOS Keychain).
- Why fragile: Path heuristics (`/_npx/`, `/node_modules/ccinfobar/dist/`), npm binary location guesses and Windows `npm.cmd` shells are hard to test from a single OS.
- Safe modification: Check the `ci.yml` matrix covers all three OSes (`.github/workflows/ci.yml`). Normalize paths with `\\` to `/` as existing code does.

**Atomic cache writes:**
- Files: `src/data/cache.ts`, `src/data/history.ts`, `src/data/usage.ts` (tmp + rename), `src/data/terminal.ts:62` (plain `writeFileSync`, not atomic).
- Why fragile: Concurrent status line processes can race. Update/usage locks are mtime-based files (`*.lock`, `src/commands/update.ts`) and can go stale.
- Safe modification: Use the tmp+rename pattern for every cache write.

**Browser/Node boundary:**
- Files: `src/core/edit.ts`, `src/editor/web/*`.
- Why fragile: Any Node import in the shared or web code breaks the browser bundle. Only a convention and the build enforce this.
- Safe modification: Run `npm run build` and `npm run check` after changing either area.

**Generated docs and schema:**
- Files: `docs/WIDGETS.md`, `schema/config.schema.json`.
- Why fragile: They can drift from the widget definitions if `npm run docs` is skipped.

## Scaling Limits

**Many widgets and lines:** Each widget is computed per render with no memoization across refreshes; there is no benchmark in the repo to detect regressions in render latency.

## Dependencies at Risk

Zero runtime dependencies; dev dependencies only. External API risk: the undocumented Anthropic usage endpoint (`src/data/usage.ts`) and Claude Code's stdin payload and transcript format can change without notice.

## Missing Critical Features

**Observability:** No debug or verbose mode for diagnosing why a widget is empty (see silent error swallowing above).

## Test Coverage Gaps

**No coverage tooling:**
- What's not tested: No coverage config in `package.json` or `vitest.config.ts`, so gaps are unmeasured.
- Priority: Medium.

**Missing dedicated tests:**
- Files with no matching test under `test/`: `src/data/terminal.ts`, `src/data/history.ts`, `src/data/cache.ts`, `src/core/load.ts`, `src/core/themes.ts` (only `test/themes/themes.test.ts`), `src/editor/web/*` (browser code; only `ansi-html` and server are tested), `src/commands/` update install flow with a real npm.
- Risk: Cache races, terminal width detection and the web editor UI can regress unnoticed.
- Priority: Medium (terminal/history/cache), Low (web UI).

---

*Concerns audit: 2026-10-14*
