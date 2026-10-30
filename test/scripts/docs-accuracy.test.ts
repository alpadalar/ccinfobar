import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTION_ALIASES } from '../../src/core/option-aliases.js';

const root = path.resolve(__dirname, '../..');

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

function unreleased(): string {
  const lines = read('CHANGELOG.md').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## ['));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

describe('docs accuracy', () => {
  it('[Unreleased] names old option names only as "old name"', () => {
    const text = unreleased();
    const old = new Set<string>();
    for (const byKey of Object.values(OPTION_ALIASES)) {
      for (const list of Object.values(byKey)) for (const a of list) old.add(a.key);
    }
    const bad: string[] = [];
    for (const name of old) {
      const re = new RegExp(`\`${name}\``, 'g');
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!text.slice(Math.max(0, m.index - 12), m.index).includes('old name')) bad.push(name);
      }
    }
    expect(bad).toEqual([]);
  });

  it('notes that 0.8.2 reads canonical names as defaults', () => {
    const text = unreleased();
    expect(text).toContain('0.8.2 and older');
    expect(text).toContain('canonical option names');
    const bullet = text.split(/\r?\n/).find((l) => l.includes('0.8.2 and older')) ?? '';
    expect(bullet).toContain('reason:');
    expect(read('docs/CATALOG.md')).toContain('0.8.2 and older');
  });
});
