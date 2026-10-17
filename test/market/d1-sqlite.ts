import type { DatabaseSync, StatementSync } from 'node:sqlite';

type Sqlite = typeof import('node:sqlite');

// never a static import: Node 20 has no node:sqlite and Vite must not transform it
const sqlite = process.getBuiltinModule?.('node:sqlite') as Sqlite | undefined;

// D1 code uses ?NNN params and columns(); older Node 22 releases lack one or the other
function usable(m: Sqlite | undefined): boolean {
  if (!m || typeof m.StatementSync?.prototype.columns !== 'function') return false;
  try {
    const db = new m.DatabaseSync(':memory:');
    const row = db.prepare('SELECT ?2 AS a, ?1 AS b').get(1, 2) as { a: number; b: number };
    db.close();
    return row.a === 2 && row.b === 1;
  } catch {
    return false;
  }
}

export const hasSqlite = usable(sqlite);

export type Row = Record<string, unknown>;

export interface Meta {
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  size_after: number;
  duration: number;
  changed_db: boolean;
}

export interface Result<T = Row> {
  success: true;
  results: T[];
  meta: Meta;
}

export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = unknown>(col: string): Promise<T | null>;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<Result<T>>;
  run<T = Row>(): Promise<Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

export interface TestD1 {
  prepare(sql: string): Stmt;
  batch<T = Row>(statements: Stmt[]): Promise<Result<T>[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  close(): void;
}

const LEAD = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*/;
const TX = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const VERSION = /\bsqlite_version\s*\(/i;
const TRIGGER = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;

const code = (sql: string) => sql.replace(LEAD, '');

function guard(sql: string): void {
  if (TX.test(code(sql))) throw new Error('D1_ERROR: transactions are not supported, use batch()');
  if (VERSION.test(sql)) throw new Error('D1_ERROR: not authorized');
}

function d1Error(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith('D1_') ? (err as Error) : new Error(`D1_ERROR: ${msg}`, { cause: err });
}

function bindable(v: unknown): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v) && v.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return Uint8Array.from(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error(`D1_TYPE_ERROR: Type ${typeof v} is not supported`);
}

function plain(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Uint8Array ? Array.from(v) : v;
  return out;
}

// splits a script on top-level semicolons; trigger bodies stay whole
export function statements(sql: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  let quote = '';
  while (i < sql.length) {
    const c = sql[i]!;
    if (quote) {
      if (c === quote) quote = '';
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '[') quote = ']';
      else if (c === ';') {
        parts.push(sql.slice(start, i));
        start = i + 1;
      }
      i++;
    }
  }
  parts.push(sql.slice(start));
  const out: string[] = [];
  let trigger: string | null = null;
  for (const p of parts) {
    if (trigger !== null) {
      trigger += `;${p}`;
      if (/^END\s*$/i.test(code(p))) {
        out.push(trigger);
        trigger = null;
      }
    } else if (TRIGGER.test(code(p))) trigger = p;
    else if (code(p) !== '') out.push(p);
  }
  if (trigger !== null) out.push(trigger);
  return out;
}

export function d1(file = ':memory:'): TestD1 {
  if (!sqlite || !hasSqlite) throw new Error('node:sqlite is not available');
  const Db = (sqlite as unknown as { Database?: typeof DatabaseSync }).Database ?? sqlite.DatabaseSync;
  const db = new Db(file);
  const cache = new Map<string, StatementSync>();
  const prep = (sql: string) => {
    let st = cache.get(sql);
    if (!st) {
      st = db.prepare(sql);
      cache.set(sql, st);
    }
    return st;
  };
  const STATE = `SELECT total_changes() AS t, changes() AS c, last_insert_rowid() AS r,
    (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS s`;
  const state = () => {
    const r = prep(STATE).get() as { t: number; c: number; r: number; s: number };
    return { total: Number(r.t), changes: Number(r.c), rowid: Number(r.r), size: Number(r.s) };
  };

  function execute(sql: string, args: unknown[]): Result {
    const t0 = performance.now();
    try {
      guard(sql);
      const st = prep(sql);
      const before = state().total;
      let rows: Row[] = [];
      if (st.columns().length > 0) rows = (st.all(...(args as never[])) as Row[]).map(plain);
      else st.run(...(args as never[]));
      const after = state();
      const changes = after.total !== before ? after.changes : 0;
      return {
        success: true,
        results: rows,
        meta: {
          changes,
          last_row_id: after.rowid,
          rows_read: rows.length,
          rows_written: changes,
          size_after: after.size,
          duration: performance.now() - t0,
          changed_db: changes > 0,
        },
      };
    } catch (err) {
      throw d1Error(err);
    }
  }

  const owned = new WeakMap<Stmt, () => Result>();

  function statement(sql: string, args: unknown[]): Stmt {
    const run = () => execute(sql, args);
    const s: Stmt = {
      bind: (...values: unknown[]) => statement(sql, values.map(bindable)),
      first: (async (col?: string) => {
        const row = run().results[0];
        if (!row) return null;
        if (col === undefined) return row;
        if (!(col in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found: ${col}`);
        return row[col];
      }) as Stmt['first'],
      all: async () => run() as never,
      run: async () => run() as never,
      raw: async (options?: { columnNames?: boolean }) => {
        const rows = run().results.map((r) => Object.values(r));
        if (!options?.columnNames) return rows as never;
        let names: string[] = [];
        try {
          names = prep(sql)
            .columns()
            .map((c) => c.name);
        } catch (err) {
          throw d1Error(err);
        }
        return [names, ...rows] as never;
      },
    };
    owned.set(s, run);
    return s;
  }

  return {
    prepare: (sql: string) => statement(sql, []),
    async batch<T = Row>(list: Stmt[]): Promise<Result<T>[]> {
      const runs = list.map((s) => owned.get(s));
      if (runs.some((r) => !r)) throw new Error('D1_ERROR: batch() takes statements from this database');
      db.exec('BEGIN');
      try {
        const out = runs.map((r) => r!());
        db.exec('COMMIT');
        return out as Result<T>[];
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw d1Error(err);
      }
    },
    async exec(sql: string) {
      const t0 = performance.now();
      const list = statements(sql);
      try {
        for (const s of list) guard(s);
        db.exec(sql);
      } catch (err) {
        throw d1Error(err);
      }
      return { count: list.length, duration: performance.now() - t0 };
    },
    close() {
      cache.clear();
      db.close();
    },
  };
}
