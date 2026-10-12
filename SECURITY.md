# Security Policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use [GitHub private vulnerability reporting](https://github.com/alpadalar/ccinfobar/security/advisories/new) instead. You should get a response within a week.

## Design notes

- Rendering only reads local files (config, Claude Code transcript, `.planning/`, git) and runs `git`.
- Once a day a detached background process makes one request to `github.com/alpadalar/ccinfobar/releases/latest` to learn the newest version. With `update: "auto"` (default) it then runs `npm install -g ccinfobar@<version>`, falling back to that release's tarball from GitHub. npm releases are published from GitHub Actions with trusted publishing and provenance. Use `update: "notify"` or `"off"`, or set `CCINFOBAR_NO_UPDATE=1`, if you prefer to update by hand.
- When Claude Code sends no `rate_limits` and a usage limit widget is on the status line, a detached background process reads your Claude login (`~/.claude/.credentials.json`, or the macOS Keychain item `Claude Code-credentials`) and sends it to `api.anthropic.com/api/oauth/usage` at most every 3 minutes. The token is sent nowhere else and is not stored; the cache keeps only the percentages and a short hash to tell accounts apart. Set `usageApi: false` or `CCINFOBAR_NO_USAGE_API=1` to turn it off.
- The `command` widget runs the shell command you configure, with the Claude Code payload on stdin. Only add commands you trust, and be careful when importing configs from others.
- `ccinfobar edit` listens on `127.0.0.1` only, on a random port. Every API call requires a random per-session token, and requests with a foreign `Host` or `Origin` header are rejected.
- `ccinfobar install` backs up `~/.claude/settings.json` to `settings.json.ccinfobar-backup` before changing it.
