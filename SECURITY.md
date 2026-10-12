# Security Policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use [GitHub private vulnerability reporting](https://github.com/alpadalar/ccinfobar/security/advisories/new) instead. You should get a response within a week.

## Design notes

- Rendering only reads local files (config, Claude Code transcript, `.planning/`, git) and runs `git`.
- Once a day a detached background process makes one request to `github.com/alpadalar/ccinfobar/releases/latest` to learn the newest version. With `update: "auto"` (default) it then runs `npm install -g` with that release's tarball from GitHub. Use `update: "notify"` or `"off"`, or set `CCINFOBAR_NO_UPDATE=1`, if you prefer to update by hand.
- The `command` widget runs the shell command you configure, with the Claude Code payload on stdin. Only add commands you trust, and be careful when importing configs from others.
- `ccinfobar edit` listens on `127.0.0.1` only, on a random port. Every API call requires a random per-session token, and requests with a foreign `Host` or `Origin` header are rejected.
- `ccinfobar install` backs up `~/.claude/settings.json` to `settings.json.ccinfobar-backup` before changing it.
