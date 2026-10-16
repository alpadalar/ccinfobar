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
- **Web editor:** Settings shows `This is ccinfobar <version>, Homebrew install; …` and ``Homebrew updates this copy: run `brew upgrade ccinfobar`. "Install automatically" acts like "Tell me"; ccinfobar never installs it.`` (not with `update: "off"`), with no Update button. `POST /api/update` with `install: true` answers 409 `` Installed with Homebrew: run `brew upgrade ccinfobar` `` (`errorId: update.brewRefused`).
- **Terminal editor:** the Updates help reads `Homebrew updates this copy: run brew upgrade ccinfobar. auto acts like notify and shows a note, off never checks`. In the web editor the "Install automatically" tooltip says it only shows a note on a Homebrew copy.
- **`ccinfobar doctor`:** `✓ Up to date (notify mode, auto acts as notify, updates via brew upgrade ccinfobar, Homebrew install, last checked …)` (with `update: "notify"` it says just `notify mode`), or ``✗ Update available: <current> → <latest> (run `brew upgrade ccinfobar`)``.

The newest version comes from the GitHub "latest release", which the release workflow creates when the tag is pushed. The tap gets the version later, by hand, after npm has it (see [Publishing the formula](#publishing-the-formula-owner)), and `brew bump*` skips versions younger than a day. Until the tap has it, brew users already see the notice, `doctor` reports `✗ Update available` and `ccinfobar update` names the new version, but `brew upgrade ccinfobar` says it is already installed. Updating the tap in the same release step keeps this window short.

The status line command works even when Claude Code's PATH has no `node`, for example with the native Claude Code installer. The package's entry starts with `#!/usr/bin/env node`. Homebrew rewrites that shebang at install time to `<prefix>/opt/node/bin/node`, which survives `brew upgrade node`. The formula needs no code for it.

`ccinfobar install` on a Homebrew copy sets the `statusLine` command to `<prefix>/bin/ccinfobar`, for example `/opt/homebrew/bin/ccinfobar` on Apple silicon, `/usr/local/bin/ccinfobar` on Intel Macs and `/home/linuxbrew/.linuxbrew/bin/ccinfobar` on Linux. That symlink survives `brew upgrade ccinfobar`. It prefers this path over an npm-global copy that comes earlier on PATH. It uses the path only when its real path is inside `<prefix>/Cellar/ccinfobar/`: if `npm install -g` with Homebrew's node already owns `<prefix>/bin/ccinfobar`, or the keg is unlinked, it takes `<prefix>/opt/ccinfobar/bin/ccinfobar` instead, and it never points Claude Code at a copy that updates itself with npm. It never writes a `/Cellar/<version>/` path, which would break on the next upgrade, and never Homebrew's versioned `node` path.

### Publishing the formula (owner)

The formula lives in this repo at `packaging/homebrew/ccinfobar.rb`. This repo is not a tap: the owner copies the formula into the tap. The committed formula has the current `package.json` version and a placeholder sha256 of 64 zeros, so it cannot install anything until the script fills it in. A wrong sha256 makes `brew install` fail safely.

**First tap version.** The first version in the tap must be the first published npm version that contains Homebrew detection, the next release after 0.6.2. Never publish 0.6.2 (or anything older) to the tap: it has no Homebrew detection, so it would update itself with `npm install -g` and leave a second copy outside Homebrew. The script enforces this: it refuses any version below 0.6.3 (`homebrew-formula: 0.6.2 has no Homebrew detection; the tap needs 0.6.3 or later`), and `--check` refuses a filled-in formula below it. The committed placeholder (zero sha256) passes `--check` with a note.

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

   `brew test` sets temp config, cache and Claude dirs and turns off update checks, background jobs and the usage API first, then runs `ccinfobar --version` and renders a small payload. It does not touch your settings and needs no network.

6. Create the GitHub repository `alpadalar/homebrew-tap`, then commit and push the tap. Users then run `brew install alpadalar/tap/ccinfobar`, which taps it for them.

Later releases: after each npm publish, repeat steps 2 to 6 right away (the tap already exists). Brew users see the update notice as soon as the GitHub release exists, so a late tap update leaves them with a `brew upgrade` that does nothing. `brew bump-formula-pr --version <x.y.z> alpadalar/tap/ccinfobar` works too, but it does not check the tarball against npm's integrity hash.

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

## Startup decision (F2)

The question: is Node's startup a big enough part of each refresh to justify a faster launcher? Every number here was measured on 2026-10-16 on build 60d6d21 (version 0.6.2 plus all of Phases 5 to 10), unless a line says otherwise.

### Method

- Same method as the baseline in [DEVELOPMENT.md](DEVELOPMENT.md#benchmark): `ccinfobar bench --runs 20` at priority 0 (`nice -n -10`, which reaches 0 on this machine), cwd this git repo, default layout, `npm run build` first.
- Machine: Intel i7-1165G7 (8 threads), Linux 7.2.9-200.fc44.x86_64 (Fedora 44). Nothing else heavy ran. The 1-minute load average stayed between 1.02 and 1.05 during the bench runs.
- Three Node builds, run back to back from 06:56 to 06:58 local time: distro round 1, v22.17.1 round 1, distro round 2, v22.17.1 round 2, v24.21.0 round 1, then the non-git run.
- Lever deltas are measured back to back on the same build and the same load, never against an older run.
- Every run gets fresh temp dirs and no access to the real config, caches or `~/.claude`:

  ```sh
  npm run build
  T=$(mktemp -d)
  mkdir -p "$T/home" "$T/cfg" "$T/cache" "$T/claude"
  env -i PATH=/usr/local/bin:/usr/bin HOME="$T/home" CCINFOBAR_CONFIG_DIR="$T/cfg" CCINFOBAR_CACHE_DIR="$T/cache" CLAUDE_CONFIG_DIR="$T/claude" CCINFOBAR_NO_UPDATE=1 CCINFOBAR_NO_USAGE_API=1 nice -n -10 node dist/ccinfobar.js bench --runs 20 --json --config "$T/cfg/config.json"
  rm -r "$T"
  ```

  Replace `node` with the full path of another Node binary to measure that build. On a machine that does not start tools at nice 10, drop `nice -n -10`.

- The breakdown below comes from a dev-only script. It is not part of the package, CI or the build, and it uses its own temp dirs:

  ```sh
  nice -n -10 node scripts/startup-probe.mjs --node <node> --rounds 2 --iterations 30 --onefile --json
  ```

The Node builds differ in how they were compiled (`process.config.variables`):

| Node | Source | `node_use_node_snapshot` | `node_use_node_code_cache` |
|------|--------|:------------------------:|:--------------------------:|
| v22.23.1 | Fedora package, `/usr/bin/node` | false | false |
| v22.17.1 | official build (nvm) | true | true |
| v24.21.0 | official build (nvm) | true | true |

Fedora builds Node without the built-in startup snapshot and code cache, so every start compiles Node's own JavaScript again. Official builds from nodejs.org have both. This one difference decides most of the answer.

### Results

Distro Node, 2026-10-16, `nice -n -10` (priority 0), Node v22.23.1 (`node_use_node_snapshot` false, `node_use_node_code_cache` false), Intel i7-1165G7 (8 threads), Linux 7.2.9-200.fc44.x86_64 (Fedora 44), load average 1.05 → 1.03, cwd this git repo, default layout, N = 20, two rounds:

| Row | median r1 (ms) | median r2 (ms) | p95 r1 / r2 (ms) | min (ms) | max (ms) |
|-----|---------------:|---------------:|-----------------:|---------:|---------:|
| `node -e 0` | 65.2 | 64.8 | 69.9 / 66.4 | 62.6 | 71.5 |
| cold | 143.2 | 143.8 | 150.3 / 153.2 | 140.9 | 158.4 |
| warm | 126.8 | 126.1 | 131.6 / 128.2 | 124.2 | 139.2 |
| warm, compile cache off | 136.6 | 137.3 | 142.6 / 142.0 | 134.2 | 155.2 |
| hook UserPromptSubmit | 74.8 | 73.9 | 79.0 / 76.5 | 72.3 | 79.0 |

ccinfobar overhead 61.6 / 61.3 ms; hook overhead 9.6 / 9.0 ms.

Official Node v22.17.1, same day, method and machine, `nice -n -10` (priority 0), Node v22.17.1 (`node_use_node_snapshot` true, `node_use_node_code_cache` true), load average 1.04 → 1.03, cwd this git repo, default layout, N = 20, two rounds:

| Row | median r1 (ms) | median r2 (ms) | p95 r1 / r2 (ms) | min (ms) | max (ms) |
|-----|---------------:|---------------:|-----------------:|---------:|---------:|
| `node -e 0` | 15.9 | 15.9 | 16.7 / 16.5 | 14.8 | 16.8 |
| cold | 71.8 | 72.9 | 72.9 / 76.5 | 70.8 | 85.5 |
| warm | 59.7 | 58.5 | 62.0 / 61.5 | 57.0 | 63.8 |
| warm, compile cache off | 65.7 | 65.9 | 68.4 / 66.7 | 64.5 | 71.7 |
| hook UserPromptSubmit | 22.2 | 21.8 | 23.3 / 23.2 | 20.9 | 24.7 |

ccinfobar overhead 43.8 / 42.7 ms; hook overhead 6.3 / 5.9 ms.

Official Node v24.21.0, same day, method and machine, `nice -n -10` (priority 0), Node v24.21.0 (`node_use_node_snapshot` true, `node_use_node_code_cache` true), load average 1.03 → 1.03, cwd this git repo, default layout, N = 20, one round:

| Row | median (ms) | p95 (ms) | min (ms) | max (ms) |
|-----|------------:|---------:|---------:|---------:|
| `node -e 0` | 20.5 | 24.1 | 18.1 | 24.1 |
| cold | 76.3 | 82.8 | 71.9 | 85.1 |
| warm | 62.4 | 65.7 | 59.6 | 66.7 |
| warm, compile cache off | 69.0 | 71.6 | 66.2 | 71.7 |
| hook UserPromptSubmit | 23.5 | 27.5 | 21.6 | 28.9 |

ccinfobar overhead 41.9 ms; hook overhead 3.0 ms.

Non-git cwd (distro Node, a temp dir, load average 1.03 → 1.02, N = 20): `node -e 0` 65.3, cold 135.7, warm 120.1 (p95 124.0), warm with compile cache off 128.4, hook 75.2 ms. Overhead 54.8 ms, so a git repo as cwd adds 6.7 ms.

For comparison, the 2026-10-14 baseline in DEVELOPMENT.md (distro Node v22.23.1, load average 2.10 → 1.85) gave warm 130.1 ms and overhead 57.0 ms.

Boot ratio (`node -e 0` median / warm median, mean of the rounds). D-04 in the phase plan says a launcher prototype is worth trying only if Node's boot is at least 50% of the warm render:

| Node | ratio | per round | D-04 (≥ 50%) |
|------|------:|----------:|:------------:|
| v22.23.1 distro | 65.0 / 126.4 = **51.4%** | 51.4%, 51.4% | triggers |
| v22.17.1 official | 15.9 / 59.1 = **26.8%** | 26.6%, 27.1% | does not trigger |
| v24.21.0 official | 20.5 / 62.4 = **32.8%** | 32.8% | does not trigger |

CI per OS (informational). These were not measured for this build: this run made no network calls, and the CI logs live on GitHub. The rows below are the reference numbers from research (2026-10-14, CI run 38637057034, `bench --runs 10`, official setup-node binaries on shared runners, a build from before Phases 5 to 10 finished):

| OS / Node | `node -e 0` | warm | warm, compile cache off | hook | overhead | boot ratio |
|-----------|------------:|-----:|------------------------:|-----:|---------:|-----------:|
| ubuntu / 20.20.2 | 22.6 | 121.3 | 120.1 | 41.6 | 98.7 | 19% |
| ubuntu / 26.11.1 | 20.3 | 97.2 | 104.1 | 33.7 | 76.9 | 21% |
| macOS / 20.20.2 | 34.4 | 153.7 | 169.3 | 52.2 | 119.3 | 22% |
| macOS / 26.11.1 | 37.6 | 140.2 | 149.5 | 50.1 | 102.6 | 27% |
| Windows / 20.20.2 | 54.0 | 286.3 | 285.7 | 81.6 | 232.2 | 19% |
| Windows / 26.11.1 | 51.7 | 264.1 | 268.0 | 66.3 | 212.3 | 20% |

To refresh them (read-only):

```sh
gh run list --workflow ci.yml --branch main --limit 10 --json databaseId,conclusion,createdAt
gh run view <run> --json jobs
gh run view --job <id> --log | grep -o '{"schema":1.*}' | tail -1
```

Windows is documented from CI only, because it cannot be measured on this machine. Its ccinfobar overhead (212 to 232 ms) is far above Linux CI (77 to 99 ms), while its hook row stays close to its control. So the extra cost sits in the render path. Likely causes, none of them measured: process creation for the four git spawns per render, file I/O and antivirus scanning for the transcript, limits, ledger and the atomic write of `last-payload.json`, and path resolution.

### Where the time goes

`scripts/startup-probe.mjs --rounds 2 --iterations 30 --onefile`, medians in ms (round medians within 1 ms of each other):

| Variant | distro v22.23.1 | official v22.17.1 | official v24.21.0 |
|---------|----------------:|------------------:|------------------:|
| `node -e 0` | 65.2 | 16.0 | 20.0 |
| empty `.mjs` | 68.2 | 19.2 | 20.3 |
| import the cli chunk, no render | 103.1 | 42.0 | 44.0 |
| render, non-git cwd | 117.8 | 51.5 | 54.5 |
| render, git cwd | 126.0 | 58.8 | 61.7 |
| render, compile cache off | 135.5 | 66.2 | 69.5 |
| render, one-file bundle | 177.7 | 88.8 | 92.9 |
| **ESM loader** (empty − control) | 3.1 | 3.2 | 0.3 |
| **module load** (import − empty) | 34.9 | 22.8 | 23.7 |
| **render work** (non-git render − import) | 14.7 | 9.5 | 10.6 |
| **git** (git − non-git) | 8.2 | 7.3 | 7.1 |
| **compile cache** (off − on) | 9.5 | 7.4 | 7.9 |

On official Node, loading ccinfobar's modules is the largest part (about 23 ms), then render work (about 10 ms) and git (about 7 ms). Node's boot is 16 to 20 ms. On Fedora's Node every part is slower, and the boot alone is 65 ms. Built-in modules show the same effect: `node:crypto` costs 9.8 ms on the distro build against 2.9 ms on official v22, and `node:child_process` 9.2 ms against 2.3 ms.

Git spawns from the repo root (60 interleaved runs, medians in ms, distro / official v22): `rev-parse` 1.10 / 1.09, scoped `config` 1.18 / 1.19, `status --porcelain=v2` 2.59 / 2.67, `diff --shortstat` 2.19 / 2.29. The four spawns add up to about 7.1 ms, which matches the git delta.

### Cheap levers

All measured back to back. None of them ships: nothing in `src/` changed.

| Lever | Measured delta (ms) | Ships | Why |
|-------|---------------------|:-----:|-----|
| Compile cache | bench: 9.8 / 11.3 distro, 6.0 / 7.3 official v22, 6.7 official v24 | already on | `bin.ts` has enabled it since Phase 2 |
| Import graph trim | module load 34.9 / 22.8 / 23.7; dropping `node:crypto` at most 9.8 distro, 2.9 official | no | The render loads only what it uses. `child_process` runs git. `crypto` backs the atomic write of `last-payload.json` and the sha256 names of the limits and ledger state, so removing it would rename state. On official Node it is under 3 ms even if it could go. |
| One-file bundle | 51.7 / 30.0 / 31.2 slower, identical output | no | It is a build change, and slower: without splitting, every lazy import (TUI, editor page, reports, Turkish tables) loads on each refresh |
| Merge git spawns | each spawn about 1.0 to 2.7; dropping one saves about 1.0 to 1.2 | no | No merge gives identical output: `rev-parse` decides whether there is a repo, the scoped config must run before `status` and `diff`, and those two are different commands. Running them in parallel needs async git behind the synchronous data API. |
| Cross-render git cache | at most 8.2 / 7.3 / 7.1 (probe); 6.7 (bench, git vs non-git) | no | It would show a stale branch and stale dirty and untracked counts, which changes what users see |

### Prototypes

D-04 triggered on the distro build only. The V8 snapshot was also built on official v22.17.1, to separate the gain from Fedora's missing built-in snapshot. v24.21.0 was not prototyped. The prototypes lived in a temp dir, patched a copy of `src/` there, used only tools already on the machine and were removed afterwards. Nothing in the repo, the build, CI or the release workflow changed.

**V8 startup snapshot.** A one-file CommonJS bundle of the render path (1,420,380 bytes) was built into a blob with `node --snapshot-blob <blob> --build-snapshot bundle.cjs` and run with `node --snapshot-blob <blob>` on the same payload. Timed under `nice -n -10`, interleaved with the normal render, 4 rounds of 30 per build, load average 0.12 to 0.86:

| Node | snapshot render | normal render | gain | trivial snapshot boot | `node -e 0` | blob |
|------|----------------:|--------------:|-----:|----------------------:|------------:|-----:|
| v22.23.1 distro | 65.6 | 126.5 | **60.9 (48.1%)** | 33.7 | 65.3 | 9,994,886 B |
| v22.17.1 official | 49.4 | 59.4 | **10.0 (16.8%)** | 20.0 | 15.8 | 9,896,947 B |

Times are medians in ms. The output was byte-identical to the normal render in a git repo, with `"language":"tr"` and in a non-git cwd.

How to read it: on Fedora, 31.6 ms of the 60.9 ms is Node's own boot, the built-in snapshot the distro build lacks (`node -e 0` 65.3 against 33.7 for an empty user snapshot). The other 29 ms is ccinfobar's module load. On the official build an empty user snapshot boots 4.2 ms slower than `node -e 0`, so the 10.0 ms gain there is all module load. Research (2026-10-15) estimated 15 to 30 ms for official builds; the measured value is 10.0 ms.

What the snapshot needed and broke:

- **Source changes.** The build fails on a module-level `SharedArrayBuffer` in `src/data/store.ts`. The git timeout in `src/data/git.ts` is read from the environment at module load, so a blob freezes the value it was built with. Both were patched in the temp copy only.
- **Arguments.** Node reads leading options itself: `node --snapshot-blob x.blob --version` prints Node's version. ccinfobar's arguments must follow `--`, and the entry must read `process.argv.slice(1)`.
- **Mismatch.** The blob records the exact Node version, platform and architecture (plus V8 flags and CPU features). The distro blob loaded by v22.17.1 or v24.21.0, and the v22.17.1 blob loaded by the distro Node, all exited 14 with nothing on stdout and `Failed to load the startup snapshot because it was built withNode.js version …` on stderr. The status line goes blank after any Node update, `nvm use` or distro upgrade unless a wrapper falls back.
- **Not covered.** The prototype left out the hook path and the compile cache. A real launcher also needs a blob per Node binary and per ccinfobar version, rebuilt in the cache dir, plus the fallback.
- **Stability.** Both builds warn that `node:module` and `node:child_process` are not yet fully verified in snapshot builder scripts. Research (2026-10-15, Node docs): `--snapshot-blob` is still marked experimental, and on Node 20, which ccinfobar supports, the whole snapshot API is experimental.

**Native floor.** A small C program that reads stdin and prints one fixed ANSI line (`gcc -O2`, 12,600 B) takes **1.15 ms** median (1.05 ms min), timed in the same runs. That is the lower bound for any native renderer or native client. It does not port the renderer.

**Not prototyped**, with reasons:

- **Node SEA:** still a full Node boot, at best the official build's 15.8 to 20.1 ms here. It helps Fedora only because it would ship an official Node inside.
- **Native client plus a long-lived Node daemon:** the client could come close to the 1.15 ms floor plus an IPC round trip, but it needs a daemon lifecycle (start, idle exit, crash recovery).
- **Bun `--compile` or a full rewrite:** leaves Node's built-ins and the zero-dependency package behind, and a rewrite re-implements every widget, both editors and the importers.

Building any of them needs tools this phase does not install.

### Options

Gains are against today's warm render: 126.4 ms on Fedora's Node v22.23.1 and 59.1 ms on official Node v22.17.1. "Estimate" marks a number that was not measured.

| Option | Gain | Cost | Risk |
|--------|------|------|------|
| Keep Node plus compile cache (today) | 0 (the compile cache already saves 9.8 to 11.3 ms on the distro build and 6.0 to 7.3 ms on official v22) | None | None new. Fedora users keep paying 65 ms of Node boot. |
| V8 snapshot launcher | 60.9 ms on distro v22.23.1; 10.0 ms (16.8%) on official v22.17.1; not measured on v24 | A ~10 MB blob per exact Node binary and ccinfobar version, rebuilt in the cache dir; a new launcher in the `statusLine` command (`node --snapshot-blob <blob> -- …`) and in hook commands; two source changes; a fallback when the blob does not match | A mismatch exits 14 and blanks the status line after any Node update; experimental on Node 20 and `--snapshot-blob` still experimental; Windows quoting of the longer command; built-in modules not fully verified in snapshots |
| Windows profiling, then an opt-in cross-render git cache | Linux: at most 7.1 to 8.2 ms (git share). Windows: unknown, estimate larger, since its overhead is 212 to 232 ms on CI against 77 to 99 ms on Linux CI (research, 2026-10-14) | A Windows machine to profile on; a cache with a short lifetime and a new opt-in option | The cache shows stale branch, dirty and untracked counts, so it must stay opt-in; profiling may point somewhere else than git |
| Node SEA | Estimate: none on official Node (still a Node boot of 15.8 to 20.1 ms); on Fedora up to about 49 ms (`node -e 0` 65.3 against 15.8 ms), only because it ships an official Node | An 80 to 120 MB binary per OS and architecture (estimate) and a build job for each | Per-platform artifacts, macOS signing and notarization, Windows SmartScreen, a running `.exe` cannot be overwritten, a split update path (npm and binary) |
| Native client plus Node daemon | Estimate: close to the 1.15 ms floor plus an IPC round trip | A native client per platform, a daemon with start, idle exit and crash recovery, Windows named pipes | Stale code after an update until the daemon restarts; per-platform artifacts, signing and notarization, SmartScreen, a running `.exe` cannot be overwritten, a split update path |
| Bun `--compile` or a rewrite | Estimate: bounded by the 1.15 ms floor for a native rewrite; a Bun binary was not measured | About 60 MB Bun binaries (estimate) and a new toolchain; a rewrite re-implements every widget, both editors and the importers | Drops the zero-dependency Node package; per-platform artifacts, signing and notarization, SmartScreen, a running `.exe` cannot be overwritten, a split update path |

### Recommendation

Keep Node plus the compile cache. Add no new build or release channel.

- On official Node builds the boot is 26.8% (v22.17.1) and 32.8% (v24.21.0) of a warm render, below the 50% bar. Most of the time is ccinfobar's own module load, render work and git.
- The large gain shows up only on Fedora's Node v22.23.1, and it comes mostly from Node's missing built-in snapshot, not from ccinfobar. The same machine renders in 59.1 ms with an official Node v22.17.1 against 126.4 ms with Fedora's package. Users on such a build gain more by installing an official Node build than any launcher would give them.
- The snapshot saves 10.0 ms on official Node v22.17.1, and the price is a blank status line after every Node update unless a new launcher with a fallback ships.
- The largest unexplained cost is Windows, measured only on CI. Profiling it on a Windows machine is the cheapest next step if startup matters more later.

Numbers by build: the bench, probe and snapshot numbers come from Fedora's Node v22.23.1, official Node v22.17.1 and official Node v24.21.0 (bench and probe only) on this machine. The CI rows are research numbers from official setup-node builds of Node 20.20.2 and 26.11.1 on an older build.

## Owner decision needed (F2)

> **Owner decision needed (F2)**
>
> This is the owner's decision. The executor did not pick an option, and nothing was built. Options, against a warm render of 126.4 ms on Fedora's Node v22.23.1 and 59.1 ms on official Node v22.17.1:
>
> - **A. Keep Node plus compile cache (recommended).** Gain 0 ms; no cost and no new risk.
> - **B. V8 snapshot launcher.** Gain 60.9 ms on Fedora's Node, 10.0 ms (16.8%) on official Node. Cost: a ~10 MB blob per Node binary, a new launcher command, and a blank status line (exit 14) after a Node update unless a fallback catches it.
> - **C. Windows profiling, then an opt-in git cache.** Gain at most 7.1 to 8.2 ms on Linux; Windows unmeasured (CI overhead 212 to 232 ms). Cost: a Windows machine to profile on; stale git data while cached.
> - **D. Node SEA.** Gain estimate: none on official Node. Cost: 80 to 120 MB binaries per platform, signing, notarization, SmartScreen, a split update path.
> - **E. Native client plus Node daemon.** Gain estimate: close to the 1.15 ms floor. Cost: native builds per platform, a daemon lifecycle, stale code after updates.
> - **F. Bun `--compile` or a rewrite.** Gain estimate: bounded by the 1.15 ms floor. Cost: about 60 MB binaries, a new toolchain, re-implementing everything.
>
> Until you decide, nothing is built or released.
