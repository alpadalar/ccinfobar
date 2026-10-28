import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipDist } from '../dist.js';

const root = path.resolve(__dirname, '../..');
const src = path.join(root, 'src');
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm;

function resolve(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base.replace(/\.js$/, '.ts'), base, path.join(base.replace(/\.js$/, ''), 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [path.join(src, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const next = resolve(file, m[1]!);
      expect(next, `${path.relative(root, file)} imports missing ${m[1]}`).not.toBeNull();
      if (next) stack.push(next);
    }
  }
  return new Set([...seen].map((f) => path.relative(root, f).replace(/\\/g, '/')));
}

const EXCLUDED_FILES = [
  'src/commands/install.ts',
  'src/commands/install-cli.ts',
  'src/commands/manage.ts',
  'src/commands/doctor.ts',
  'src/commands/update.ts',
  'src/commands/repos.ts',
  'src/commands/command.ts',
  'src/commands/settings-file.ts',
  'src/commands/manifest.ts',
  'src/commands/hooks-install.ts',
  'src/commands/hooks-doctor.ts',
  'src/commands/config-cmd.ts',
  'src/core/scenarios.ts',
  'src/commands/explain.ts',
  'src/core/inspect.ts',
  'src/core/trace.ts',
  'src/commands/bench.ts',
  'src/commands/io.ts',
  'src/commands/worker.ts',
  'src/core/i18n/bundled.ts',
  'src/data/report-index.ts',
  'src/core/report-format.ts',
  'src/commands/report.ts',
  'src/commands/catalog.ts',
  'src/core/report-model.ts',
  'src/core/report-types.ts',
];
const REPORT_FILES = EXCLUDED_FILES.filter((f) => /\/report/.test(f));
// report, import and TOML text load with the commands that print it (D-33)
const LAZY_TABLES = [
  'src/core/i18n/lazy.ts',
  'src/core/i18n/en/lazy.ts',
  'src/core/i18n/en/report.ts',
  'src/core/i18n/en/import.ts',
  'src/core/i18n/en/toml.ts',
  'src/core/i18n/en/catalog.ts',
];
const EXCLUDED_DIRS = ['src/importers/', 'src/editor/', 'src/tui/', 'src/catalog/', 'src/market/'];
// non-English tables load with import() (D-25)
const LANG_TABLES = /^src\/core\/i18n\/(?!en\/)[a-z]{2,3}\//;

// later plans extend this
const PURE = [
  'src/core/ids.ts',
  'src/core/sanitize.ts',
  'src/core/share-code.ts',
  'src/core/payload.ts',
  'src/core/json-locate.ts',
  'src/core/config-path.ts',
  'src/core/i18n/',
  'src/core/scenarios.ts',
  'src/core/trace.ts',
  'src/core/time.ts',
  'src/widgets/subagent-row.ts',
  'src/core/cache-rule.ts',
  'src/core/job-values.ts',
  'src/core/profiles.ts',
  'src/core/prices.ts',
  'src/core/report-types.ts',
  'src/core/report-model.ts',
  'src/core/report-format.ts',
  'src/importers/toml.ts',
  'src/importers/colors.ts',
  'src/importers/ccometixline-themes.ts',
  'src/core/jsonpath.ts',
  'src/core/http-spec.ts',
  'src/core/http-report.ts',
  'src/core/eaw-table.ts',
  'src/core/width.ts',
  'src/core/conditions.ts',
  'src/core/glyphs.ts',
  'src/core/display-opts.ts',
  'src/core/themes/builtin.ts',
  'src/core/themes/style.ts',
  'src/data/live.ts',
  'src/catalog/model.ts',
  'src/market/protocol.ts',
  'src/core/entry-keys.ts',
  'src/market/rules.ts',
  'src/market/github.ts',
  'src/market/worker/',
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

describe('import graph', () => {
  for (const entry of ['cli/render.ts', 'cli/main.ts']) {
    it(`keeps non-render modules out of src/${entry}`, () => {
      const files = closure(entry);
      expect(files.has(`src/${entry}`)).toBe(true);
      const bad = [...files].filter(
        (f) =>
          EXCLUDED_FILES.includes(f) ||
          LAZY_TABLES.includes(f) ||
          EXCLUDED_DIRS.some((d) => f.startsWith(d)) ||
          LANG_TABLES.test(f),
      );
      expect(bad).toEqual([]);
    });
  }

  it('keeps cli/hook.ts minimal', () => {
    const allowed = new Set([
      'src/cli/hook.ts',
      'src/cli/args.ts',
      'src/data/hook-line.ts',
      'src/data/progress.ts',
      'src/data/store.ts',
      'src/core/builtins.ts',
      'src/core/paths.ts',
      'src/core/sanitize.ts',
    ]);
    const files = closure('cli/hook.ts');
    expect(files.has('src/cli/hook.ts')).toBe(true);
    expect([...files].filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('keeps cli/subagent-line.ts chunk-neutral', () => {
    const files = closure('cli/subagent-line.ts');
    const allowed = new Set([
      ...closure('widgets/shared.ts'),
      ...closure('cli/args.ts'),
      ...closure('data/store.ts'),
      ...closure('core/payload.ts'),
      ...closure('core/paths.ts'),
      ...closure('core/ansi.ts'),
      ...closure('core/width.ts'),
      'src/cli/subagent-line.ts',
      'src/widgets/subagent-row.ts',
    ]);
    expect([...files].filter((f) => !allowed.has(f))).toEqual([]);
    for (const f of [
      'src/cli/hook.ts',
      'src/cli/render.ts',
      'src/cli/lang.ts',
      'src/core/config.ts',
      'src/widgets/agents.ts',
      'src/widgets/index.ts',
      'src/data/transcript.ts',
      'src/data/agents.ts',
      'src/data/cache.ts',
    ])
      expect(files.has(f)).toBe(false);
  });

  it('keeps report and importer code out of cli/hook.ts', () => {
    expect(REPORT_FILES.length).toBe(5);
    const files = [...closure('cli/hook.ts')];
    expect(files.filter((f) => REPORT_FILES.includes(f) || f.startsWith('src/importers/'))).toEqual([]);
  });

  // a lazy import-help entry split the render chunks; import help loads through manage
  it('loads import help through the manage entry only', () => {
    const lazy = walk(src).filter((f) =>
      /import\('[./]+(?:commands\/)?(?:import-help|importers\/[^']+)\.js'\)/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(lazy.map((f) => path.relative(root, f))).toEqual([]);
    expect(fs.readFileSync(path.join(src, 'cli/main.ts'), 'utf8')).toContain(
      "(await import('../commands/manage.js')).importHelp()",
    );
  });

  // a lazy entry that reaches part of a render chunk makes esbuild split it (D-33)
  it('hands report code its config, language, ledger, limits, profile and price helpers from main', () => {
    const files = closure('commands/report.ts');
    expect(files.has('src/data/report-index.ts')).toBe(true);
    const handed = [
      'src/core/config.ts',
      'src/cli/lang.ts',
      'src/data/ledger.ts',
      'src/data/limits.ts',
      'src/core/profiles.ts',
      'src/core/prices.ts',
    ];
    expect([...files].filter((f) => handed.includes(f))).toEqual([]);
    expect(fs.readFileSync(path.join(src, 'cli/main.ts'), 'utf8')).toContain(
      'runReport(args, cfgFile, reportDeps())',
    );
  });

  // a lazy client or publish entry splits the render chunks; catalog-market is the one entry
  it('loads marketplace code through the catalog-market entry only', () => {
    const files = closure('commands/catalog-market.ts');
    expect(files.has('src/commands/catalog.ts')).toBe(true);
    expect(files.has('src/market/client.ts')).toBe(true);
    expect(closure('commands/catalog.ts').has('src/catalog/publish.ts')).toBe(false);
    for (const f of ['src/market/github.ts', 'src/catalog/signin.ts', 'src/catalog/login-flows.ts']) {
      expect(files.has(f), f).toBe(true);
      expect(closure('commands/catalog.ts').has(f), f).toBe(false);
      expect(closure('editor/server.ts').has(f), f).toBe(false);
    }
    // moderation loads from catalog-market only when asked for
    expect(files.has('src/commands/catalog-admin.ts')).toBe(false);
    expect(closure('commands/catalog.ts').has('src/commands/catalog-admin.ts')).toBe(false);
    expect(closure('editor/server.ts').has('src/commands/catalog-admin.ts')).toBe(false);
    expect(fs.readFileSync(path.join(src, 'commands/catalog-market.ts'), 'utf8')).toContain(
      "await import('./catalog-admin.js')",
    );
    const admin = walk(src).filter((f) =>
      /import\('[./]+(?:commands\/)?catalog-admin\.js'\)/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(admin.map((f) => path.relative(root, f).replace(/\\/g, '/'))).toEqual([
      'src/commands/catalog-market.ts',
    ]);
    expect([...closure('commands/open.ts')].filter((f) => f.startsWith('src/editor/'))).toEqual([]);
    const lazy = walk(src).filter((f) =>
      /import\('[./]+(?:market\/client|catalog\/publish)\.js'\)/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(lazy.map((f) => path.relative(root, f))).toEqual([]);
    expect(fs.readFileSync(path.join(src, 'commands/catalog.ts'), 'utf8')).toContain(
      "await import('./catalog-market.js')",
    );
    expect(closure('editor/server.ts').has('src/catalog/publish.ts')).toBe(false);
    expect(fs.readFileSync(path.join(src, 'editor/server.ts'), 'utf8')).toContain(
      "import('../commands/catalog-market.js')",
    );
  });

  it('loads the lazy tables in every module that prints their ids', () => {
    const users = walk(src)
      .filter((f) => !f.includes(`${path.sep}i18n${path.sep}`))
      .filter((f) => /['`](?:report|import|toml|catalog|market)\.[a-zA-Z]/.test(fs.readFileSync(f, 'utf8')));
    expect(users.length).toBeGreaterThan(5);
    for (const f of users) {
      expect(fs.readFileSync(f, 'utf8'), path.relative(root, f)).toMatch(
        /^import '[./]+(?:core\/)?i18n\/lazy\.js';$/m,
      );
    }
  });

  // the hook lazy-loads update-state; it must not reach the registry, config or widgets
  it('keeps the update-state.ts closure to the update job', () => {
    const allowed = new Set([
      'src/data/update-state.ts',
      'src/data/jobs/runner.ts',
      'src/data/jobs/update.ts',
      'src/data/store.ts',
      'src/core/brew.ts',
      'src/core/builtins.ts',
      'src/core/paths.ts',
      'src/core/sanitize.ts',
    ]);
    const files = closure('data/update-state.ts');
    expect(files.has('src/data/jobs/update.ts')).toBe(true);
    expect([...files].filter((f) => !allowed.has(f))).toEqual([]);
    const lazy = fs.readFileSync(path.join(src, 'data/jobs/update.ts'), 'utf8');
    expect(lazy).toContain("await import('../self-update.js')");
  });

  // D-02: data never reaches up into commands, not even with import()
  it('keeps src/data free of command imports', () => {
    const files = walk(path.join(src, 'data')).filter((f) =>
      /from '[./]+commands\/|import\('[./]+commands\//.test(fs.readFileSync(f, 'utf8')),
    );
    expect(files.map((f) => path.relative(root, f))).toEqual([]);
  });

  // D-09: publishing is never a background job
  it('never imports the marketplace or catalog from background jobs', () => {
    const files = walk(path.join(src, 'data/jobs')).filter((f) =>
      /from '[./]+(?:\.\.\/)*(?:market|catalog)\/|import\('[./]+(?:market|catalog)\//.test(
        fs.readFileSync(f, 'utf8'),
      ),
    );
    expect(files.map((f) => path.relative(root, f))).toEqual([]);
  });

  // fetch, exec and json path code load only in the worker; each extra chunk costs about 0.3 ms
  it('keeps worker code out of the render and the registry in the cli chunk', () => {
    const files = closure('cli/render.ts');
    expect(files.has('src/data/jobs/index.ts')).toBe(true);
    const bad = [...files].filter(
      (f) =>
        /^src\/(data\/jobs\/(fetch|gh-exec)|core\/(jsonpath|http-report))\.ts$/.test(f) ||
        f.startsWith('src/commands/'),
    );
    expect(bad).toEqual([]);
    const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
    const users = walk(src)
      .map((f) => path.relative(root, f).replace(/\\/g, '/'))
      .filter((f) =>
        /from '[./]+(data\/)?jobs\/index\.js'|import\('[./]+(data\/)?jobs\/index\.js'\)/.test(read(f)),
      );
    expect(users.sort()).toEqual(['src/cli/main.ts', 'src/cli/render.ts']);
    expect(read('src/data/jobs/http.ts')).toContain("await import('./fetch.js')");
    expect(read('src/data/jobs/http.ts')).toContain("await import('../../core/jsonpath.js')");
    expect(read('src/data/jobs/status.ts')).toContain("await import('./fetch.js')");
    expect(read('src/data/jobs/gh.ts')).toContain("await import('./gh-exec.js')");
    expect(read('src/data/jobs/command.ts')).toContain("await import('./gh-exec.js')");
    expect(read('src/data/jobs/command.ts')).not.toMatch(
      /^import[^;]*from\s+'(node:child_process|\.\/gh-exec\.js)'/m,
    );
    for (const f of ['data/jobs/fetch.ts', 'data/jobs/gh-exec.ts']) {
      expect(read(`src/${f}`), f).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'\./m);
      expect(closure(f)).toEqual(new Set([`src/${f}`]));
    }
  });

  // node:crypto, a static node:fs ESM import and the stdin stream each cost ms per event
  it('keeps crypto, static node:fs and process.stdin out of the hook path', () => {
    for (const f of [
      ...closure('cli/hook.ts'),
      'src/cli/silence.ts',
      'src/cli/win-env.ts',
      'src/cli/retry.ts',
    ]) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      expect(text, f).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'node:crypto'|process\.stdin\b/m);
      expect(text, f).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'node:fs'/m);
    }
    const bin = fs.readFileSync(path.join(src, 'bin.ts'), 'utf8');
    expect(bin).toMatch(/import \{ silence \} from '\.\/cli\/silence\.js'/);
    expect(bin).toMatch(/import \{ noCwdLookup \} from '\.\/cli\/win-env\.js'/);
    expect(fs.readFileSync(path.join(src, 'cli/silence.ts'), 'utf8')).not.toMatch(/^import /m);
    expect(fs.readFileSync(path.join(src, 'cli/win-env.ts'), 'utf8')).not.toMatch(/^import /m);
    expect(fs.readFileSync(path.join(src, 'cli/retry.ts'), 'utf8')).not.toMatch(/^import /m);
    expect(bin).toContain("retryOnce(() => import('./cli.js'))");
    expect(bin.indexOf('noCwdLookup(process.env, process.platform)')).toBeLessThan(
      bin.indexOf('const isHook'),
    );
  });

  const dist = path.join(root, 'dist');
  it.skipIf(skipDist)('built hook chunk loads no crypto or stdin', () => {
    const entry = fs.readFileSync(path.join(dist, 'ccinfobar.js'), 'utf8');
    const hook = /import\("\.\/chunks\/(hook-[^"]+\.js)"\)/.exec(entry)?.[1];
    expect(hook).toBeTruthy();
    expect(entry).not.toMatch(/^import\s[^;]*from\s+"\.\/chunks\//m);
    const seen = new Set<string>();
    const stack = [hook!];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const text = fs.readFileSync(path.join(dist, 'chunks', f), 'utf8');
      expect(text, f).not.toMatch(/from "node:(?:crypto|fs)"|process\.stdin\b/);
      for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+"\.\/([^"]+)"/gm)) stack.push(m[1]!);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  // D-33: the render and hook chunks never carry report or TOML code
  it.skipIf(skipDist)('built render and hook chunks carry no report or TOML code', () => {
    const entry = fs.readFileSync(path.join(dist, 'ccinfobar.js'), 'utf8');
    const roots = [...entry.matchAll(/import\("\.\/chunks\/((?:cli|hook)-[^"]+\.js)"\)/g)].map((m) => m[1]!);
    expect(roots).toHaveLength(2);
    expect(entry).not.toMatch(/TomlError|report-index|Scanning transcripts|This layout runs commands/);
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const text = fs.readFileSync(path.join(dist, 'chunks', f), 'utf8');
      expect(text, f).not.toMatch(/TomlError|report-index|Scanning transcripts|This layout runs commands/);
      for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+"\.\/([^"]+)"/gm)) stack.push(m[1]!);
    }
    expect(seen.size).toBeGreaterThan(2);
    const lazy = fs
      .readdirSync(path.join(dist, 'chunks'))
      .filter((f) => /TomlError|report-index/.test(fs.readFileSync(path.join(dist, 'chunks', f), 'utf8')));
    expect(lazy.length).toBeGreaterThan(0);
  });

  // D-28: catalog and marketplace code never loads on a refresh
  it.skipIf(skipDist)('built render and hook chunks carry no catalog or marketplace code', () => {
    const entry = fs.readFileSync(path.join(dist, 'ccinfobar.js'), 'utf8');
    const roots = [...entry.matchAll(/import\("\.\/chunks\/((?:cli|hook)-[^"]+\.js)"\)/g)].map((m) => m[1]!);
    expect(roots).toHaveLength(2);
    const marker = /catppuccin-cockpit|ccinfobar-market|\/v1\/index\.json|Waiting to publish/;
    expect(entry).not.toMatch(marker);
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const text = fs.readFileSync(path.join(dist, 'chunks', f), 'utf8');
      expect(text, f).not.toMatch(marker);
      for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+"\.\/([^"]+)"/gm)) stack.push(m[1]!);
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  it('dispatches hook mode from bin before loading cli.js', () => {
    const text = fs.readFileSync(path.join(src, 'bin.ts'), 'utf8');
    expect(text).not.toMatch(/^\s*import\s[^(]*from\s+'\.\/cli\.js'/m);
    const hook = text.indexOf("import('./cli/hook.js')");
    expect(hook).toBeGreaterThan(0);
    expect(hook).toBeLessThan(text.indexOf("import('./cli.js')"));
    expect(fs.readFileSync(path.join(src, 'cli/main.ts'), 'utf8')).toContain("await import('./hook.js')");
  });

  it('loads every command lazily from main', () => {
    const text = fs.readFileSync(path.join(src, 'cli/main.ts'), 'utf8');
    for (const mod of [
      'install-cli',
      'manage',
      'update',
      'repos',
      'worker',
      'doctor',
      'config-cmd',
      'explain',
      'bench',
      'report',
      'catalog',
    ]) {
      expect(text).toContain(`await import('../commands/${mod}.js')`);
    }
  });

  // D-03: the Worker runs in workerd with Web APIs only
  it('keeps the marketplace Worker isolated from ccinfobar', () => {
    const SPEC_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)'(\.[^']+)'/gm;
    const workerDir = path.join(src, 'market', 'worker') + path.sep;
    const outside = walk(src).filter((f) => !f.startsWith(workerDir));
    expect(outside.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const f of outside) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(SPEC_RE)) {
        if (path.resolve(path.dirname(f), m[1]!).startsWith(workerDir)) bad.push(path.relative(root, f));
      }
    }
    expect(bad).toEqual([]);
    const files = closure('market/worker/index.ts');
    expect(files.has('src/market/worker/handler.ts')).toBe(true);
    const allowed = new Set([
      'src/market/protocol.ts',
      'src/market/rules.ts',
      'src/core/sanitize.ts',
      'src/core/entry-keys.ts',
    ]);
    expect([...files].filter((f) => !f.startsWith('src/market/worker/') && !allowed.has(f))).toEqual([]);
    const own = walk(workerDir).map((f) => path.relative(root, f).replace(/\\/g, '/'));
    expect(own).toContain('src/market/worker/index.ts');
    for (const f of new Set([...files, ...own])) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      expect(text, f).not.toMatch(/\bBuffer\b|process\.|require\(|__dirname|setImmediate|['"]node:/);
    }
  });

  // D-06: github.com has no CORS; only the CLI and the editor server run the device flow
  it('keeps the GitHub device flow out of the browser bundle and the Worker', () => {
    for (const entry of ['editor/web/app.ts', 'market/worker/index.ts', 'cli/render.ts', 'cli/hook.ts']) {
      expect(closure(entry).has('src/market/github.ts'), entry).toBe(false);
    }
  });

  it('keeps pure modules free of node: imports', () => {
    const files = PURE.flatMap((p) => {
      const abs = path.join(root, p);
      return p.endsWith('/') ? walk(abs) : [abs];
    });
    expect(files.length).toBeGreaterThan(2);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, path.relative(root, f)).not.toMatch(/['"]node:|require\(/);
    }
  });

  // D-28: theme data never imports the logic module
  it('keeps src/core/themes/ free of a cycle with themes.ts', () => {
    for (const f of walk(path.join(src, 'core/themes'))) {
      const specs = [...fs.readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(
        specs.every((s) => s === './style.js' || s === '../types.js'),
        path.relative(root, f),
      ).toBe(true);
    }
  });

  // D-07, D-41: string-width is never a runtime import
  it('keeps string-width out of src', () => {
    const bad = walk(src).filter((f) => fs.readFileSync(f, 'utf8').includes('string-width'));
    expect(bad.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('keeps width.ts free of env reads and the ansi module', () => {
    const text = fs.readFileSync(path.join(src, 'core/width.ts'), 'utf8');
    expect(text).not.toMatch(/process\.env|from '\.\/ansi\.js'/);
    expect(text.match(/^import .* from '[^']+';/gm)).toEqual([
      "import { AMBIGUOUS, JOIN, WIDE, ZERO } from './eaw-table.js';",
    ]);
  });

  it('keeps src/core/inspect.ts free of node: imports', () => {
    const text = fs.readFileSync(path.join(root, 'src/core/inspect.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"]node:|require\(/);
  });
});

// D-37: the English UI tables load with the commands, never with the render
describe('English table split', () => {
  const UI_TABLES = [
    ...[
      'bench',
      'commands',
      'doctor',
      'editor',
      'explain',
      'help',
      'hooks',
      'index',
      'inspector',
      'install',
      'jobs',
      'preview',
      'static',
      'theme-editor',
      'tui',
    ].map((n) => `src/core/i18n/en/${n}.ts`),
    'src/core/i18n/ui.ts',
  ];
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

  for (const entry of ['cli/render.ts', 'cli/main.ts', 'cli/hook.ts', 'cli/subagent-line.ts']) {
    it(`keeps the UI tables out of src/${entry}`, () => {
      const files = closure(entry);
      expect([...files].filter((f) => UI_TABLES.includes(f))).toEqual([]);
    });
  }

  it('wires ui.ts for commands, bundles and the index chunk', () => {
    expect(read('src/cli/main.ts')).toContain("await import('../core/i18n/ui.js')");
    expect(read('src/core/i18n/ui.ts')).toContain("from './index.js'");
    expect(read('src/core/i18n/bundled.ts')).toContain("import './ui.js'");
  });

  it.skipIf(skipDist)('built render and hook chunks carry no help or command text', () => {
    const dist = path.join(root, 'dist');
    const entry = read('dist/ccinfobar.js');
    const roots = [...entry.matchAll(/import\("\.\/chunks\/((?:cli|hook)-[^"]+\.js)"\)/g)].map((m) => m[1]!);
    expect(roots).toHaveLength(2);
    const marker = /A customizable, GSD-aware status line/;
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const text = fs.readFileSync(path.join(dist, 'chunks', f), 'utf8');
      expect(text, f).not.toMatch(marker);
      for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+"\.\/([^"]+)"/gm)) stack.push(m[1]!);
    }
    expect(seen.size).toBeGreaterThan(2);
    const lazy = fs
      .readdirSync(path.join(dist, 'chunks'))
      .filter((f) => marker.test(fs.readFileSync(path.join(dist, 'chunks', f), 'utf8')));
    expect(lazy.length).toBeGreaterThan(0);
  });
});
