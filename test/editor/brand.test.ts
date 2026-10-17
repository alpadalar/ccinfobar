import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('src/editor/web/index.html');
const css = read('src/editor/web/style.css');

const SHAPES = [
  /<circle[^>]*cx="15" cy="20" r="3.5"/,
  /<rect[^>]*x="22" y="17" width="20" height="6" rx="3"[^>]*opacity="0.7"/,
  /<rect[^>]*x="10" y="29" width="44" height="10" rx="5"[^>]*opacity="0.22"/,
  /<rect[^>]*x="10" y="29" width="30" height="10" rx="5"/,
  /<rect[^>]*x="10" y="45" width="24" height="5" rx="2.5"[^>]*opacity="0.45"/,
];

describe('editor brand mark', () => {
  const brand = html.match(/<div class="brand">([\s\S]*?)<\/div>/)?.[1] ?? '';

  it('draws the gauge inline in the top bar', () => {
    expect(brand).toMatch(/<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"/);
    expect(brand).not.toContain('<i>');
    expect(brand).not.toMatch(/<title|<text/);
    expect(brand).toMatch(/<rect class="logo-tile" width="64" height="64" rx="16"/);
    for (const shape of SHAPES) expect(brand).toMatch(shape);
    expect(brand.match(/class="logo-ink"/g)).toHaveLength(5);
  });

  it('uses the dark gauge as favicon', () => {
    const icon = html.match(/<link rel="icon" href="([^"]+)"/)?.[1] ?? '';
    expect(icon.startsWith('data:image/svg+xml,')).toBe(true);
    expect(icon).toContain("viewBox='0 0 64 64'");
    expect(icon).toMatch(/%23131317/i);
    expect(icon).toMatch(/%23e8895a/i);
    expect(icon).toContain("cx='15' cy='20' r='3.5'");
  });

  it('colors the mark from theme tokens', () => {
    expect(css).not.toMatch(/\.logo i/);
    expect(css).toMatch(/\.logo-tile\s*\{[^}]*fill: var\(--surface-3\)/);
    expect(css).toMatch(/\.logo-ink\s*\{[^}]*fill: var\(--accent\)/);
  });
});

describe('logo files', () => {
  for (const [file, tile, ink] of [
    ['docs/images/logo-dark.svg', '#131317', '#E8895A'],
    ['docs/images/logo-light.svg', '#FFFFFF', '#C8582A'],
  ] as const) {
    it(file, () => {
      const svg = read(file);
      expect(svg).toContain('role="img"');
      expect(svg).toContain('<title id="t">ccinfobar</title>');
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg).toContain(`fill="${tile}"`);
      expect(svg).toContain(`fill="${ink}"`);
      for (const shape of SHAPES) expect(svg).toMatch(shape);
    });
  }
});
