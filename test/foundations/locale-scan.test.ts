import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const src = path.join(root, 'src');

// implicit system locale (D-19)
const BAD = [
  /\.toLocale(?:Upper|Lower)Case\(\s*\)/,
  /\.toLocale(?:Date|Time)?String\(\s*\)/,
  /\.localeCompare\(\s*[^,()]+\)/,
  /new Intl\.\w+\(\s*(?:undefined\s*)?[,)]/,
  /(?<!new )Intl\.\w+\(\s*\)/,
];

// files that may probe the default locale on purpose; need not exist yet
const ALLOW = new Map([['src/cli/lang.ts', 'Intl default locale probe (D-08 step 6)']]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

// keeps line numbers
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, '$1');
}

function hits(code: string): number[] {
  return stripComments(code)
    .split('\n')
    .flatMap((line, i) => (BAD.some((re) => re.test(line)) ? [i + 1] : []));
}

describe('locale scan', () => {
  it.each([
    ['x.toLocaleLowerCase()', true],
    ["x.toLocaleLowerCase('tr')", false],
    ['x.toLocaleUpperCase( )', true],
    ['x.toLocaleUpperCase(lang)', false],
    ['d.toLocaleString()', true],
    ["d.toLocaleString('en-US')", false],
    ['d.toLocaleDateString()', true],
    ["d.toLocaleDateString('en-US', { weekday: 'short' })", false],
    ['d.toLocaleTimeString()', true],
    ['a.localeCompare(b)', true],
    ["a.localeCompare(b, 'en')", false],
    ['new Intl.Segmenter(undefined, {})', true],
    ["new Intl.Segmenter('en', {})", false],
    ['new Intl.Collator()', true],
    ['new Intl.PluralRules(locale)', false],
    ['Intl.DateTimeFormat()', true],
    ["Intl.DateTimeFormat('tr')", false],
    ['// x.toLocaleLowerCase()', false],
    ['const a = 1; // a.localeCompare(b)', false],
    ['/* new Intl.Collator() */', false],
  ])('%s flagged: %s', (code, flagged) => {
    expect(hits(code).length > 0).toBe(flagged);
  });

  it('reports the line of a hit', () => {
    expect(hits('/*\n x.toLocaleLowerCase()\n*/\nconst a = 1;\nd.toLocaleString();\n')).toEqual([5]);
  });

  it('src has no implicit locale calls', () => {
    const found: string[] = [];
    for (const file of walk(src)) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (ALLOW.has(rel)) continue;
      for (const line of hits(fs.readFileSync(file, 'utf8'))) found.push(`${rel}:${line}`);
    }
    expect(found).toEqual([]);
  });
});
