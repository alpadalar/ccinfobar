import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../../src/core/i18n/en/index.js';
import { renderMessages } from '../../src/core/i18n/en/render.js';
import { samplePayload } from '../../src/core/sample.js';

const root = path.resolve(__dirname, '../..');
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm;
const ID_RE = /'([a-z]+(?:\.[a-zA-Z0-9_-]+)+)'/g;

function resolve(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base.replace(/\.js$/, '.ts'), base, path.join(base.replace(/\.js$/, ''), 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function closure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [path.join(root, 'src', entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const next = resolve(file, m[1]!);
      if (next) stack.push(next);
    }
  }
  return [...seen];
}

const render = new Set(Object.keys(renderMessages));
const full = new Set(Object.keys(en));

describe('render table (19-D-01)', () => {
  it('holds every English id the render closure names', () => {
    const missing: string[] = [];
    for (const file of closure('cli/main.ts')) {
      if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
      for (const m of fs.readFileSync(file, 'utf8').matchAll(ID_RE)) {
        const id = m[1]!;
        if (full.has(id) && !render.has(id)) missing.push(`${path.relative(root, file)}: ${id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('holds the ids built from a prefix', () => {
    for (const prefix of ['rule.error.', 'fun.quip.', 'widget.gsd.status.', 'widget.status.level.']) {
      const ids = [...full].filter((id) => id.startsWith(prefix));
      expect(ids.length, prefix).toBeGreaterThan(0);
      expect(
        ids.filter((id) => !render.has(id)),
        prefix,
      ).toEqual([]);
    }
  });

  it('leaves the help text to the UI table', () => {
    expect([...render].filter((id) => id.startsWith('help.'))).toEqual([]);
    expect(full.has('help.tagline')).toBe(true);
  });

  it('renders the sample and an invalid payload with no raw id on a fresh module graph', async () => {
    vi.resetModules();
    const langs = await import('../../src/core/i18n/languages.js');
    expect(Object.keys(langs.EN.messages).sort()).toEqual([...render].sort());
    const { runRender } = await import('../../src/cli/render.js');
    const { parseArgs } = await import('../../src/cli/args.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-split-'));
    const good = path.join(dir, 'payload.json');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(good, JSON.stringify(samplePayload()));
    fs.writeFileSync(bad, 'garbage');
    const chunks: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      chunks.push(String(s));
      return true;
    });
    try {
      const cfg = path.join(dir, 'config.json');
      await runRender(parseArgs(['--payload', good, '--width', '120']), cfg);
      await runRender(parseArgs(['--payload', bad]), cfg);
    } finally {
      out.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const text = chunks.join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('invalid JSON on stdin');
    expect(Object.keys(en).filter((id) => text.includes(id))).toEqual([]);
  });
});
