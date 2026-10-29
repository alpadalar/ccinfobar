import fs from 'node:fs';
import path from 'node:path';
import { fixedWindow } from '../../src/market/server.js';
import type { D1Database, DurableObjectNamespaceLike, Env, RateLimit } from '../../src/market/worker/env.js';
import { RateCounter } from '../../src/market/worker/limiter.js';
import { START } from './conformance.js';
import { d1, type TestD1 } from './d1-sqlite.js';

export const MIGRATIONS = path.resolve(__dirname, '../../worker/migrations');

export const VARS: Partial<Env> = {
  MARKET_NAME: 'ccinfobar marketplace',
  GITHUB_CLIENT_ID: 'Ov23liVCN9Nf6VlLv3St',
  ADMIN_GITHUB_IDS: '65018489',
  ALLOW_OVERWRITE: 'false',
  // tests run most paths without rate limit bindings
  ALLOW_OPEN_LIMITERS: 'true',
};

export interface Clock {
  now: () => number;
  advance(ms: number): void;
}

function clock(): Clock {
  let t = START;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

export function migrationFiles(): { name: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS, name), 'utf8') }));
}

export function migrations(): string[] {
  return migrationFiles().map((m) => m.sql);
}

export async function makeEnv(vars: Partial<Env> = {}): Promise<{ env: Env; db: TestD1; clock: Clock }> {
  const db = d1();
  for (const sql of migrations()) await db.exec(sql);
  const env = { ...VARS, ...vars, DB: db as unknown as D1Database } as Env;
  return { env, db, clock: clock() };
}

// for tests that never reach the database
export function stubEnv(vars: Partial<Env> = {}): { env: Env; clock: Clock } {
  const no = () => {
    throw new Error('stub DB');
  };
  const DB: D1Database = { prepare: no, batch: no, exec: no };
  return { env: { ...VARS, ...vars, DB } as Env, clock: clock() };
}

export function fakeRateLimit(limit: number, now: () => number): RateLimit {
  const window = fixedWindow(limit, now);
  return { limit: async ({ key }) => ({ success: window(key) === null }) };
}

export function throwingRateLimit(): RateLimit {
  return { limit: () => Promise.reject(new Error('binding down')) };
}

export type LimiterFault = 'throw' | '500' | 'garbage';

export function fakeLimiter(
  counter: RateCounter = new RateCounter({}, {}),
  fault?: LimiterFault,
): DurableObjectNamespaceLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (input, init) => {
        calls.push(String(id));
        if (fault === 'throw') throw new Error('do down');
        if (fault === '500') return new Response('x', { status: 500 });
        if (fault === 'garbage') return new Response('not json');
        return counter.fetch(new Request(input, init));
      },
    }),
  };
}
