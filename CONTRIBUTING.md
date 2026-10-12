# Contributing

Thanks for helping out. Bug reports, widget ideas and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Widget requests are easiest to act on when they say where the data comes from (Claude Code payload field, transcript, git, a GSD file, an external command).

## Workflow

1. Fork and create a branch: `git checkout -b feat/my-widget`
2. `npm install`
3. Make your change. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) explains the layout and how to add a widget.
4. `npm run check` must pass.
5. If you touched widgets, run `npm run docs` and commit the generated files.
6. Add an entry under `Unreleased` in `CHANGELOG.md`.
7. Open a pull request describing what changed and why.

## Code style

- TypeScript, strict mode, ESM, no runtime dependencies.
- Biome handles formatting and linting (`npm run lint:fix`).
- Keep comments rare and short; prefer clear names.
- Everything must work on Linux, macOS and Windows: use `node:path`, avoid shell strings, give child processes short timeouts.
- The status line runs on every refresh, so keep the render path fast and never let a widget throw.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) are preferred: `feat(gsd): add requirements widget`, `fix(git): handle detached HEAD`.

## Code of conduct

Be kind and constructive. Harassment or personal attacks are not tolerated; maintainers may remove comments or contributors that cross that line.
