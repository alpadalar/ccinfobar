import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { d1, hasSqlite, requireSqlite, skipSqlite } from './d1-sqlite.js';

const SCHEMA = `
CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, b BLOB) STRICT;
-- semicolons in comments; and 'quotes;' do not split
CREATE TABLE kv (k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k)) WITHOUT ROWID;
CREATE TABLE counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT;
INSERT INTO counters (k, n) VALUES ('gen', 0);
`;

function fresh() {
  const db = d1();
  return { db, ready: db.exec(SCHEMA) };
}

async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return (err as Error).message;
  }
  throw new Error('expected a rejection');
}

it.skipIf(!requireSqlite)('node:sqlite is usable in CI on Node 22+', () => {
  expect(hasSqlite, 'node:sqlite with ?NNN params and columns() is required in CI on Node 22+').toBe(true);
});

it('hasSqlite is false where node:sqlite is missing', () => {
  const m = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
  if (m === undefined) expect(hasSqlite).toBe(false);
  else if (hasSqlite) expect(typeof m.StatementSync.prototype.columns).toBe('function');
});

describe.skipIf(skipSqlite)('d1 adapter over node:sqlite', () => {
  it('exec runs a multi-statement script and counts statements', async () => {
    const { db, ready } = fresh();
    expect((await ready).count).toBe(4);
    const r = await db.exec(
      'CREATE TABLE a (x INTEGER);\nINSERT INTO a VALUES (1);\nINSERT INTO a VALUES (2)',
    );
    expect(r.count).toBe(3);
    expect(typeof r.duration).toBe('number');
    expect(await db.prepare('SELECT count(*) AS c FROM a').first('c')).toBe(2);
    const q = await db.exec(
      `INSERT INTO "kv" VALUES ('a;b', 'c;d');\n/* x; */ INSERT INTO kv VALUES ('e', 'f');`,
    );
    expect(q.count).toBe(2);
    expect(await db.prepare('SELECT v FROM kv WHERE k = ?').bind('a;b').first('v')).toBe('c;d');
    db.close();
  });

  it('exec counts a trigger body as one statement', async () => {
    const { db, ready } = fresh();
    await ready;
    const r = await db.exec(`CREATE TRIGGER bump AFTER INSERT ON t BEGIN
  UPDATE counters SET n = n + 1 WHERE k = 'gen';
END;
INSERT INTO t (id, n) VALUES ('a', 1);`);
    expect(r.count).toBe(2);
    expect(await db.prepare(`SELECT n FROM counters WHERE k = 'gen'`).first('n')).toBe(1);
    db.close();
  });

  it('first returns null for no rows and a column value by name', async () => {
    const { db, ready } = fresh();
    await ready;
    expect(await db.prepare('SELECT * FROM t WHERE id = ?').bind('none').first()).toBeNull();
    expect(await db.prepare('SELECT n FROM t WHERE id = ?').bind('none').first('n')).toBeNull();
    await db.prepare('INSERT INTO t (id, n) VALUES (?1, ?2)').bind('a', 7).run();
    expect(await db.prepare('SELECT id, n FROM t').first()).toEqual({ id: 'a', n: 7 });
    expect(await db.prepare('SELECT id, n FROM t').first('n')).toBe(7);
    expect(await message(db.prepare('SELECT id FROM t').first('nope'))).toMatch(/^D1_COLUMN_NOTFOUND/);
    db.close();
  });

  it('bind returns a new statement and supports numbered and repeated params', async () => {
    const { db, ready } = fresh();
    await ready;
    const ins = db.prepare('INSERT INTO t (id, n) VALUES (?1, ?2)');
    await ins.bind('a', 1).run();
    await ins.bind('b', 2).run();
    const q = db.prepare('SELECT ?2 AS second, ?1 AS first, ?2 - 1 AS again');
    expect(await q.bind(10, 20).first()).toEqual({ second: 20, first: 10, again: 19 });
    expect(await db.prepare('SELECT count(*) AS c FROM t').first('c')).toBe(2);
    db.close();
  });

  it('undefined binds throw D1_TYPE_ERROR and booleans bind as 1/0', async () => {
    const { db, ready } = fresh();
    await ready;
    const ins = db.prepare('INSERT INTO t (id, n) VALUES (?, ?)');
    expect(() => ins.bind('a', undefined)).toThrow(/^D1_TYPE_ERROR: Type undefined is not supported/);
    expect(() => ins.bind('a', { x: 1 })).toThrow(/^D1_TYPE_ERROR/);
    expect(() => ins.bind('a', 1n)).toThrow(/^D1_TYPE_ERROR/);
    await ins.bind('yes', true).run();
    await ins.bind('no', false).run();
    await ins.bind('nil', null).run();
    const rows = (await db.prepare('SELECT id, n FROM t ORDER BY id').all()).results;
    expect(rows).toEqual([
      { id: 'nil', n: null },
      { id: 'no', n: 0 },
      { id: 'yes', n: 1 },
    ]);
    db.close();
  });

  it('batch is all-or-nothing', async () => {
    const { db, ready } = fresh();
    await ready;
    await db.prepare(`INSERT INTO t (id, n) VALUES ('taken', 0)`).run();
    const ins = db.prepare('INSERT INTO t (id, n) VALUES (?, ?)');
    const bump = db.prepare(`UPDATE counters SET n = n + 1 WHERE k = 'gen'`);
    const err = await message(db.batch([ins.bind('fresh', 1), bump, ins.bind('taken', 2)]));
    expect(err).toMatch(/^D1_ERROR: .*UNIQUE constraint failed/);
    expect(await db.prepare(`SELECT id FROM t WHERE id = 'fresh'`).first()).toBeNull();
    expect(await db.prepare(`SELECT n FROM counters WHERE k = 'gen'`).first('n')).toBe(0);
    const ok = await db.batch([ins.bind('fresh', 1), bump, db.prepare('SELECT count(*) AS c FROM t')]);
    expect(ok.map((r) => r.success)).toEqual([true, true, true]);
    expect(ok[0]!.meta.changes).toBe(1);
    expect(ok[2]!.results).toEqual([{ c: 2 }]);
    expect(await db.prepare(`SELECT n FROM counters WHERE k = 'gen'`).first('n')).toBe(1);
    db.close();
  });

  it('a guarded UPDATE that matches nothing reports zero changes', async () => {
    const { db, ready } = fresh();
    await ready;
    const r = await db.prepare(`UPDATE counters SET n = 5 WHERE k = 'gen' AND n = ?`).bind(9).run();
    expect(r.meta.changes).toBe(0);
    expect(r.meta.changed_db).toBe(false);
    const w = await db.prepare(`UPDATE counters SET n = 5 WHERE k = 'gen' AND n = ?`).bind(0).run();
    expect(w.meta.changes).toBe(1);
    expect(w.meta.rows_written).toBe(1);
    expect(w.meta.changed_db).toBe(true);
    db.close();
  });

  it('transaction statements are refused like D1', async () => {
    const { db, ready } = fresh();
    await ready;
    for (const sql of ['BEGIN', 'begin transaction', '  COMMIT', 'ROLLBACK', 'SAVEPOINT s', 'RELEASE s']) {
      expect(await message(db.prepare(sql).run())).toMatch(/^D1_ERROR: /);
    }
    expect(await message(db.batch([db.prepare('BEGIN')]))).toMatch(/^D1_ERROR: /);
    expect(await message(db.exec('INSERT INTO kv VALUES (1, 1);\nBEGIN;'))).toMatch(/^D1_ERROR: /);
    expect(await db.prepare('SELECT count(*) AS c FROM kv').first('c')).toBe(0);
    db.close();
  });

  it('sqlite_version() is not authorized', async () => {
    const { db, ready } = fresh();
    await ready;
    expect(await message(db.prepare('SELECT sqlite_version() AS v').first())).toBe(
      'D1_ERROR: not authorized',
    );
    db.close();
  });

  it('sqlite errors are prefixed with D1_ERROR', async () => {
    const { db, ready } = fresh();
    await ready;
    expect(await message(db.prepare('SELECT * FROM missing').all())).toMatch(/^D1_ERROR: .*no such table/);
    expect(await message(db.prepare('INSERT INTO t (id, n) VALUES (?, ?)').bind('a', 'text').run())).toMatch(
      /^D1_ERROR: /,
    );
    db.close();
  });

  it('rows are plain objects and BLOB cells read as arrays', async () => {
    const { db, ready } = fresh();
    await ready;
    await db.prepare('INSERT INTO t (id, n, b) VALUES (?, ?, ?)').bind('a', 1, [1, 2, 255]).run();
    await db
      .prepare('INSERT INTO t (id, n, b) VALUES (?, ?, ?)')
      .bind('c', 3, new Uint8Array([9]))
      .run();
    const { results } = await db.prepare('SELECT id, b FROM t ORDER BY id').all();
    expect(results).toHaveLength(2);
    for (const row of results) expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Array.isArray(results[0]!.b)).toBe(true);
    expect(results[0]!.b).toEqual([1, 2, 255]);
    expect(results[1]!.b).toEqual([9]);
    expect(await db.prepare('SELECT id, n FROM t ORDER BY id').raw()).toEqual([
      ['a', 1],
      ['c', 3],
    ]);
    expect(await db.prepare('SELECT id, n FROM t ORDER BY id').raw({ columnNames: true })).toEqual([
      ['id', 'n'],
      ['a', 1],
      ['c', 3],
    ]);
    db.close();
  });

  it('upsert with RETURNING returns the row and its changes', async () => {
    const { db, ready } = fresh();
    await ready;
    await db.prepare(`UPDATE counters SET n = 4 WHERE k = 'gen'`).run();
    const up = db.prepare(
      `INSERT INTO counters (k, n) VALUES (?1, 1) ON CONFLICT (k) DO UPDATE SET n = n + 1 RETURNING n`,
    );
    const r = await up.bind('gen').all();
    expect(r.results).toEqual([{ n: 5 }]);
    expect(r.meta.changes).toBe(1);
    const created = await up.bind('other').run();
    expect(created.results).toEqual([{ n: 1 }]);
    expect(created.meta.changes).toBe(1);
    expect(await up.bind('other').first('n')).toBe(2);
    const sel = await db.prepare('SELECT n FROM counters ORDER BY k').all();
    expect(sel.meta.changes).toBe(0);
    db.close();
  });

  it('run on an INSERT reports last_row_id', async () => {
    const { db, ready } = fresh();
    await ready;
    await db.exec('CREATE TABLE r (id INTEGER PRIMARY KEY, s TEXT)');
    const a = await db.prepare('INSERT INTO r (s) VALUES (?)').bind('x').run();
    const b = await db.prepare('INSERT INTO r (s) VALUES (?) RETURNING id').bind('y').run();
    expect(a.meta.last_row_id).toBe(1);
    expect(b.meta.last_row_id).toBe(2);
    expect(b.results).toEqual([{ id: 2 }]);
    db.close();
  });

  it('meta.size_after grows with stored data; STRICT and WITHOUT ROWID tables work', async () => {
    const { db, ready } = fresh();
    await ready;
    const before = await db.prepare(`INSERT INTO kv (k, v) VALUES ('small', 'x')`).run();
    expect(before.meta.size_after).toBeGreaterThan(0);
    const after = await db
      .prepare('INSERT INTO kv (k, v) VALUES (?, ?)')
      .bind('big', 'y'.repeat(100 * 1024))
      .run();
    expect(after.meta.size_after).toBeGreaterThan(before.meta.size_after + 90 * 1024);
    expect(await db.prepare('SELECT length(v) AS l FROM kv WHERE k = ?').bind('big').first('l')).toBe(
      100 * 1024,
    );
    expect(await message(db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').bind('small', 'z').run())).toMatch(
      /^D1_ERROR: .*UNIQUE constraint failed/,
    );
    db.close();
  });

  it('opens a database file and closes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-d1-'));
    const file = path.join(dir, 'market.db');
    try {
      const db = d1(file);
      await db.exec(SCHEMA);
      await db.prepare(`INSERT INTO kv (k, v) VALUES ('a', 'b')`).run();
      db.close();
      const again = d1(file);
      expect(await again.prepare('SELECT v FROM kv').first('v')).toBe('b');
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
