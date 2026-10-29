import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

// ids recorded in STATE.md; the plans' provisional numbers were renumbered
describe('phase 17 decision ids in comments', () => {
  it.each([
    ['worker/wrangler.jsonc', '17-D-15', ['17-D-04']],
    ['worker/migrations/0010_held_version.sql', '17-D-17', ['17-D-02']],
    ['src/market/worker/store-entries.ts', '17-D-17', ['17-D-02']],
    ['src/data/self-update.ts', '17-D-23', ['17-D-03']],
  ])('%s cites %s', (file, id, stale) => {
    const text = read(file);
    expect(text).toContain(id);
    for (const s of stale) expect(text).not.toContain(s);
  });
});
