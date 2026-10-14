import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const STORE = 'src/data/store.ts';
const ALLOWLIST: Record<string, string> = {};
const RAW = /\b(?:writeFileSync|renameSync)\(/;

function sources(): Map<string, string> {
  const out = new Map<string, string>();
  const names = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }) as string[];
  for (const name of names) {
    if (!name.endsWith('.ts')) continue;
    const rel = `src/${name.split(path.sep).join('/')}`;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    out.set(rel, text.replace(/(^|[^:])\/\/.*$/gm, '$1'));
  }
  return out;
}

describe('atomic writes', () => {
  const files = sources();

  it('scans the source tree', () => {
    expect(files.has(STORE)).toBe(true);
    expect(files.size).toBeGreaterThan(20);
  });

  it('only the store calls writeFileSync( or renameSync(', () => {
    const offenders = [...files]
      .filter(([rel, text]) => rel !== STORE && !(rel in ALLOWLIST) && RAW.test(text))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file still has a raw write', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(files.has(rel), rel).toBe(true);
      expect(RAW.test(files.get(rel) ?? ''), rel).toBe(true);
    }
  });
});
