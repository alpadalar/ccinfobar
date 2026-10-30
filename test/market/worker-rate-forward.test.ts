import { describe, expect, it } from 'vitest';
import type { D1Database } from '../../src/market/worker/env.js';
import { bumpRate } from '../../src/market/worker/store.js';
import { skipSqlite } from './d1-sqlite.js';
import { makeEnv } from './worker-env.js';

describe.skipIf(skipSqlite)('D1 rate window', () => {
  it('only moves forward', async () => {
    const { db } = await makeEnv();
    const d = db as unknown as D1Database;
    expect(await bumpRate(d, 'k', 10)).toBe(1);
    expect(await bumpRate(d, 'k', 10)).toBe(2);
    expect(await bumpRate(d, 'k', 9)).toBe(0);
    const row = await db.prepare('SELECT win, n FROM rate WHERE key = ?1').bind('k').first();
    expect(row).toEqual({ win: 10, n: 2 });
    expect(await bumpRate(d, 'k', 10)).toBe(3);
    expect(await bumpRate(d, 'k', 11)).toBe(1);
    db.close();
  });
});
