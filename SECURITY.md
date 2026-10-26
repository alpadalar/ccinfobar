# Security Policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use [GitHub private vulnerability reporting](https://github.com/alpadalar/ccinfobar/security/advisories/new) instead. You should get a response within a week.

## Design notes

- Rendering only reads local files (config, Claude Code transcript, `.planning/`, git) and runs `git`, plus `jj` without a shell when a jj widget is shown inside a `.jj` folder.
- Once a day a detached background process makes one request to `github.com/alpadalar/ccinfobar/releases/latest` to learn the newest version. With `update: "auto"` (default) it then runs `npm install -g --ignore-scripts ccinfobar@<version>`, falling back to that release's tarball from GitHub. npm releases are published from GitHub Actions with trusted publishing and provenance. Use `update: "notify"` or `"off"`, or set `CCINFOBAR_NO_UPDATE=1`, if you prefer to update by hand. Claude Code's `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` also stops this check.
- When Claude Code sends no `rate_limits` and a usage limit widget is on the status line, a detached background process reads your Claude login (`~/.claude/.credentials.json`, or the macOS Keychain item `Claude Code-credentials`) and sends it to `api.anthropic.com/api/oauth/usage` at most every 3 minutes. The token is sent nowhere else and is not stored; the cache keeps only the percentages and a short hash to tell accounts apart. Set `usageApi: false`, `CCINFOBAR_NO_USAGE_API=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to turn it off.
- Plan limits are shared between sessions through `limits/<account key>.json` in the cache dir (percentages, reset times and a few samples), and the usage cache is one `jobs/usage-<account key>.json` per Claude config dir. With a cost widget or a daily budget on the status line, an estimated cost ledger is kept in `ledger/YYYY-MM.jsonl` (time, session id, project path and the session's running cost total) for 13 months. These files are created with mode 0600 and never contain your token; the account key is a hash of the config dir, not of the token.
- All background checks run in one detached process per refresh, never in the render itself, and write their results to `jobs/<key>.json` in the cache dir (mode 0600). The opt-in sources only run when their widget is on the status line:
  - `service-status` sends a plain GET to `status.claude.com`, with no credentials. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` stops it.
  - `http` sends a GET to the URL you configure, with the headers you configure. Header and query secrets can only come from env vars, are filled in at fetch time, and are never stored, logged or shown by `explain` or `doctor`; an item that would send one over plain http to a host other than localhost is refused, and cross-origin redirects are refused. Only the values your JSON paths pick are cached. You typed the URL, so `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` does not stop it.
  - `pr` with `ci: true` runs your own `gh pr checks` without a shell, for `github.com` or a host you logged in to with gh (`*.ghe.com` included). ccinfobar never reads a GitHub token. You turned it on, so `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` does not stop it.
  - `CCINFOBAR_NO_JOBS=1` turns every background check off.
- The status line command is always an installed copy (global, or pinned under `~/.config/ccinfobar/app`), never `npx …@latest`, so a refresh never downloads code.
- The `command` widget runs the shell command you configure, with the Claude Code payload on stdin. Only add commands you trust, and be careful when importing configs from others.
- An `http` item sends the env vars it names to the host in its URL, so a shared config could name one of your secrets. Claude, Anthropic, AWS, Google Cloud, Azure, ccinfobar, npm and SSH variables (`ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `GOOGLE_*`, `GCLOUD_*`, `GCP_*`, `AZURE_*`, `CCINFOBAR_*`, `SSH_*`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`) are always refused, and GitHub tokens (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`) go only to `api.github.com`, `*.ghe.com` or a host gh is logged in to. Any other variable goes to whatever host the item names: check the URL and headers of a config before you use it; `ccinfobar doctor` lists every http item with its host and the variables it sends.
- `ccinfobar edit` listens on `127.0.0.1` only, on a random port. Every API call requires a random per-session token, and requests with a foreign `Host` or `Origin` header are rejected.
- `ccinfobar install` saves a timestamped copy of `~/.claude/settings.json` (mode 0600) under `<configDir>/backups/` before every change that alters the file, keeps the last 10 plus the original, and records what it wrote in `<configDir>/manifest.json` so `uninstall` can restore it.
