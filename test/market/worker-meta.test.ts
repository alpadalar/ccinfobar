import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARKET_LIMITS, parseMeta } from '../../src/market/protocol.js';
import { fail, MESSAGES } from '../../src/market/rules.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { errorResponse, readJsonBody } from '../../src/market/worker/http.js';
import worker from '../../src/market/worker/index.js';
import { hasSqlite } from './d1-sqlite.js';
import { MIGRATIONS, makeEnv, migrations, stubEnv } from './worker-env.js';

const BASE = 'http://w.test';

function handler(vars = {}) {
  const { env, clock } = stubEnv(vars);
  return createHandler(env, { now: clock.now, fetch: () => Promise.reject(new Error('no fetch')) });
}

const get = (p: string, vars = {}) => handler(vars).fetch(new Request(BASE + p));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker landing page', () => {
  it('serves a static page with a strict CSP', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await r.text();
    expect(html).toContain('public');
    expect(html).toContain('href="https://github.com/alpadalar/ccinfobar/issues"');
    expect(html).toContain('docs/MARKETPLACE.md');
    expect(html).toContain('href="/v1/meta.json"');
    expect(html).not.toMatch(/<script/i);
  });

  it('escapes the market name', async () => {
    const html = await (await get('/', { MARKET_NAME: '<b>"x" & y</b>' })).text();
    expect(html).toContain('&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('runs through the default export', async () => {
    const r = await worker.fetch(new Request(`${BASE}/`), stubEnv().env);
    expect(r.status).toBe(200);
  });
});

describe('worker meta', () => {
  it('advertises GitHub sign-in, no overwrite and the shared limits', async () => {
    const r = await get('/v1/meta.json');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const body = await r.json();
    expect(parseMeta(body)).not.toBeNull();
    expect(body).toEqual({
      protocol: 1,
      name: 'ccinfobar marketplace',
      capabilities: {
        write: true,
        overwrite: false,
        withdraw: true,
        submit: 'api',
        review: true,
        report: true,
      },
      auth: ['github-device'],
      github: { clientId: 'Ov23liVCN9Nf6VlLv3St' },
      limits: { ...MARKET_LIMITS },
      quota: { publisherBytes: 20_971_520 },
    });
  });

  it('turns overwrite on only for the exact value true', async () => {
    expect(
      (await (await get('/v1/meta.json', { ALLOW_OVERWRITE: 'true' })).json()).capabilities.overwrite,
    ).toBe(true);
    for (const v of ['TRUE', '1', 'yes', '', undefined]) {
      const body = await (await get('/v1/meta.json', { ALLOW_OVERWRITE: v })).json();
      expect(body.capabilities.overwrite, String(v)).toBe(false);
    }
  });

  it('leaves github out without a client id', async () => {
    const body = await (await get('/v1/meta.json', { GITHUB_CLIENT_ID: '' })).json();
    expect(body).not.toHaveProperty('github');
    expect(body.auth).toEqual(['github-device']);
  });

  it('uses the market name from the env', async () => {
    const body = await (await get('/v1/meta.json', { MARKET_NAME: 'test market' })).json();
    expect(body.name).toBe('test market');
    expect((await (await get('/v1/meta.json', { MARKET_NAME: '' })).json()).name).toBe(
      'ccinfobar marketplace',
    );
  });

  it('lowers maxEntryBytes only to a valid smaller value', async () => {
    const max = async (v: string) =>
      (await (await get('/v1/meta.json', { MAX_ENTRY_BYTES: v })).json()).limits.maxEntryBytes;
    expect(await max('1000')).toBe(1000);
    for (const v of ['abc', '0', '-5', '1e3', '12.5', String(MARKET_LIMITS.maxEntryBytes + 1), '']) {
      expect(await max(v), v).toBe(MARKET_LIMITS.maxEntryBytes);
    }
  });
});

describe('worker errors', () => {
  it('answers 404 not-found for unknown routes and methods', async () => {
    const h = handler();
    for (const [method, p] of [
      ['GET', '/v1/nothing'],
      ['GET', '/v2/meta.json'],
      ['POST', '/'],
      ['PUT', '/v1/meta.json'],
      ['DELETE', '/v1/meta.json'],
    ] as const) {
      const r = await h.fetch(new Request(BASE + p, { method }));
      expect(r.status, `${method} ${p}`).toBe(404);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await r.json()).toEqual({ error: { code: 'not-found', message: MESSAGES['not-found'] } });
    }
  });

  it('answers 500 internal for a plain error and logs a fixed code only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = {
      url: `${BASE}/v1/meta.json`,
      get method(): string {
        throw new Error('secret detail');
      },
    } as unknown as Request;
    const r = await handler().fetch(bad);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: { code: 'internal', message: MESSAGES.internal } });
    expect(log.mock.calls).toEqual([['market: internal']]);
  });

  it('keeps MarketHttpError codes, messages and retry-after', async () => {
    const e = fail(429, 'rate-limited');
    e.retryAfter = 42;
    const r = errorResponse(e);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('42');
    expect(await r.json()).toEqual({ error: { code: 'rate-limited', message: MESSAGES['rate-limited'] } });
    const v = errorResponse(fail(400, 'invalid', 'invalid id'));
    expect(v.headers.get('retry-after')).toBeNull();
    expect(await v.json()).toEqual({ error: { code: 'invalid', message: 'invalid id' } });
  });
});

describe('readJsonBody', () => {
  const CAP = MARKET_LIMITS.maxBodyBytes;
  const post = (body: BodyInit | null, headers: Record<string, string>) =>
    new Request(`${BASE}/v1/entries`, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const x = e as { status: number; code: string };
      return `${x.status} ${x.code}`;
    }
    return 'ok';
  };

  it('parses JSON and treats an empty body as {}', async () => {
    expect(await readJsonBody(post('{"a":1}', { 'content-type': 'application/json' }), CAP)).toEqual({
      a: 1,
    });
    expect(
      await readJsonBody(post('[1]', { 'content-type': 'Application/JSON; charset=utf-8' }), CAP),
    ).toEqual([1]);
    expect(await readJsonBody(post(null, { 'content-type': 'application/json' }), CAP)).toEqual({});
  });

  it('checks the content type before the size', async () => {
    expect(await code(readJsonBody(post('{}', { 'content-type': 'text/plain' }), CAP))).toBe(
      '415 unsupported-media',
    );
    expect(await code(readJsonBody(post('{}', {}), CAP))).toBe('415 unsupported-media');
    const big = post('{}', { 'content-type': 'text/plain', 'content-length': String(2 * CAP) });
    expect(await code(readJsonBody(big, CAP))).toBe('415 unsupported-media');
  });

  it('refuses a declared length over the cap without reading', async () => {
    const req = {
      headers: new Headers({ 'content-type': 'application/json', 'content-length': String(2 * CAP) }),
      get body(): never {
        throw new Error('body read');
      },
    } as unknown as Request;
    expect(await code(readJsonBody(req, CAP))).toBe('413 too-large');
  });

  it('counts streamed bytes without a content length', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        sent++;
        if (sent > 40) c.close();
        else c.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = post(stream, { 'content-type': 'application/json' });
    expect(req.headers.get('content-length')).toBeNull();
    expect(await code(readJsonBody(req, CAP))).toBe('413 too-large');
    expect(sent).toBeLessThan(40);
    expect(cancelled).toBe(true);
  });

  it('accepts a body of exactly the cap', async () => {
    const text = `"${'a'.repeat(CAP - 2)}"`;
    expect(
      ((await readJsonBody(post(text, { 'content-type': 'application/json' }), CAP)) as string).length,
    ).toBe(CAP - 2);
    expect(await code(readJsonBody(post(`${text} `, { 'content-type': 'application/json' }), CAP))).toBe(
      '413 too-large',
    );
  });

  it('answers 400 invalid for bad JSON', async () => {
    for (const b of ['{', 'nope', '﻿{}']) {
      expect(await code(readJsonBody(post(b, { 'content-type': 'application/json' }), CAP)), b).toBe(
        '400 invalid',
      );
    }
  });
});

const TABLES = [
  'counters',
  'entries',
  'index_pages',
  'moderation',
  'publishers',
  'rate',
  'reports',
  'salts',
  'tokens',
  'versions',
];

describe('worker migrations', () => {
  it('are numbered sql files, 0001 first', () => {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    expect(files[0]).toBe('0001_init.sql');
    for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    expect(migrations().length).toBe(files.length);
  });

  it('never start a transaction (D1 refuses it)', () => {
    for (const sql of migrations()) expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i);
  });

  describe.skipIf(!hasSqlite)('on the D1 adapter', () => {
    it('create every table and seed the counters', async () => {
      const { db, env, clock } = await makeEnv();
      try {
        const rows = await db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all<{ name: string }>();
        expect(rows.results.map((r) => r.name)).toEqual(TABLES);
        const counters = await db.prepare('SELECT k, n FROM counters ORDER BY k').all();
        expect(counters.results).toEqual([
          { k: 'bytes', n: 0 },
          { k: 'gen', n: 0 },
        ]);
        expect(env.DB).toBe(db);
        expect(env.GITHUB_CLIENT_ID).toBe('Ov23liVCN9Nf6VlLv3St');
        const t = clock.now();
        clock.advance(1000);
        expect(clock.now()).toBe(t + 1000);
      } finally {
        db.close();
      }
    });

    it('enforce the entry kind and state checks and publisher defaults', async () => {
      const { db } = await makeEnv();
      try {
        const add = (kind: string, state: string) =>
          db
            .prepare(
              `INSERT INTO entries (publisher, slug, kind, state, version, hash, created_at, updated_at, summary, doc, gen)
               VALUES ('alp', ?1, ?2, ?3, 1, 'h', 't', 't', '{}', '{}', 1)`,
            )
            .bind(`${kind}-${state}`, kind, state)
            .run();
        for (const kind of ['preset', 'theme', 'bundle']) {
          for (const state of ['pending', 'live', 'withdrawn', 'removed']) await add(kind, state);
        }
        await expect(add('widget', 'live')).rejects.toThrow(/D1_ERROR/);
        await expect(add('preset', 'banned')).rejects.toThrow(/D1_ERROR/);
        await db
          .prepare(
            "INSERT INTO publishers (handle, github_id, github_login, display_name, created_at) VALUES ('alp', 1, 'Alp', 'Alp', 't')",
          )
          .run();
        expect(await db.prepare('SELECT trusted, banned_at, bytes FROM publishers').first()).toEqual({
          trusted: 0,
          banned_at: null,
          bytes: 0,
        });
        await expect(
          db
            .prepare(
              "INSERT INTO publishers (handle, github_id, github_login, display_name, created_at) VALUES ('alp2', 1, 'x', 'x', 't')",
            )
            .run(),
        ).rejects.toThrow(/UNIQUE/);
      } finally {
        db.close();
      }
    });
  });

  it('stubEnv has the same vars and a database that throws', () => {
    const { env } = stubEnv();
    expect(env.ALLOW_OVERWRITE).toBe('false');
    expect(() => env.DB.prepare('SELECT 1')).toThrow('stub DB');
  });
});

describe('worker/wrangler.jsonc', () => {
  const raw = fs.readFileSync(path.resolve(__dirname, '../../worker/wrangler.jsonc'), 'utf8');
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));

  it('pins the owner account and the ccinfobar-market database', () => {
    expect(cfg.name).toBe('ccinfobar-market');
    expect(cfg.account_id).toBe('54f0bc7535666a07574e745ca3b3e8e2');
    expect(cfg.d1_databases).toEqual([
      {
        binding: 'DB',
        database_name: 'ccinfobar-market',
        database_id: 'b20acc25-88bc-4148-9480-94bf88e0d232',
        migrations_dir: 'migrations',
      },
    ]);
    expect(fs.existsSync(path.resolve(__dirname, '../../worker', cfg.d1_databases[0].migrations_dir))).toBe(
      true,
    );
  });

  it('ships the prebuilt bundle with Web APIs only', () => {
    expect(cfg.main).toBe('dist/index.js');
    expect(cfg.no_bundle).toBe(true);
    expect(cfg).not.toHaveProperty('compatibility_flags');
    expect(cfg.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps invocation logs off', () => {
    expect(cfg.observability.logs.invocation_logs).toBe(false);
  });

  it('has exactly the public vars, admins by GitHub id', () => {
    expect(cfg.vars).toEqual({
      MARKET_NAME: 'ccinfobar marketplace',
      GITHUB_CLIENT_ID: 'Ov23liVCN9Nf6VlLv3St',
      ADMIN_GITHUB_IDS: '65018489',
      ALLOW_OVERWRITE: 'false',
    });
    expect(cfg.vars).not.toHaveProperty('ADMINS');
    expect(cfg).not.toHaveProperty('keep_vars');
  });

  it('keeps the optional READS rate limit binding', () => {
    expect(cfg.ratelimits.map((r: { name: string }) => r.name)).toEqual(['READS']);
  });
});
