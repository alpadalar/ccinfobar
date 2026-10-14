# Security Policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use [GitHub private vulnerability reporting](https://github.com/alpadalar/ccinfobar/security/advisories/new) instead. You should get a response within a week.

## Design notes

- Rendering only reads local files (config, Claude Code transcript, `.planning/`, git) and runs `git`.
- Once a day a detached background process makes one request to `github.com/alpadalar/ccinfobar/releases/latest` to learn the newest version. With `update: "auto"` (default) it then runs `npm install -g --ignore-scripts ccinfobar@<version>`, falling back to that release's tarball from GitHub. npm releases are published from GitHub Actions with trusted publishing and provenance. Use `update: "notify"` or `"off"`, or set `CCINFOBAR_NO_UPDATE=1`, if you prefer to update by hand. Claude Code's `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` also stops this check.
- When Claude Code sends no `rate_limits` and a usage limit widget is on the status line, a detached background process reads your Claude login (`~/.claude/.credentials.json`, or the macOS Keychain item `Claude Code-credentials`) and sends it to `api.anthropic.com/api/oauth/usage` at most every 3 minutes. The token is sent nowhere else and is not stored; the cache keeps only the percentages and a short hash to tell accounts apart. Set `usageApi: false`, `CCINFOBAR_NO_USAGE_API=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to turn it off.
- Plan limits are shared between sessions through `limits/<account key>.json` in the cache dir (percentages, reset times and a few samples), and the usage cache is one `usage-<account key>.json` per Claude config dir. With a cost widget or a daily budget on the status line, an estimated cost ledger is kept in `ledger/YYYY-MM.jsonl` (time, session id, project path and the session's running cost total) for 13 months. These files are created with mode 0600 and never contain your token; the account key is a hash of the config dir, not of the token.
- The status line command is always an installed copy (global, or pinned under `~/.config/ccinfobar/app`), never `npx …@latest`, so a refresh never downloads code.
- The `command` widget runs the shell command you configure, with the Claude Code payload on stdin. Only add commands you trust, and be careful when importing configs from others.
- `ccinfobar edit` listens on `127.0.0.1` only, on a random port. Every API call requires a random per-session token, and requests with a foreign `Host` or `Origin` header are rejected.
- `ccinfobar install` backs up `~/.claude/settings.json` to `settings.json.ccinfobar-backup` before changing it.
