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
  'src/commands/command.ts',
  'src/commands/settings-file.ts',
  'src/commands/manifest.ts',
  'src/commands/hooks-install.ts',
  'src/commands/config-cmd.ts',
  'src/core/scenarios.ts',
  'src/commands/explain.ts',
  'src/core/inspect.ts',
  'src/core/trace.ts',
  'src/commands/bench.ts',
  'src/commands/io.ts',
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
      'src/data/hooks.ts',
      'src/data/store.ts',
      'src/core/paths.ts',
      'src/core/sanitize.ts',
    ]);
    const files = closure('cli/hook.ts');
    expect(files.has('src/cli/hook.ts')).toBe(true);
    expect([...files].filter((f) => !allowed.has(f))).toEqual([]);
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
    for (const mod of ['install-cli', 'manage', 'update', 'doctor', 'config-cmd', 'explain', 'bench']) {
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
