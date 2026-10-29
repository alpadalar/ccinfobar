import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const IMG = /docs\/images\/[\w./-]+\.(?:png|webp|gif|svg|jpg)/g;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');
const files = walk(path.join(root, 'docs', 'images')).map(rel);

function referenced(): Set<string> {
  const sources = [
    path.join(root, 'README.md'),
    ...fs
      .readdirSync(path.join(root, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(root, 'docs', f)),
    ...fs
      .readdirSync(path.join(root, 'scripts'))
      .filter((f) => fs.statSync(path.join(root, 'scripts', f)).isFile())
      .map((f) => path.join(root, 'scripts', f)),
    path.join(root, 'test', 'editor', 'brand.test.ts'),
  ];
  const out = new Set<string>();
  for (const s of sources) {
    for (const m of fs.readFileSync(s, 'utf8').matchAll(IMG)) out.add(m[0]);
  }
  return out;
}

describe('docs/images', () => {
  const refs = referenced();

  it('every referenced image exists', () => {
    for (const r of refs) expect(files, r).toContain(r);
  });

  it('every file is referenced or the WebP twin of a referenced PNG', () => {
    for (const f of files) {
      const twinOf = f.endsWith('.webp') ? f.replace(/\.webp$/, '.png') : '';
      expect(refs.has(f) || (twinOf !== '' && refs.has(twinOf)), f).toBe(true);
    }
  });

  it('every screenshot and the dashboard PNG has its WebP twin', () => {
    const pngs = files.filter((f) => /^docs\/images\/(screenshots\/[^/]+|dashboard)\.png$/.test(f));
    expect(pngs.length).toBeGreaterThan(0);
    for (const p of pngs) expect(files, p).toContain(p.replace(/\.png$/, '.webp'));
  });
});
