import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
];
const EXCLUDED_DIRS = ['src/importers/', 'src/editor/', 'src/tui/'];

// later plans extend this
const PURE = [
  'src/core/sanitize.ts',
  'src/core/payload.ts',
  'src/core/json-locate.ts',
  'src/core/config-path.ts',
  'src/core/i18n/',
  'src/core/scenarios.ts',
  'src/core/trace.ts',
  'src/core/time.ts',
  'src/core/cache-rule.ts',
  'src/core/job-values.ts',
  'src/core/profiles.ts',
  'src/core/jsonpath.ts',
  'src/core/http-spec.ts',
  'src/data/live.ts',
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
        (f) => EXCLUDED_FILES.includes(f) || EXCLUDED_DIRS.some((d) => f.startsWith(d)),
      );
      expect(bad).toEqual([]);
    });
  }

  it('keeps cli/hook.ts minimal', () => {
    const allowed = new Set([
      'src/cli/hook.ts',
      'src/cli/args.ts',
      'src/data/hook-line.ts',
      'src/data/store.ts',
      'src/core/builtins.ts',
      'src/core/paths.ts',
      'src/core/sanitize.ts',
    ]);
    const files = closure('cli/hook.ts');
    expect(files.has('src/cli/hook.ts')).toBe(true);
    expect([...files].filter((f) => !allowed.has(f))).toEqual([]);
  });

  // the hook lazy-loads update-state; it must not reach the registry, config or widgets
  it('keeps the update-state.ts closure to the update job', () => {
    const allowed = new Set([
      'src/data/update-state.ts',
      'src/data/jobs/runner.ts',
      'src/data/jobs/update.ts',
      'src/data/store.ts',
      'src/core/builtins.ts',
      'src/core/paths.ts',
      'src/core/sanitize.ts',
    ]);
    const files = closure('data/update-state.ts');
    expect(files.has('src/data/jobs/update.ts')).toBe(true);
    expect([...files].filter((f) => !allowed.has(f))).toEqual([]);
    const lazy = fs.readFileSync(path.join(src, 'data/jobs/update.ts'), 'utf8');
    expect(lazy).toContain("await import('../../commands/update.js')");
  });

  // node:crypto, a static node:fs ESM import and the stdin stream each cost ms per event
  it('keeps crypto, static node:fs and process.stdin out of the hook path', () => {
    for (const f of [...closure('cli/hook.ts'), 'src/cli/silence.ts']) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      expect(text, f).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'node:crypto'|process\.stdin\b/m);
      expect(text, f).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'node:fs'/m);
    }
    const bin = fs.readFileSync(path.join(src, 'bin.ts'), 'utf8');
    expect(bin).toMatch(/import \{ silence \} from '\.\/cli\/silence\.js'/);
    expect(fs.readFileSync(path.join(src, 'cli/silence.ts'), 'utf8')).not.toMatch(/^import /m);
  });

  const dist = path.join(root, 'dist');
  it.skipIf(!fs.existsSync(path.join(dist, 'ccinfobar.js')))(
    'built hook chunk loads no crypto or stdin',
    () => {
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
    },
  );

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
    ]) {
      expect(text).toContain(`await import('../commands/${mod}.js')`);
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

  it('keeps src/core/inspect.ts free of node: imports', () => {
    const text = fs.readFileSync(path.join(root, 'src/core/inspect.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"]node:|require\(/);
  });
});
