import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPORT_ALIASES, IMPORT_SOURCES } from '../../src/importers/index.js';
import { importerList } from '../../src/importers/registry.js';

const read = (file: string) =>
  fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8').replace(/\r\n/g, '\n');

const readme = read('README.md');
const docs = read('docs/IMPORTERS.md');

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const command = (id: string) => new RegExp(`ccinfobar import ${esc(id)}(?![\\w-])`);
const named = (id: string) => new RegExp(`ccinfobar import ${esc(id)}(?![\\w-])|\`${esc(id)}\``);

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

describe('importer docs', () => {
  const coming = section(readme, 'Coming from another status line');

  it('name every import id in the README and docs/IMPORTERS.md', () => {
    for (const id of IMPORT_SOURCES) {
      expect(coming, id).toMatch(command(id));
      expect(docs, id).toMatch(command(id));
    }
  });

  it('name every alias in both', () => {
    const aliases = Object.keys(IMPORT_ALIASES);
    expect(aliases.length).toBeGreaterThan(0);
    for (const a of aliases) {
      expect(coming, a).toMatch(named(a));
      expect(docs, a).toMatch(named(a));
    }
  });

  it('link every importable project from the README table', () => {
    for (const info of importerList())
      expect(coming, info.repo).toContain(`https://github.com/${info.repo})`);
  });

  it('classify the 41 reviewed projects in order', () => {
    const rows = docs.split('\n').filter((l) => /^\| ([1-9]|[1-3][0-9]|4[01]) \|/.test(l));
    expect(rows.map((l) => Number(l.split('|')[1]))).toEqual(Array.from({ length: 41 }, (_, i) => i + 1));
    for (const info of importerList()) {
      const row = rows.find((l) => l.includes(`https://github.com/${info.repo})`));
      expect(row, info.repo).toBeDefined();
      expect(row, info.repo).toMatch(command(info.source));
    }
    expect(rows.filter((l) => /\| not importable \|/.test(l))).toHaveLength(18);
  });

  it('give one README row per supported tool', () => {
    const rows = coming.split('\n').filter((l) => /^\| \[/.test(l) && l.includes('`ccinfobar import '));
    expect(rows).toHaveLength(importerList().length + 1);
  });

  it('list the 18 projects left out with a reason each', () => {
    const start = coming.indexOf('<summary>Reviewed but not importable (18)</summary>');
    expect(start).toBeGreaterThan(-1);
    const block = coming.slice(start, coming.indexOf('</details>', start));
    const items = block.split('\n').filter((l) => l.startsWith('- '));
    expect(items).toHaveLength(18);
    for (const item of items) expect(item, item).toMatch(/^- \[[^\]]+\]\(https:\/\/github\.com\/[^)]+\): \S/);
  });

  it('point to the import help and docs/IMPORTERS.md', () => {
    expect(coming).toContain('ccinfobar import --help');
    expect(coming).toContain('(docs/IMPORTERS.md)');
  });
});
