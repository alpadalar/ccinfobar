import { createHash } from 'node:crypto';
import { describe, expect, it, type TestContext } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import { contentHash, createMarketClient } from '../../src/market/client.js';
import {
  canonicalJson,
  INDEX_PAGE,
  MARKET_LIMITS,
  parseIndex,
  parseMeta,
  parseRemoteEntry,
} from '../../src/market/protocol.js';
import type { CAPS } from '../../src/market/rules.js';

// protocol v1 cases every server must pass; reference-only cases stay in server.test.ts

export interface TargetOpts {
  allowOverwrite?: boolean;
  rateLimit?: { perMinute: number; readsPerMinute?: number; registersPerMinute?: number };
  caps?: Partial<typeof CAPS>;
}

export interface TargetCaps {
  overwrite: boolean;
  registersAnon: boolean;
  etag: boolean;
  review: boolean;
  rateLimit: boolean;
}

export interface MarketTarget {
  url: string;
  fetch: typeof fetch;
  signIn(handle: string): Promise<string>;
  advance(ms: number): void;
  caps: TargetCaps;
  close(): Promise<void>;
}

// every target clock starts here
export const START = Date.UTC(2026, 9, 16, 12, 0, 0);

interface Res {
  status: number;
  body: string;
  headers: Headers;
  json: () => any;
}

interface Req {
  body?: unknown;
  token?: string | undefined;
  headers?: Record<string, string>;
}

async function request(t: MarketTarget, method: string, p: string, opts: Req = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
  }
  const r = await t.fetch(`${t.url}${p}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await r.text();
  return { status: r.status, body: text, headers: r.headers, json: () => JSON.parse(text) };
}

const preset = (lines: unknown[][] = [[{ type: 'model' }]]) =>
  ({ layout: { lines } }) as unknown as EntryContent;

function publishBody(slug: string, content: unknown = preset(), kind = 'preset') {
  return { kind, slug, name: `Name ${slug}`, description: 'desc', author: 'Alp', content, note: 'first' };
}

const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

async function withTwo(t: MarketTarget, token: string): Promise<void> {
  await request(t, 'POST', '/v1/entries', { token, body: publishBody('mine') });
  const r = await request(t, 'POST', '/v1/entries/alp/mine/versions', {
    token,
    headers: { 'if-match': '"1"' },
    body: { content: preset([[{ type: 'cwd' }]]), note: 'two' },
  });
  expect(r.status).toBe(201);
}

type Need = keyof Omit<TargetCaps, 'overwrite'>;

export function describeConformance(name: string, make: (o: TargetOpts) => Promise<MarketTarget>): void {
  async function open(
    o: TargetOpts,
    fn: (t: MarketTarget) => Promise<void>,
    ctx?: TestContext,
    need: Need[] = [],
    without: Need[] = [],
  ): Promise<void> {
    const t = await make(o);
    try {
      if (ctx && (need.some((k) => !t.caps[k]) || without.some((k) => t.caps[k]))) return ctx.skip();
      await fn(t);
    } finally {
      await t.close();
    }
  }

  const client = (t: MarketTarget, token?: string) =>
    createMarketClient({ endpoint: t.url, fetch: t.fetch, ...(token ? { token } : {}) });

  async function account(t: MarketTarget, handle: string): Promise<string> {
    if (!t.caps.registersAnon) return t.signIn(handle);
    const r = await client(t).register(handle, 'Alp');
    expect(r.handle).toBe(handle);
    return r.token;
  }

  describe(`market conformance: ${name}`, () => {
    describe('meta and index', () => {
      for (const on of [true, false]) {
        it(`serves meta.json with protocol 1 and write capabilities (overwrite ${on ? 'on' : 'off'})`, () =>
          open({ allowOverwrite: on }, async (t) => {
            expect(t.caps.overwrite).toBe(on);
            const r = await request(t, 'GET', '/v1/meta.json');
            expect(r.status).toBe(200);
            expect(r.json()).toMatchObject({
              protocol: 1,
              capabilities: { write: true, overwrite: on, withdraw: true, submit: 'api' },
            });
            expect(parseMeta(r.json())?.capabilities.write).toBe(true);
            const empty = await request(t, 'GET', '/v1/index.json');
            expect(empty.status).toBe(200);
            expect(empty.json().entries).toEqual([]);
          }));
      }

      it('sorts the index by publisher, then slug', () =>
        open({}, async (t) => {
          const x = await t.signIn('a-b');
          const y = await t.signIn('a');
          await request(t, 'POST', '/v1/entries', { token: x, body: publishBody('z') });
          await request(t, 'POST', '/v1/entries', { token: y, body: publishBody('z') });
          await request(t, 'POST', '/v1/entries', { token: y, body: publishBody('y') });
          const ids = (await request(t, 'GET', '/v1/index.json')).json().entries.map((e: any) => e.id);
          expect(ids).toEqual(['a/y', 'a/z', 'a-b/z']);
        }));

      it(
        `pages the index at ${INDEX_PAGE} entries and the client reads every page`,
        () =>
          open({ rateLimit: { perMinute: 100_000 } }, async (t) => {
            const total = INDEX_PAGE + 1;
            const ids: string[] = [];
            for (const [handle, n] of [
              ['pa', 200],
              ['pb', 200],
              ['pc', total - 400],
            ] as const) {
              const token = await t.signIn(handle);
              for (let i = 0; i < n; i++) {
                const slug = `e${String(i).padStart(3, '0')}`;
                const r = await request(t, 'POST', '/v1/entries', { token, body: publishBody(slug) });
                expect(r.status).toBe(201);
                ids.push(`${handle}/${slug}`);
              }
            }
            const first = (await request(t, 'GET', '/v1/index.json')).json();
            expect(first.entries).toHaveLength(INDEX_PAGE);
            expect(first.next).toBe('index-2.json');
            const second = await request(t, 'GET', '/v1/index-2.json');
            expect(second.status).toBe(200);
            expect(second.json().entries.map((e: any) => e.id)).toEqual(['pc/e100']);
            expect(second.json().next).toBeUndefined();
            const third = await request(t, 'GET', '/v1/index-3.json');
            expect(third.status).toBe(404);
            expect(third.json().error.code).toBe('not-found');
            const index = await client(t).index();
            expect(index.entries.map((e) => e.id)).toEqual(ids);
          }),
        // 501 publishes write thousands of files, slow on Windows runners
        240_000,
      );
    });

    describe('publishers', () => {
      it('register publisher returns a token once', (ctx) =>
        open(
          {},
          async (t) => {
            const r = await request(t, 'POST', '/v1/publishers', {
              body: { handle: 'alp', displayName: 'Alp' },
            });
            expect(r.status).toBe(201);
            const { handle, token } = r.json();
            expect(handle).toBe('alp');
            expect(token).toMatch(/^[0-9a-f]{64}$/);
            const again = await request(t, 'POST', '/v1/publishers', {
              body: { handle: 'alp', displayName: 'Other' },
            });
            expect(again.status).toBe(409);
            expect(again.json()).toEqual({ error: { code: 'conflict', message: expect.any(String) } });
            expect(again.body).not.toContain(token);
          },
          ctx,
          ['registersAnon'],
        ));

      it('rejects bad handles and bodies', (ctx) =>
        open(
          { rateLimit: { perMinute: 30, registersPerMinute: 20 } },
          async (t) => {
            for (const body of [
              { handle: 'ALP', displayName: 'x' },
              { handle: '../x', displayName: 'x' },
              { handle: '-a', displayName: 'x' },
              { handle: 'a'.repeat(40), displayName: 'x' },
              { handle: 'ok', displayName: 5 },
              { displayName: 'x' },
              [],
            ]) {
              const r = await request(t, 'POST', '/v1/publishers', { body });
              expect(r.status, JSON.stringify(body)).toBe(400);
              expect(r.json().error.code).toBe('invalid');
            }
            const bad = await request(t, 'POST', '/v1/publishers', { body: '{not json' });
            expect(bad.status).toBe(400);
            expect(bad.json().error.code).toBe('invalid');
          },
          ctx,
          ['registersAnon'],
        ));

      it('refuses anonymous registration when publishers must sign in', (ctx) =>
        open(
          {},
          async (t) => {
            const r = await request(t, 'POST', '/v1/publishers', {
              body: { handle: 'alp', displayName: 'Alp' },
            });
            expect(r.status).toBe(403);
            expect(r.json().error.code).toBe('forbidden');
            expect(r.body).not.toMatch(/[0-9a-f]{64}/);
          },
          ctx,
          [],
          ['registersAnon'],
        ));
    });

    describe('publish and versions', () => {
      it('publish creates v1 and the index lists it', () =>
        open({}, async (t) => {
          const token = await t.signIn('alp');
          const content = preset();
          const r = await request(t, 'POST', '/v1/entries', { token, body: publishBody('mine', content) });
          expect(r.status).toBe(201);
          const hash = sha(content);
          expect(r.json()).toEqual({ id: 'alp/mine', version: 1, hash });

          const index = (await request(t, 'GET', '/v1/index.json')).json();
          expect(parseIndex(index)?.entries).toEqual([
            {
              id: 'alp/mine',
              kind: 'preset',
              name: 'Name mine',
              description: 'desc',
              author: 'Alp',
              publisher: 'alp',
              version: 1,
              updatedAt: '2026-10-16T12:00:00.000Z',
              hash,
            },
          ]);
          const entry = parseRemoteEntry((await request(t, 'GET', '/v1/entries/alp/mine.json')).json());
          expect(entry?.versions).toEqual([
            { version: 1, at: '2026-10-16T12:00:00.000Z', note: 'first', hash },
          ]);
          const v1 = (await request(t, 'GET', '/v1/entries/alp/mine/1.json')).json();
          expect(v1).toEqual({ version: 1, content, hash });
          expect(sha(v1.content)).toBe(v1.hash);

          const dup = await request(t, 'POST', '/v1/entries', { token, body: publishBody('mine') });
          expect(dup.status).toBe(409);
          expect(dup.json().error.code).toBe('conflict');
        }));

      it('a new version needs If-Match and answers 412 when stale', () =>
        open({}, async (t) => {
          const token = await t.signIn('alp');
          await request(t, 'POST', '/v1/entries', { token, body: publishBody('mine') });
          const v1Body = (await request(t, 'GET', '/v1/entries/alp/mine/1.json')).body;
          const next = preset([[{ type: 'model' }, { type: 'cwd' }]]);
          const p = '/v1/entries/alp/mine/versions';

          const missing = await request(t, 'POST', p, { token, body: { content: next, note: 'n' } });
          expect(missing.status).toBe(412);
          expect(missing.json().error.code).toBe('stale');

          t.advance(60_000);
          const ok = await request(t, 'POST', p, {
            token,
            headers: { 'if-match': '"1"' },
            body: { content: next, note: 'second', name: 'Renamed' },
          });
          expect(ok.status).toBe(201);
          expect(ok.json()).toEqual({ id: 'alp/mine', version: 2, hash: sha(next) });

          const stale = await request(t, 'POST', p, {
            token,
            headers: { 'if-match': '"1"' },
            body: { content: next, note: 'again' },
          });
          expect(stale.status).toBe(412);
          expect(stale.json().error.code).toBe('stale');

          const entry = parseRemoteEntry((await request(t, 'GET', '/v1/entries/alp/mine.json')).json())!;
          expect(entry.versions.map((v) => v.version)).toEqual([1, 2]);
          expect(entry).toMatchObject({ version: 2, name: 'Renamed', updatedAt: '2026-10-16T12:01:00.000Z' });
          expect(entry.versions[1]).toEqual({
            version: 2,
            at: '2026-10-16T12:01:00.000Z',
            note: 'second',
            hash: sha(next),
          });
          expect((await request(t, 'GET', '/v1/entries/alp/mine/1.json')).body).toBe(v1Body);
          expect((await request(t, 'GET', '/v1/entries/alp/mine/2.json')).json().content).toEqual(next);
          expect((await request(t, 'GET', '/v1/entries/alp/mine/3.json')).status).toBe(404);
          const index = parseIndex((await request(t, 'GET', '/v1/index.json')).json())!;
          expect(index.entries[0]).toMatchObject({ id: 'alp/mine', version: 2, hash: sha(next) });
        }));

      it('cols rides along as metadata outside the content hash', () =>
        open({}, async (t) => {
          expect(parseMeta((await request(t, 'GET', '/v1/meta.json')).json())?.capabilities.cols).toBe(true);
          const token = await t.signIn('alp');
          const content = preset();
          const r = await request(t, 'POST', '/v1/entries', {
            token,
            body: { ...publishBody('wide', content), cols: 150 },
          });
          expect(r.status).toBe(201);
          expect(r.json().hash).toBe(sha(content));
          const plain = await request(t, 'POST', '/v1/entries', {
            token,
            body: publishBody('plain', content),
          });
          expect(plain.json().hash).toBe(sha(content));
          const bad = await request(t, 'POST', '/v1/entries', {
            token,
            body: { ...publishBody('bad'), cols: 5 },
          });
          expect(bad.status).toBe(201);
          const summaries = async () =>
            new Map(
              parseIndex((await request(t, 'GET', '/v1/index.json')).json())!.entries.map((e) => [e.id, e]),
            );
          const doc = async (slug: string) =>
            (await request(t, 'GET', `/v1/entries/alp/${slug}.json`)).json();
          let index = await summaries();
          expect(index.get('alp/wide')?.cols).toBe(150);
          expect(index.get('alp/plain')).not.toHaveProperty('cols');
          expect(index.get('alp/bad')).not.toHaveProperty('cols');
          expect((await doc('wide')).cols).toBe(150);
          expect(await doc('plain')).not.toHaveProperty('cols');
          expect(await doc('bad')).not.toHaveProperty('cols');

          const p = '/v1/entries/alp/wide/versions';
          const two = preset([[{ type: 'cwd' }]]);
          const v2 = await request(t, 'POST', p, {
            token,
            headers: { 'if-match': '"1"' },
            body: { content: two, note: '' },
          });
          expect(v2.status).toBe(201);
          index = await summaries();
          expect(index.get('alp/wide')).toMatchObject({ version: 2, cols: 150 });
          const v3 = await request(t, 'POST', p, {
            token,
            headers: { 'if-match': '"2"' },
            body: { content: preset(), note: '', cols: 90 },
          });
          expect(v3.status).toBe(201);
          index = await summaries();
          expect(index.get('alp/wide')).toMatchObject({ version: 3, cols: 90 });
          expect(parseRemoteEntry(await doc('wide'))?.cols).toBe(90);

          expect((await request(t, 'DELETE', '/v1/entries/alp/wide', { token })).status).toBe(200);
          const tomb = await doc('wide');
          expect(tomb.withdrawn).toBe(true);
          expect(tomb).not.toHaveProperty('cols');
        }));

      it('overwrite sets cols', (ctx) =>
        open({ allowOverwrite: true }, async (t) => {
          if (!t.caps.overwrite) return ctx.skip();
          const token = await t.signIn('alp');
          await request(t, 'POST', '/v1/entries', { token, body: { ...publishBody('wide'), cols: 150 } });
          const keep = await request(t, 'PUT', '/v1/entries/alp/wide/versions/1', {
            token,
            body: { content: preset([[{ type: 'cwd' }]]), note: '' },
          });
          expect(keep.status).toBe(200);
          let doc = (await request(t, 'GET', '/v1/entries/alp/wide.json')).json();
          expect(doc.cols).toBe(150);
          const r = await request(t, 'PUT', '/v1/entries/alp/wide/versions/1', {
            token,
            body: { content: preset(), note: '', cols: 200 },
          });
          expect(r.status).toBe(200);
          doc = (await request(t, 'GET', '/v1/entries/alp/wide.json')).json();
          expect(doc.cols).toBe(200);
          const index = parseIndex((await request(t, 'GET', '/v1/index.json')).json())!;
          expect(index.entries[0]?.cols).toBe(200);
        }));

      it('only the owner token may write its entries', () =>
        open({}, async (t) => {
          const alp = await t.signIn('alp');
          const bob = await t.signIn('bob');
          await request(t, 'POST', '/v1/entries', { token: alp, body: publishBody('mine') });
          const p = '/v1/entries/alp/mine/versions';
          const body = { content: preset(), note: '' };
          const headers = { 'if-match': '"1"' };

          const other = await request(t, 'POST', p, { token: bob, headers, body });
          expect(other.status).toBe(403);
          expect(other.json().error.code).toBe('forbidden');
          const none = await request(t, 'POST', p, { headers, body });
          expect(none.status).toBe(401);
          expect(none.json().error.code).toBe('unauthorized');
          const unknown = await request(t, 'POST', p, { token: 'f'.repeat(64), headers, body });
          expect(unknown.status).toBe(401);
          const junk = await request(t, 'POST', p, { token: '../alp', headers, body });
          expect(junk.status).toBe(401);
          const noPublish = await request(t, 'POST', '/v1/entries', { body: publishBody('x') });
          expect(noPublish.status).toBe(401);
          const missing = await request(t, 'POST', '/v1/entries/alp/nope/versions', {
            token: alp,
            headers,
            body,
          });
          expect(missing.status).toBe(404);

          // bob publishes under his own handle only
          const own = await request(t, 'POST', '/v1/entries', { token: bob, body: publishBody('mine') });
          expect(own.json().id).toBe('bob/mine');
          const entry = parseRemoteEntry((await request(t, 'GET', '/v1/entries/alp/mine.json')).json())!;
          expect(entry.versions).toHaveLength(1);
        }));

      it('command/http/env content and personal keys are rejected as data-only', () =>
        open({}, async (t) => {
          const token = await t.signIn('alp');
          const cases: [unknown, string][] = [
            [preset([[{ type: 'command', options: { command: 'echo hi' } }]]), 'command-widget'],
            [preset([[{ type: 'http', options: { url: 'https://example.com' } }]]), 'http-widget'],
            [preset([[{ type: 'env', options: { name: 'HOME' } }]]), 'env-widget'],
            [preset([[{ type: 'link', options: { url: 'file:///etc/passwd' } }]]), 'unsafe-link'],
            [{ layout: { lines: [[{ type: 'model' }]], budget: { daily: 5 } } }, 'personal-key:budget'],
            [{ layout: { lines: 'x' } }, 'bad-lines'],
            [{ appearance: { style: 'plain' } }, 'unknown-key:appearance'],
          ];
          for (const [content, code] of cases) {
            const r = await request(t, 'POST', '/v1/entries', { token, body: publishBody('bad', content) });
            expect(r.status, code).toBe(400);
            expect(r.json()).toEqual({ error: { code: 'invalid', message: code } });
          }
          await request(t, 'POST', '/v1/entries', { token, body: publishBody('good') });
          const v = await request(t, 'POST', '/v1/entries/alp/good/versions', {
            token,
            headers: { 'if-match': '"1"' },
            body: { content: preset([[{ type: 'command', options: { command: 'x' } }]]), note: '' },
          });
          expect(v.status).toBe(400);
          expect(v.json().error.message).toBe('command-widget');
          const theme = await request(t, 'POST', '/v1/entries', {
            token,
            body: publishBody('th', { appearance: { style: 'powerline' } }, 'theme'),
          });
          expect(theme.status).toBe(201);
          expect((await request(t, 'GET', '/v1/entries/alp/bad.json')).status).toBe(404);
          expect((await request(t, 'GET', '/v1/entries/alp/bad/1.json')).status).toBe(404);
          expect((await request(t, 'GET', '/v1/entries/alp/good/2.json')).status).toBe(404);
        }));
    });

    describe('overwrite', () => {
      it('overwrite replaces the latest version in place', (ctx) =>
        open(
          { allowOverwrite: true },
          async (t) => {
            if (!t.caps.overwrite) return ctx.skip();
            const alp = await t.signIn('alp');
            const bob = await t.signIn('bob');
            await withTwo(t, alp);
            const v1Body = (await request(t, 'GET', '/v1/entries/alp/mine/1.json')).body;
            const next = preset([[{ type: 'model' }, { type: 'git-branch' }]]);
            t.advance(60_000);
            const r = await request(t, 'PUT', '/v1/entries/alp/mine/versions/2', {
              token: alp,
              body: { content: next, note: 'fixed', description: 'better' },
            });
            expect(r.status).toBe(200);
            expect(r.json()).toEqual({ id: 'alp/mine', version: 2, hash: sha(next) });
            const raw = (await request(t, 'GET', '/v1/entries/alp/mine.json')).json();
            expect(raw.versions).toHaveLength(2);
            expect(raw.versions[1]).toEqual({
              version: 2,
              at: '2026-10-16T12:00:00.000Z',
              note: 'fixed',
              hash: sha(next),
              overwrittenAt: '2026-10-16T12:01:00.000Z',
            });
            expect(raw).toMatchObject({ version: 2, hash: sha(next), description: 'better' });
            expect(raw.updatedAt).toBe('2026-10-16T12:01:00.000Z');
            expect((await request(t, 'GET', '/v1/entries/alp/mine/2.json')).json()).toEqual({
              version: 2,
              content: next,
              hash: sha(next),
            });
            expect((await request(t, 'GET', '/v1/entries/alp/mine/1.json')).body).toBe(v1Body);
            const index = parseIndex((await request(t, 'GET', '/v1/index.json')).json())!;
            expect(index.entries[0]).toMatchObject({ version: 2, hash: sha(next) });

            const body = { content: preset(), note: '' };
            for (const [n, token, status, code] of [
              [1, alp, 409, 'conflict'],
              [3, alp, 409, 'conflict'],
              [2, bob, 403, 'forbidden'],
              [2, undefined, 401, 'unauthorized'],
            ] as const) {
              const bad = await request(t, 'PUT', `/v1/entries/alp/mine/versions/${n}`, { token, body });
              expect(bad.status, `${n} ${code}`).toBe(status);
              expect(bad.json().error.code).toBe(code);
            }
            expect(
              (await request(t, 'PUT', '/v1/entries/alp/mine/versions/0', { token: alp, body })).status,
            ).toBe(400);
            expect(
              (await request(t, 'PUT', '/v1/entries/alp/nope/versions/1', { token: alp, body })).status,
            ).toBe(404);
            const cmd = await request(t, 'PUT', '/v1/entries/alp/mine/versions/2', {
              token: alp,
              body: { content: preset([[{ type: 'command', options: { command: 'x' } }]]), note: '' },
            });
            expect(cmd.status).toBe(400);
            expect(cmd.json().error.message).toBe('command-widget');

            // a later version keeps the overwrite mark
            await request(t, 'POST', '/v1/entries/alp/mine/versions', {
              token: alp,
              headers: { 'if-match': '"2"' },
              body: { content: preset(), note: 'three' },
            });
            const after = (await request(t, 'GET', '/v1/entries/alp/mine.json')).json();
            expect(after.versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
            expect(after.versions[1].overwrittenAt).toBe('2026-10-16T12:01:00.000Z');
            expect(after.versions[2].overwrittenAt).toBeUndefined();
          },
          ctx,
        ));

      it('overwrite is refused when allowOverwrite is false', () =>
        open({ allowOverwrite: false }, async (t) => {
          expect(t.caps.overwrite).toBe(false);
          const token = await t.signIn('alp');
          await request(t, 'POST', '/v1/entries', { token, body: publishBody('mine') });
          const before = (await request(t, 'GET', '/v1/entries/alp/mine/1.json')).body;
          const r = await request(t, 'PUT', '/v1/entries/alp/mine/versions/1', {
            token,
            body: { content: preset([[{ type: 'cwd' }]]), note: '' },
          });
          expect(r.status).toBe(403);
          expect(r.json()).toEqual({ error: { code: 'overwrite-disabled', message: expect.any(String) } });
          expect((await request(t, 'GET', '/v1/entries/alp/mine/1.json')).body).toBe(before);
          const entry = (await request(t, 'GET', '/v1/entries/alp/mine.json')).json();
          expect(entry.versions).toEqual([
            { version: 1, at: '2026-10-16T12:00:00.000Z', note: 'first', hash: sha(preset()) },
          ]);
        }));
    });

    describe('withdraw', () => {
      it('withdraw tombstones the entry and versions answer 410', () =>
        open({}, async (t) => {
          const alp = await t.signIn('alp');
          const bob = await t.signIn('bob');
          await withTwo(t, alp);
          const other = await request(t, 'DELETE', '/v1/entries/alp/mine', { token: bob });
          expect(other.status).toBe(403);
          expect(other.json().error.code).toBe('forbidden');
          expect((await request(t, 'DELETE', '/v1/entries/alp/mine')).status).toBe(401);
          expect((await request(t, 'DELETE', '/v1/entries/alp/nope', { token: alp })).status).toBe(404);
          expect((await request(t, 'DELETE', '/v1/entries/ALP/mine', { token: alp })).status).toBe(400);

          t.advance(60_000);
          const r = await request(t, 'DELETE', '/v1/entries/alp/mine', { token: alp });
          expect(r.status).toBe(200);
          expect(r.json()).toEqual({ id: 'alp/mine', withdrawn: true });
          const indexRes = await request(t, 'GET', '/v1/index.json');
          expect(parseIndex(indexRes.json())!.entries).toEqual([]);
          const entryRes = await request(t, 'GET', '/v1/entries/alp/mine.json');
          const entry = entryRes.json();
          expect(entry).toMatchObject({ withdrawn: true, withdrawnAt: '2026-10-16T12:01:00.000Z' });
          expect(entry.versions.map((v: any) => v.version)).toEqual([1, 2]);
          // WR-08: no name, description, author or notes stay public
          expect(entry).toMatchObject({
            name: '',
            description: '',
            author: '',
            publisher: 'alp',
            kind: 'preset',
          });
          expect(entry.versions.map((v: any) => v.note)).toEqual(['', '']);
          for (const text of [entryRes.body, indexRes.body]) {
            expect(text).not.toMatch(/Name mine|"desc"|"Alp"|"first"|"two"/);
          }
          for (const n of [1, 2, 3]) {
            const g = await request(t, 'GET', `/v1/entries/alp/mine/${n}.json`);
            expect(g.status, String(n)).toBe(410);
            expect(g.json().error.code).toBe('withdrawn');
          }

          const again = await request(t, 'POST', '/v1/entries', { token: alp, body: publishBody('mine') });
          expect(again.status).toBe(409);
          expect(again.json().error.code).toBe('conflict');
          const v = await request(t, 'POST', '/v1/entries/alp/mine/versions', {
            token: alp,
            headers: { 'if-match': '"2"' },
            body: { content: preset(), note: '' },
          });
          expect(v.status).toBe(410);
          if (t.caps.overwrite) {
            const put = await request(t, 'PUT', '/v1/entries/alp/mine/versions/2', {
              token: alp,
              body: { content: preset(), note: '' },
            });
            expect(put.status).toBe(410);
          }
          if (t.caps.registersAnon) {
            expect((await request(t, 'POST', '/v1/publishers', { body: { handle: 'alp' } })).status).toBe(
              409,
            );
          }

          // repeat withdraw is idempotent
          expect((await request(t, 'DELETE', '/v1/entries/alp/mine', { token: alp })).status).toBe(200);
          expect((await request(t, 'GET', '/v1/index.json')).json().entries).toEqual([]);
          expect((await request(t, 'GET', '/v1/entries/alp/mine.json')).json().withdrawn).toBe(true);
          expect((await request(t, 'GET', '/v1/entries/alp/mine/1.json')).status).toBe(410);
        }));
    });

    describe('limits', () => {
      it('413 over 1 MiB, 415 without JSON', () =>
        open({}, async (t) => {
          const token = await t.signIn('alp');
          const head = '{"pad":"';
          const big = `${head}${'x'.repeat(MARKET_LIMITS.maxBodyBytes + 1 - head.length - 2)}"}`;
          expect(new TextEncoder().encode(big).length).toBe(MARKET_LIMITS.maxBodyBytes + 1);
          const r = await request(t, 'POST', '/v1/entries', { token, body: big });
          expect(r.status).toBe(413);
          expect(r.json().error.code).toBe('too-large');

          const exact = `${head}${'x'.repeat(MARKET_LIMITS.maxBodyBytes - head.length - 2)}"}`;
          const ok = await request(t, 'POST', '/v1/entries', { token, body: exact });
          expect(ok.status).toBe(400);

          for (const type of ['text/plain', 'application/jsonx', 'application/x-www-form-urlencoded', '']) {
            const u = await request(t, 'POST', '/v1/entries', {
              token,
              body: publishBody('mine'),
              headers: { 'content-type': type },
            });
            expect(u.status, type).toBe(415);
            expect(u.json().error.code).toBe('unsupported-media');
          }
          const put = await request(t, 'PUT', '/v1/entries/alp/mine/versions/1', {
            token,
            body: { content: preset(), note: '' },
            headers: { 'content-type': 'text/plain' },
          });
          expect(put.status).toBe(415);
          const charset = await request(t, 'POST', '/v1/entries', {
            token,
            body: publishBody('mine'),
            headers: { 'content-type': 'Application/JSON; charset=utf-8' },
          });
          expect(charset.status).toBe(201);
          expect((await request(t, 'GET', '/v1/entries/alp/mine/1.json')).status).toBe(200);
        }));

      it('caps publishers, entries and entries per publisher', () =>
        open({ caps: { publishers: 2, entries: 3, entriesPerPublisher: 2 } }, async (t) => {
          const a = await t.signIn('alp');
          const b = await t.signIn('bob');
          if (t.caps.registersAnon) {
            const third = await request(t, 'POST', '/v1/publishers', { body: { handle: 'cem' } });
            expect(third.status).toBe(413);
            expect(third.json()).toEqual({ error: { code: 'over-quota', message: 'too many publishers' } });
          }

          for (const s of ['one', 'two']) {
            expect((await request(t, 'POST', '/v1/entries', { token: a, body: publishBody(s) })).status).toBe(
              201,
            );
          }
          const mine = await request(t, 'POST', '/v1/entries', { token: a, body: publishBody('three') });
          expect(mine.status).toBe(413);
          expect(mine.json().error.message).toBe('too many entries for this publisher');
          expect(
            (await request(t, 'POST', '/v1/entries', { token: b, body: publishBody('one') })).status,
          ).toBe(201);
          const full = await request(t, 'POST', '/v1/entries', { token: b, body: publishBody('two') });
          expect(full.status).toBe(413);
          expect(full.json().error.message).toBe('too many entries');
          expect((await request(t, 'GET', '/v1/entries/bob/two.json')).status).toBe(404);

          // IN-09: tombstones do not count, but their slug stays reserved
          expect((await request(t, 'DELETE', '/v1/entries/alp/one', { token: a })).status).toBe(200);
          expect(
            (await request(t, 'POST', '/v1/entries', { token: a, body: publishBody('one') })).status,
          ).toBe(409);
          expect(
            (await request(t, 'POST', '/v1/entries', { token: a, body: publishBody('four') })).status,
          ).toBe(201);
          const again = await request(t, 'POST', '/v1/entries', { token: b, body: publishBody('two') });
          expect(again.json().error.message).toBe('too many entries');
          if (t.caps.registersAnon) {
            expect((await request(t, 'POST', '/v1/publishers', { body: { handle: 'cem' } })).status).toBe(
              413,
            );
          }
        }));

      it('a publish and withdraw loop stops at the tombstone caps', () =>
        open(
          {
            caps: { entriesPerPublisher: 2, tombstonesPerPublisher: 3, tombstones: 5 },
            rateLimit: { perMinute: 1000 },
          },
          async (t) => {
            const a = await t.signIn('alp');
            const b = await t.signIn('bob');
            const loop = async (token: string, who: string, n: number) => {
              for (let i = 0; i < n; i++) {
                const r = await request(t, 'POST', '/v1/entries', { token, body: publishBody(`x${i}`) });
                if (r.status !== 201) return r;
                expect((await request(t, 'DELETE', `/v1/entries/${who}/x${i}`, { token })).status).toBe(200);
              }
              return null;
            };
            const tombs = async (who: string) => {
              const out: string[] = [];
              for (let i = 0; i < 10; i++) {
                const r = await request(t, 'GET', `/v1/entries/${who}/x${i}.json`);
                if (r.status === 200) {
                  expect(r.json().withdrawn).toBe(true);
                  out.push(`x${i}`);
                } else expect(r.status).toBe(404);
              }
              return out;
            };
            const stopped = (await loop(a, 'alp', 10))!;
            expect(stopped.status).toBe(413);
            expect(stopped.json()).toEqual({
              error: { code: 'over-quota', message: 'too many withdrawn entries for this publisher' },
            });
            expect(await tombs('alp')).toEqual(['x0', 'x1', 'x2']);
            expect(
              (await request(t, 'POST', '/v1/entries', { token: a, body: publishBody('y') })).status,
            ).toBe(413);
            // withdraw always works: a live entry may still be withdrawn at the cap
            const g = (await loop(b, 'bob', 10))!;
            expect(g.json().error.message).toBe('too many withdrawn entries');
            expect(await tombs('bob')).toEqual(['x0', 'x1']);
            expect((await request(t, 'GET', '/v1/index.json')).json().entries).toEqual([]);
          },
        ));

      // CR-03: everything the server accepts, the shipped client can read back
      it(
        'serves accepted content up to the content limit and a history up to the document cap',
        () =>
          open({ rateLimit: { perMinute: 100_000 } }, async (t) => {
            const wide = (ch: string, n: number) => ch.repeat(n);
            const anon = client(t);
            const c = client(t, await t.signIn('alp'));
            const widget = (i: number) => ({ id: `w${i}`, type: 'text', options: { text: wide('x', 100) } });
            const lines = [Array.from({ length: 1600 }, (_, i) => widget(i))];
            const big = preset(lines);
            const size = new TextEncoder().encode(canonicalJson(big)).length;
            expect(size).toBeGreaterThan(200 * 1024);
            expect(size).toBeLessThanOrEqual(256 * 1024);
            const pub = await c.publish({
              kind: 'preset',
              slug: 'big',
              name: 'Big',
              description: '',
              author: '',
              content: big,
              note: '',
            });
            const v = await anon.version(pub.id, 1, 'preset', pub.hash);
            expect(v.hash).toBe(contentHash(big));

            const small = preset([[{ type: 'model' }]]);
            let latest = 1;
            let refused: unknown = null;
            for (let i = 0; i < 1000 && !refused; i++) {
              try {
                latest = (
                  await c.addVersion(pub.id, latest, { content: small, note: wide('\u{1F600}', 200) })
                ).version;
              } catch (err) {
                refused = err;
              }
            }
            expect(refused).toMatchObject({ code: 'over-quota', status: 413 });
            expect(latest).toBeGreaterThan(100);
            const entry = await anon.entry(pub.id);
            expect(entry.versions).toHaveLength(latest);
            expect((await anon.version(pub.id, latest, 'preset', contentHash(small))).hash).toBe(
              contentHash(small),
            );
          }),
        60_000,
      );
    });

    describe('rate limits', () => {
      it('429 with retry-after past the write limit, then a new window', (ctx) =>
        open(
          { rateLimit: { perMinute: 3, readsPerMinute: 5 } },
          async (t) => {
            for (const h of ['a', 'b', 'c']) {
              expect((await request(t, 'POST', '/v1/publishers', { body: { handle: h } })).status).toBe(201);
            }
            const over = await request(t, 'POST', '/v1/publishers', { body: { handle: 'd' } });
            expect(over.status).toBe(429);
            expect(over.headers.get('retry-after')).toBe('60');
            expect(over.json().error.code).toBe('rate-limited');
            t.advance(30_000);
            const still = await request(t, 'DELETE', '/v1/entries/a/x');
            expect(still.status).toBe(429);
            expect(still.headers.get('retry-after')).toBe('30');

            // reads have their own budget
            for (let i = 0; i < 5; i++) expect((await request(t, 'GET', '/v1/meta.json')).status).toBe(200);
            const reads = await request(t, 'GET', '/v1/meta.json');
            expect(reads.status).toBe(429);
            expect(reads.headers.get('retry-after')).toBe('30');

            t.advance(30_000);
            // 201, not 409: the refused registration stored nothing
            expect((await request(t, 'POST', '/v1/publishers', { body: { handle: 'd' } })).status).toBe(201);
            expect((await request(t, 'GET', '/v1/meta.json')).status).toBe(200);
          },
          ctx,
          ['rateLimit', 'registersAnon'],
        ));

      it('registration has its own stricter per-IP bucket', (ctx) =>
        open(
          {},
          async (t) => {
            for (const h of ['a', 'b', 'c', 'd', 'e']) {
              expect((await request(t, 'POST', '/v1/publishers', { body: { handle: h } })).status).toBe(201);
            }
            const over = await request(t, 'POST', '/v1/publishers', { body: { handle: 'f' } });
            expect(over.status).toBe(429);
            expect(over.json().error.code).toBe('rate-limited');
            expect(over.headers.get('retry-after')).toBe('60');
            const bad = await request(t, 'POST', '/v1/publishers', { body: { handle: 'BAD' } });
            expect(bad.status).toBe(429);
            // other writes and reads still pass
            expect((await request(t, 'GET', '/v1/meta.json')).status).toBe(200);
            const login = await request(t, 'POST', '/v1/entries', { body: publishBody('x') });
            expect(login.status).toBe(401);
            t.advance(60_000);
            expect((await request(t, 'POST', '/v1/publishers', { body: { handle: 'f' } })).status).toBe(201);
          },
          ctx,
          ['rateLimit', 'registersAnon'],
        ));

      it('the client reports overwrite-disabled and rate-limited with retry-after', (ctx) =>
        open(
          { allowOverwrite: false, rateLimit: { perMinute: 2 } },
          async (t) => {
            const anon = client(t);
            const token = await t.signIn('alp');
            // a fresh window 15 s in, whatever signing in cost
            t.advance(75_000);
            expect((await anon.meta()).capabilities.overwrite).toBe(false);
            const c = client(t, token);
            const one = preset([[{ type: 'model' }]]);
            await c.publish({
              kind: 'preset',
              slug: 'x',
              name: 'X',
              description: '',
              author: '',
              content: one,
              note: '',
            });
            await expect(c.overwrite('alp/x', 1, { content: one, note: '' })).rejects.toMatchObject({
              code: 'overwrite-disabled',
              status: 403,
            });
            const err = await c.withdraw('alp/x').catch((e: unknown) => e);
            expect(err).toMatchObject({ code: 'rate-limited', status: 429 });
            expect((err as { retryAfterMs: number }).retryAfterMs).toBe(45_000);
          },
          ctx,
          ['rateLimit'],
        ));
    });

    describe('routes', () => {
      it('path segments with traversal are rejected', () =>
        open({}, async (t) => {
          const token = await t.signIn('alp');
          await request(t, 'POST', '/v1/entries', { token, body: publishBody('mine') });
          for (const p of [
            '/v1/entries/..%2F..%2Fx.json',
            '/v1/entries/..%2F..%2Fx/1.json',
            '/v1/entries/ALP/mine.json',
            '/v1/entries/alp/MINE.json',
            '/v1/entries/%2E%2E/x.json',
            '/v1/entries/..%5C..%5Cx.json',
            '/v1/entries/alp/..%2F..%2F..%2Fx.json',
            '/v1/entries/alp/mine/0.json',
            '/v1/entries/alp/mine/01.json',
            '/v1/entries/alp/mine/1e3.json',
            '/v1/entries/alp/mine/..%2F..%2F..%2F..%2Fx.json',
            '/v1/entries/alp/%E0%A4%A.json',
            '/v1/../x.json',
            '/x.json',
          ]) {
            const r = await request(t, 'GET', p);
            expect([400, 404], p).toContain(r.status);
            expect(r.body, p).not.toContain('"content"');
            expect(['invalid', 'not-found']).toContain(r.json().error.code);
          }
          const w = await request(t, 'POST', '/v1/entries/..%2F..%2Fprivate/x/versions', {
            token,
            headers: { 'if-match': '"1"' },
            body: { content: preset(), note: '' },
          });
          expect([400, 404]).toContain(w.status);
        }));

      it('answers 404 for unknown routes and methods', () =>
        open({}, async (t) => {
          for (const [m, p] of [
            ['GET', '/v1/entries'],
            ['DELETE', '/v1/index.json'],
            ['PUT', '/v1/meta.json'],
            ['POST', '/v1/index.json'],
            ['GET', '/v2/meta.json'],
          ] as const) {
            const r = await request(t, m, p, m === 'GET' ? {} : { body: {} });
            expect(r.status, `${m} ${p}`).toBe(404);
            expect(r.json().error.code).toBe('not-found');
          }
        }));
    });

    describe('etag', () => {
      it('answers 304 to a matching If-None-Match and changes the tag on a write', (ctx) =>
        open(
          {},
          async (t) => {
            const token = await t.signIn('alp');
            await request(t, 'POST', '/v1/entries', { token, body: publishBody('mine') });
            for (const p of ['/v1/index.json', '/v1/entries/alp/mine.json']) {
              const a = await request(t, 'GET', p);
              const tag = a.headers.get('etag');
              expect(tag, p).toBeTruthy();
              const b = await request(t, 'GET', p, { headers: { 'if-none-match': tag! } });
              expect(b.status, p).toBe(304);
              expect(b.body).toBe('');
            }
            const before = (await request(t, 'GET', '/v1/index.json')).headers.get('etag')!;
            await request(t, 'POST', '/v1/entries', { token, body: publishBody('two') });
            const after = await request(t, 'GET', '/v1/index.json', { headers: { 'if-none-match': before } });
            expect(after.status).toBe(200);
            expect(after.headers.get('etag')).not.toBe(before);
            expect(after.json().entries.map((e: any) => e.id)).toEqual(['alp/mine', 'alp/two']);
          },
          ctx,
          ['etag'],
        ));
    });

    describe('client round trip', () => {
      for (const on of [true, false]) {
        it(`round-trips publish, versions, overwrite and withdraw (overwrite ${on ? 'on' : 'off'})`, () =>
          open({ allowOverwrite: on }, async (t) => {
            const anon = client(t);
            const meta = await anon.meta();
            expect(meta.capabilities).toMatchObject({ write: true, overwrite: on, withdraw: true });
            const token = await account(t, 'alp');
            const c = createMarketClient({ endpoint: `${t.url}/`, fetch: t.fetch, token });

            const one = preset([[{ type: 'model' }]]);
            const pub = await c.publish({
              kind: 'preset',
              slug: 'mine',
              name: 'Mine',
              description: 'first try',
              author: 'Alp',
              content: one,
              note: 'v1',
            });
            expect(pub).toEqual({ id: 'alp/mine', version: 1, hash: contentHash(one) });

            const two = preset([[{ type: 'model' }, { type: 'cwd' }]]);
            expect(await c.addVersion('alp/mine', 1, { content: two, note: 'v2' })).toEqual({
              version: 2,
              hash: contentHash(two),
            });
            await expect(c.addVersion('alp/mine', 1, { content: two, note: '' })).rejects.toMatchObject({
              code: 'stale',
              status: 412,
            });

            const fixed = preset([[{ type: 'model' }, { type: 'git-branch' }]]);
            if (on) {
              expect(await c.overwrite('alp/mine', 2, { content: fixed, note: 'v2 fixed' })).toEqual({
                version: 2,
                hash: contentHash(fixed),
              });
              await expect(c.overwrite('alp/mine', 1, { content: fixed, note: '' })).rejects.toMatchObject({
                code: 'conflict',
              });
            } else {
              await expect(
                c.overwrite('alp/mine', 2, { content: fixed, note: 'v2 fixed' }),
              ).rejects.toMatchObject({
                code: 'overwrite-disabled',
                status: 403,
              });
            }
            const latest = on ? fixed : two;

            const index = await anon.index();
            expect(index.entries).toEqual([
              expect.objectContaining({
                id: 'alp/mine',
                version: 2,
                hash: contentHash(latest),
                publisher: 'alp',
              }),
            ]);
            const entry = await anon.entry('alp/mine');
            expect(entry.versions.map((v) => v.version)).toEqual([1, 2]);
            expect(entry.versions[1]).toMatchObject({
              note: on ? 'v2 fixed' : 'v2',
              hash: contentHash(latest),
            });

            const got = await anon.version('alp/mine', 2, 'preset', contentHash(latest));
            expect(got.hash).toBe(contentHash(latest));
            expect(got.content.layout?.lines).toHaveLength(1);
            expect(got.content.layout?.lines?.[0]?.map((w) => w.type)).toEqual([
              'model',
              on ? 'git-branch' : 'cwd',
            ]);
            expect((await anon.version('alp/mine', 1, 'preset', pub.hash)).hash).toBe(pub.hash);

            await expect(anon.withdraw('alp/mine')).rejects.toMatchObject({ code: 'unauthorized' });
            await c.withdraw('alp/mine');
            await expect(anon.version('alp/mine', 2, 'preset', contentHash(latest))).rejects.toMatchObject({
              code: 'withdrawn',
              status: 410,
            });
            expect((await anon.entry('alp/mine')).withdrawn).toBe(true);
            // tombstones stay out of the public index
            expect((await anon.index()).entries).toEqual([]);
            await expect(
              c.publish({
                kind: 'preset',
                slug: 'mine',
                name: 'Again',
                description: '',
                author: '',
                content: one,
                note: '',
              }),
            ).rejects.toMatchObject({ code: 'conflict' });
          }));
      }

      it('works end to end with the market client', () =>
        open({}, async (t) => {
          const anon = client(t);
          expect((await anon.meta()).capabilities.write).toBe(true);
          const c = client(t, await account(t, 'alp'));
          const content = preset([
            [{ type: 'model' }, { type: 'link', options: { url: 'https://example.com' } }],
          ]);
          const pub = await c.publish({
            kind: 'preset',
            slug: 'mine',
            name: 'Mine',
            description: '',
            author: 'Alp',
            content,
            note: '',
          });
          expect(pub).toEqual({ id: 'alp/mine', version: 1, hash: sha(content) });
          const v2 = await c.addVersion('alp/mine', 1, { content: preset(), note: 'two' });
          expect(v2.version).toBe(2);
          await expect(c.addVersion('alp/mine', 1, { content: preset(), note: '' })).rejects.toMatchObject({
            code: 'stale',
          });
          const entry = await anon.entry('alp/mine');
          expect(entry.versions.map((v) => v.version)).toEqual([1, 2]);
          const got = await anon.version('alp/mine', 1, 'preset', pub.hash);
          expect(got.hash).toBe(pub.hash);
          expect(got.targets.length).toBe(1);
          expect((await anon.index()).entries.map((e) => e.id)).toEqual(['alp/mine']);
        }));
    });
  });
}
