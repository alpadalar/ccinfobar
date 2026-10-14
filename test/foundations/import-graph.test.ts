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
  'src/commands/config-cmd.ts',
];
const EXCLUDED_DIRS = ['src/importers/', 'src/editor/', 'src/tui/'];

// later plans extend this
const PURE = ['src/core/sanitize.ts', 'src/core/payload.ts', 'src/core/i18n/'];

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

  it('loads every command lazily from main', () => {
    const text = fs.readFileSync(path.join(src, 'cli/main.ts'), 'utf8');
    for (const mod of ['install-cli', 'manage', 'update', 'doctor']) {
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
});
