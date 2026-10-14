# External Integrations

**Analysis Date:** 2026-10-14

## APIs & External Services

**Anthropic OAuth usage API:**
- `https://api.anthropic.com/api/oauth/usage` - fetches plan usage/rate-limit data for limit widgets
  - Client: global `fetch` in `src/data/usage.ts` (5s `AbortSignal.timeout`, sends `anthropic-beta: oauth-2025-04-20` header, honors `retry-after`)
  - Auth: OAuth access token read from Claude Code credentials (see Authentication)
  - Cache: `usage.json` in cache dir; opt out with `CCINFOBAR_NO_USAGE_API`
  - Consumed by: `src/widgets/limits.ts`

**GitHub (self-update):**
- `https://github.com/alpadalar/ccinfobar/releases/latest` - redirect `location` parsed to find newest version (`fetchLatest` in `src/commands/update.ts`, 4s timeout, user-agent `ccinfobar`)
- Release tarball `https://github.com/alpadalar/ccinfobar/releases/download/v<version>/ccinfobar.tgz` installed through npm via `execFileSync` (120s timeout)
- Update check cached in `update.json`; disable with `CCINFOBAR_NO_UPDATE`

**Claude Code host:**
- Status line payload (JSON) piped on stdin by Claude Code; parsed in `src/cli.ts`, last payload saved to `last-payload.json` in cache dir
- Transcript JSONL read in `src/data/transcript.ts`; agents in `src/data/agents.ts`
- `ccinfobar install` edits `settings.json` / `settings.local.json` (`src/commands/install.ts`) and reads `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`)

**GSD (get-shit-done) framework:**
- Reads `.planning/` files (`STATE.md`, `ROADMAP.md`, `phases/`, `workstreams/`, `active-workstream`) and `gsd-update-check.json` in `src/data/gsd.ts`; widgets in `src/widgets/gsd.ts`; docs in `docs/GSD.md`

**Other status line tools (import only):**
- ccstatusline and claude-powerline configs imported by `src/importers/ccstatusline.ts`, `src/importers/claude-powerline.ts`, `src/importers/index.ts`

**Local subprocesses:**
- `git` via `execFileSync` (`src/data/git.ts`, `src/commands/install.ts`); timeout `CCINFOBAR_GIT_TIMEOUT`
- Terminal probing (`src/data/terminal.ts`, 300ms timeout)
- `which`/`where`, `npm prefix -g` (`src/commands/install.ts`)
- User-defined shell command widget via `execSync` (`src/widgets/custom.ts`, configurable timeout)
- Browser launch via `open` / `cmd /c start` / `xdg-open` (`src/editor/server.ts`)

## Data Storage

**Databases:**
- None

**File Storage:**
- Local filesystem only: config JSON, themes (`src/core/themes.ts`), presets (`src/core/presets.ts`), cache and `history/` JSON files (`src/data/history.ts`, `src/data/cache.ts`)

**Caching:**
- File-based cache keyed by sha1 hash (`src/data/cache.ts`) under the cache dir from `src/core/paths.ts`

## Authentication & Identity

**Auth Provider:**
- Claude Code's existing OAuth credentials (no own auth)
  - macOS Keychain: `security find-generic-password -s "Claude Code-credentials" -w` (`src/data/usage.ts`; service name varies with `CLAUDE_SECURESTORAGE_CONFIG_DIR`)
  - Fallback: `.credentials.json` in the Claude config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`)
  - Tokens are never persisted by ccinfobar.

**Local editor server:**
- `src/editor/server.ts`: `node:http` server bound to `127.0.0.1`, random per-session token (`crypto.randomBytes(16)`) required in `x-ccinfobar-token` header and `?t=` URL param; browser client in `src/editor/web/api.ts`

## Monitoring & Observability

**Error Tracking:**
- None

**Logs:**
- None; widgets return `null` on failure. `ccinfobar doctor` (`src/commands/doctor.ts`) prints diagnostics.

## CI/CD & Deployment

**Hosting:**
- npm registry (package `ccinfobar`, trusted publishing) and GitHub Releases (`alpadalar/ccinfobar`)

**CI Pipeline:**
- GitHub Actions: `.github/workflows/ci.yml` (typecheck + lint on ubuntu; test matrix ubuntu/macos/windows x Node 20/22/24; smoke tests of built CLI)
- `.github/workflows/release.yml` on `v*` tags: build, check, `npm pack`, `gh release create`, npm publish when repo var `NPM_PUBLISH == 'true'`

## Environment Configuration

**Required env vars:**
- None required; all optional (see `STACK.md` for the list)

**Secrets location:**
- No secrets stored by the project; OAuth token read at runtime from Keychain or `.credentials.json`. Release uses `GITHUB_TOKEN` and npm OIDC trusted publishing.

## Webhooks & Callbacks

**Incoming:**
- None (local editor HTTP server only, localhost)

**Outgoing:**
- None

---

*Integration audit: 2026-10-14*
