import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const widgets = fs.readFileSync(path.join(root, 'docs/WIDGETS.md'), 'utf8');
const row = (type: string) => widgets.split('\n').find((l) => l.startsWith(`| \`${type}\` |`)) ?? '';

describe('WIDGETS.md option names', () => {
  it('lists canonical keys with their old names', () => {
    const jj = row('jj-bookmarks');
    expect(jj).toContain('`maxItems` (old name: `maxBookmarks`)');
    const c = row('compactions');
    expect(c).toContain('`hideZero` (old name: `showZero`, inverted)');
  });

  it('marks only inverted aliases as inverted', () => {
    expect(row('jj-bookmarks')).not.toContain('inverted');
  });
});

describe('config schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema/config.schema.json'), 'utf8'));

  function findOptions(node: unknown): Record<string, any> | null {
    if (!node || typeof node !== 'object') return null;
    const o = node as Record<string, any>;
    if (o.properties?.options?.additionalProperties) return o.properties.options;
    for (const v of Object.values(o)) {
      const hit = findOptions(v);
      if (hit) return hit;
    }
    return null;
  }

  it('accepts old and canonical option names with scalar values', () => {
    const options = findOptions(schema)!;
    expect(options.type).toBe('object');
    expect(options.additionalProperties.type).toEqual(['string', 'number', 'boolean']);
    expect(options.properties).toBeUndefined();
  });
});
