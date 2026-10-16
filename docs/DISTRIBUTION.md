# Distribution

This repo has a ready Homebrew formula, brew-aware updates and a measured startup decision. Publishing the tap, publishing to npm and any new build or release channel are the owner's call.

## Homebrew (F1)

The Homebrew tap `alpadalar/homebrew-tap` does not exist yet. The owner creates it (see [Publishing the formula](#publishing-the-formula-owner)). Until then the `brew` commands below fail, which is why the README has no Homebrew instructions yet.

### Install with Homebrew

```sh
brew install alpadalar/tap/ccinfobar
ccinfobar install
```

The formula installs the npm package into Homebrew's Cellar and depends on Homebrew's `node`. It never writes Claude Code settings. `ccinfobar install` does that, the same way as for an npm install: it asks before replacing another status line, keeps a backup and records what it replaced.

Update:

```sh
brew upgrade ccinfobar
```

Remove. Run `ccinfobar uninstall` first, so it can restore the status line you had before, then remove the formula:

```sh
ccinfobar uninstall
brew uninstall ccinfobar
```

If you run `brew uninstall ccinfobar` first, Claude Code's `statusLine` still points at a command that no longer exists. Reinstall, or reset the `statusLine` setting by hand.

### How a Homebrew copy updates

ccinfobar knows it was installed with Homebrew when the real path of its entry script contains `/Cellar/ccinfobar/` (backslashes are normalized first). This covers `/opt/homebrew`, `/usr/local`, `/home/linuxbrew/.linuxbrew`, `~/.linuxbrew` and custom prefixes. It never runs `brew` to find out. The Homebrew prefix is the part of that path before `/Cellar/`.

Homebrew owns this copy, so ccinfobar never updates it with npm:

| `update` | Homebrew copy |
| --- | --- |
| `"auto"` (default) | Acts as `"notify"` |
| `"notify"` | Notifies |
| `"off"` | Never checks |

The config file is never rewritten. The same config on an npm install keeps auto-updating.

Every surface follows this:

- **Status line:** when a newer version is known, the last line ends with `⬆ ccinfobar <version> · brew upgrade ccinfobar`.
- **`ccinfobar update`:** prints `New version available: <current> → <latest>` and then `` Installed with Homebrew: run `brew upgrade ccinfobar` ``, exits 0 and never runs npm. `ccinfobar update --check` only looks, as before.
- **Background check:** it still asks GitHub for the latest release and records it, so the notice can show, but it never installs. `update: "off"`, `CI`, `CCINFOBAR_NO_UPDATE` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turn it off as before.
- **Web editor:** Settings shows `This is ccinfobar <version>, Homebrew install; …` and ``Homebrew updates this copy: run `brew upgrade ccinfobar`. ccinfobar only shows a notice, whichever mode is picked.``, with no Update button. `POST /api/update` with `install: true` answers 409 `` Installed with Homebrew: run `brew upgrade ccinfobar` `` (`errorId: update.brewRefused`).
- **`ccinfobar doctor`:** `✓ Up to date (auto mode, updates via brew upgrade ccinfobar (Homebrew install), last checked …)`, or ``✗ Update available: <current> → <latest> (run `brew upgrade ccinfobar`)``.

The status line command works even when Claude Code's PATH has no `node`, for example with the native Claude Code installer. The package's entry starts with `#!/usr/bin/env node`. Homebrew rewrites that shebang at install time to `<prefix>/opt/node/bin/node`, which survives `brew upgrade node`. The formula needs no code for it.

`ccinfobar install` on a Homebrew copy sets the `statusLine` command to `<prefix>/bin/ccinfobar`, for example `/opt/homebrew/bin/ccinfobar` on Apple silicon, `/usr/local/bin/ccinfobar` on Intel Macs and `/home/linuxbrew/.linuxbrew/bin/ccinfobar` on Linux. That symlink survives `brew upgrade ccinfobar`. It prefers this path over an npm-global copy that comes earlier on PATH. It never writes a `/Cellar/<version>/` path, which would break on the next upgrade, and never Homebrew's versioned `node` path.

### Publishing the formula (owner)

The formula lives in this repo at `packaging/homebrew/ccinfobar.rb`. This repo is not a tap: the owner copies the formula into the tap. The committed formula has the current `package.json` version and a placeholder sha256 of 64 zeros, so it cannot install anything until the script fills it in. A wrong sha256 makes `brew install` fail safely.

**First tap version.** The first version in the tap must be the first published npm version that contains Homebrew detection, the next release after 0.6.2. Never publish 0.6.2 (or anything older) to the tap: it has no Homebrew detection, so it would update itself with `npm install -g` and leave a second copy outside Homebrew.

Do the Homebrew steps on a machine where a Homebrew copy of ccinfobar is fine. If Homebrew's `bin` comes first on PATH, the brew copy shadows an npm-global `ccinfobar`.

1. Publish the release to npm as described in [DEVELOPMENT.md](DEVELOPMENT.md#releasing).
2. When npm has it, fill in the formula in this repo:

   ```sh
   node scripts/homebrew-formula.mjs
   ```

   It reads the version from `package.json` (`--version <x.y.z>` picks another), fetches `https://registry.npmjs.org/ccinfobar/<version>`, downloads the registry tarball, checks its sha512 against npm's `dist.integrity` and only then rewrites the `url` and `sha256` lines. It prints `homebrew-formula: <version> <sha256>`, or `homebrew-formula: already at <version>`. On any error it prints `homebrew-formula: <message>`, exits 1 and writes nothing. `node scripts/homebrew-formula.mjs --check` checks the formula's structure offline.

3. Commit the updated `packaging/homebrew/ccinfobar.rb` in this repo.
4. Create the tap once, then copy the formula into it:

   ```sh
   brew tap-new alpadalar/tap
   cp packaging/homebrew/ccinfobar.rb "$(brew --repository alpadalar/tap)/Formula/ccinfobar.rb"
   ```

   `brew tap-new` also adds bottle workflows. A pure-JS formula does not need bottles, so they can be removed.

5. Check and try it in the tap:

   ```sh
   brew audit --strict --online alpadalar/tap/ccinfobar
   brew install alpadalar/tap/ccinfobar
   brew test alpadalar/tap/ccinfobar
   ```

   `brew test` runs `ccinfobar --version` and renders a small payload with temp config, cache and Claude dirs. It does not touch your settings and needs no network.

6. Create the GitHub repository `alpadalar/homebrew-tap`, then commit and push the tap. Users then run `brew install alpadalar/tap/ccinfobar`, which taps it for them.

Later releases: after each npm publish, repeat steps 2 to 6 (the tap already exists). `brew bump-formula-pr --version <x.y.z> alpadalar/tap/ccinfobar` works too, but it does not check the tarball against npm's integrity hash.

Notes:

- `brew bump` and `brew bump-formula-pr` skip versions released less than a day ago and say `released less than 1 day ago`. Wait a day or use the script.
- Homebrew's `std_npm_args` pass `--min-release-age=1` to npm. Research (2026-10-15) expects this not to block installing the tarball Homebrew already downloaded, because ccinfobar has no dependencies. This was not tried. If the first `brew install` within a day of publishing fails, wait a day.
- This repo's release workflow does not push to the tap, and no CI job builds or publishes anything for Homebrew. `npm version` does not change the formula. The script does, so the formula's version lags `package.json` until you run it after publishing.

### README snippet

Paste this into the README after the tap exists, for example as a `### Homebrew` part after `### Pinned install` in Quick start:

````markdown
### Homebrew

On macOS or Linux with [Homebrew](https://brew.sh):

```sh
brew install alpadalar/tap/ccinfobar
ccinfobar install
```

Homebrew owns this copy, so ccinfobar never updates it with npm. When a new version is out, the status line shows `⬆ ccinfobar <version> · brew upgrade ccinfobar`. Update with `brew upgrade ccinfobar`. To remove it, run `ccinfobar uninstall` first, which restores your previous status line, then `brew uninstall ccinfobar`.
````
