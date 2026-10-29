import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ID_RE, isFileId, readableId, reservedId } from '../../src/core/ids.js';

describe('ids', () => {
  it.each([
    'con',
    'CON',
    'Con.json',
    'nul',
    'Nul.theme',
    'prn',
    'aux',
    'com1',
    'COM9.x',
    'lpt5',
    'LPT1',
    'com0',
    'LPT0',
    'lpt0.json',
  ])('refuses device name %s', (id) => {
    expect(reservedId(id)).toBe(true);
    expect(isFileId(id)).toBe(false);
  });

  it.each(['console', 'com10', 'nul-theme', 'aux2', 'dracula', 'my.theme_1'])('accepts %s', (id) => {
    expect(reservedId(id)).toBe(false);
    expect(isFileId(id)).toBe(true);
  });

  it('rejects non-ids', () => {
    for (const v of [1, null, undefined, '', '.hidden', 'a'.repeat(65), 'bad id']) {
      expect(isFileId(v)).toBe(false);
    }
    expect(isFileId('a'.repeat(64))).toBe(true);
  });

  it('keeps the id shape', () => {
    expect(ID_RE.source).toBe('^[a-z0-9][a-z0-9._-]{0,63}$');
    expect(ID_RE.flags).toBe('i');
  });

  it('readableId refuses device names on win32 only', () => {
    expect(readableId('con', 'win32')).toBe(false);
    expect(readableId('lpt0.json', 'win32')).toBe(false);
    expect(readableId('con', 'linux')).toBe(true);
    expect(readableId('con', 'darwin')).toBe(true);
    expect(readableId('nord', 'win32')).toBe(true);
    expect(readableId('bad id', 'linux')).toBe(false);
  });
});

describe('ID_RE source', () => {
  const root = path.join(__dirname, '..', '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
    );

  it('is defined once', () => {
    const hits = walk(path.join(root, 'src'))
      .filter((f) => readFileSync(f, 'utf8').includes('[a-z0-9][a-z0-9._-]{0,63}'))
      .map((f) => path.relative(root, f).split(path.sep).join('/'));
    expect(hits).toEqual(['src/core/ids.ts']);
  });
});
