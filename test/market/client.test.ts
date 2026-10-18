import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import {
  checkEndpoint,
  contentHash,
  createMarketClient,
  MarketError,
  validateReceived,
} from '../../src/market/client.js';
import { canonicalJson, RESPONSE_CAPS } from '../../src/market/protocol.js';
import { fakeFetch, json, redirect, streamed } from '../fake-fetch.js';

const BASE = 'https://m.example';
const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const H = 'a'.repeat(64);
const layout = (items: unknown[]) => ({ lines: [items] });
const preset = (items: unknown[] = [{ id: 'm', type: 'model' }]): EntryContent =>
  ({ layout: layout(items) }) as EntryContent;

function client(steps: Parameters<typeof fakeFetch>[0], extra: Record<string, unknown> = {}) {
  const f = fakeFetch(steps);
  return { c: createMarketClient({ endpoint: BASE, fetch: f.fetch, ...extra }), calls: f.calls };
}

async function failure(p: Promise<unknown>): Promise<MarketError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MarketError);
    return err as MarketError;
  }
  throw new Error('expected a rejection');
}

const summary = (over: Record<string, unknown> = {}) => ({
  id: 'alp/mini',
  kind: 'preset',
  name: 'Mini',
  description: 'small',
  author: 'Alp',
  publisher: 'alp',
  version: 1,
  updatedAt: '2026-10-16T00:00:00Z',
  hash: H,
  ...over,
});

describe('checkEndpoint', () => {
  it('accepts https and loopback http only', () => {
    expect(checkEndpoint('https://m.example')?.href).toBe('https://m.example/');
    expect(checkEndpoint('  https://m.example/market/  ')?.pathname).toBe('/market');
    expect(checkEndpoint('http://m.example')).toBeNull();
    expect(checkEndpoint('http://127.0.0.1:4000')?.port).toBe('4000');
    expect(checkEndpoint('http://localhost:4000')).not.toBeNull();
    expect(checkEndpoint('http://[::1]:4000')).not.toBeNull();
    expect(checkEndpoint('https://u:p@m.example')).toBeNull();
    expect(checkEndpoint('https://u@m.example')).toBeNull();
    expect(checkEndpoint('https://m.example/?q=1')).toBeNull();
    expect(checkEndpoint('https://m.example/#x')).toBeNull();
    expect(checkEndpoint('ftp://m.example')).toBeNull();
    expect(checkEndpoint('file:///tmp/x')).toBeNull();
    expect(checkEndpoint('not a url')).toBeNull();
    expect(checkEndpoint('')).toBeNull();
    expect(checkEndpoint('   ')).toBeNull();
    expect(checkEndpoint(null)).toBeNull();
    expect(checkEndpoint(undefined)).toBeNull();
  });
});

describe('market client', () => {
  it('no endpoint means zero fetch calls (D-09)', () => {
    for (const endpoint of ['', '  ', null, 'http://m.example', 'https://u:p@m.example']) {
      const f = fakeFetch([json({})]);
      let err: unknown;
      try {
        createMarketClient({ endpoint: endpoint as string, fetch: f.fetch });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MarketError);
      expect((err as MarketError).code).toBe('bad-endpoint');
      expect(f.calls).toHaveLength(0);
    }
  });

  it('never reads the environment or the global fetch (D-25)', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '../../src/market/client.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env|globalThis\.fetch|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC/);
    expect(src).not.toMatch(/console\./);
  });

  it('index() GETs the index under the endpoint path and sanitizes summaries', async () => {
    const f = fakeFetch([
      json({
        entries: [summary({ name: 'Mi\u001b[31mni' }), summary({ id: 'BAD' })],
        generatedAt: '2026-10-16',
      }),
    ]);
    const c = createMarketClient({ endpoint: 'https://m.example/market/', fetch: f.fetch });
    expect(c.endpoint).toBe('https://m.example/market');
    const idx = await c.index();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://m.example/market/v1/index.json');
    expect(f.calls[0]!.method).toBe('GET');
    expect(f.calls[0]!.redirect).toBe('manual');
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
    expect(idx.entries.map((e) => [e.id, e.name])).toEqual([['alp/mini', 'Mini']]);
  });

  it('meta() and entry() parse with the protocol parsers', async () => {
    const { c, calls } = client([
      json({ protocol: 1, name: 'Ref', capabilities: { write: true } }),
      json({
        ...summary({ version: 2 }),
        versions: [
          { version: 1, at: 'a', hash: H },
          { version: 2, at: 'b', hash: H },
        ],
      }),
      json({ protocol: 2, name: 'Ref', capabilities: {} }),
      json({ ...summary({ id: 'alp/other' }), versions: [{ version: 1, at: 'a', hash: H }] }),
    ]);
    expect((await c.meta()).capabilities.submit).toBe('api');
    expect((await c.entry('alp/mini')).versions.map((v) => v.version)).toEqual([1, 2]);
    expect((await failure(c.meta())).code).toBe('bad-json');
    expect((await failure(c.entry('alp/mini'))).code).toBe('bad-json');
    expect(calls.map((x) => x.url)).toEqual([
      `${BASE}/v1/meta.json`,
      `${BASE}/v1/entries/alp/mini.json`,
      `${BASE}/v1/meta.json`,
      `${BASE}/v1/entries/alp/mini.json`,
    ]);
  });

  it('bad ids fail with invalid before any call', async () => {
    const { c, calls } = client([]);
    expect((await failure(c.entry('../x'))).code).toBe('invalid');
    expect((await failure(c.version('alp/mini', 0, 'preset', H))).code).toBe('invalid');
    expect((await failure(c.withdraw('a/b/c'))).code).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  it('a version whose hash does not match is rejected', async () => {
    const content = preset();
    const { c, calls } = client([
      json({ version: 1, content, hash: H }),
      json({ version: 1, content, hash: sha(content) }),
    ]);
    expect((await failure(c.version('alp/mini', 1, 'preset', H))).code).toBe('bad-hash');
    const v = await c.version('alp/mini', 1, 'preset', sha(content));
    expect(calls[1]!.url).toBe(`${BASE}/v1/entries/alp/mini/1.json`);
    expect(v.version).toBe(1);
    expect(v.hash).toBe(sha(content));
    expect(v.content.layout?.lines?.[0]?.[0]).toMatchObject({ id: 'm', type: 'model' });
    expect(v.targets).toEqual([]);
    expect(contentHash(content)).toBe(sha(content));
  });

  it('a version that matches itself but not the expected history hash is rejected (WR-10)', async () => {
    const content = preset();
    const other = preset([{ id: 'x', type: 'cwd' }]);
    const { c } = client([json({ version: 1, content, hash: sha(content) })]);
    expect((await failure(c.version('alp/mini', 1, 'preset', sha(other)))).code).toBe('bad-hash');
  });

  it('hashes the parsed content, so served extras fail the check', async () => {
    const content = preset();
    const served = { ...content, extra: { x: 1 } };
    const { c } = client([json({ version: 1, content: served, hash: sha(served) })]);
    expect((await failure(c.version('alp/mini', 1, 'preset', sha(served)))).code).toBe('bad-hash');
  });

  it('a version number other than the one asked for is rejected', async () => {
    const content = preset();
    const { c } = client([json({ version: 2, content, hash: sha(content) })]);
    expect((await failure(c.version('alp/mini', 1, 'preset', sha(content)))).code).toBe('bad-json');
  });

  it('received command, http and env widgets are refused; links become consent targets', async () => {
    for (const type of ['command', 'http', 'env']) {
      const content = preset([{ id: 'x', type, options: { command: 'id', url: 'https://e.example' } }]);
      const { c } = client([json({ version: 1, content, hash: sha(content) })]);
      expect((await failure(c.version('alp/mini', 1, 'preset', sha(content)))).code).toBe('invalid');
    }
    const content = preset([
      { id: 'm', type: 'model' },
      { id: 'l', type: 'link', options: { url: 'https://docs.example/x', text: 'docs' } },
    ]);
    const { c } = client([json({ version: 1, content, hash: sha(content) })]);
    const v = await c.version('alp/mini', 1, 'preset', sha(content));
    expect(v.targets).toEqual([{ kind: 'link', line: 0, index: 1, target: 'https://docs.example/x' }]);
  });

  it('validateReceived normalizes layouts and themes and refuses policy problems', () => {
    const r = validateReceived('bundle', {
      layout: {
        lines: [[{ type: 'model', bogus: 1 }, { type: 'model' }, { id: 'no-type' }]],
        align: 'center',
      },
      appearance: { theme: 'nord', padding: 9 },
      theme: { name: 'T', colors: { fg: 'red', bad: 5 }, style: 'nope' },
    })!;
    expect(r).not.toBeNull();
    expect(r.content.layout).toEqual({
      lines: [
        [
          { id: 'model-0', type: 'model' },
          { id: 'model-1', type: 'model' },
        ],
      ],
      align: 'center',
    });
    expect(r.content.appearance).toEqual({ theme: 'nord', padding: 4 });
    expect(r.content.theme).toEqual({ name: 'T', colors: { fg: 'red' } });
    expect(r.problems).toContain('dropped-widgets');
    expect(validateReceived('preset', { layout: { lines: [[]], budget: { daily: 1 } } })).toBeNull();
    expect(validateReceived('preset', { layout: layout([{ type: 'command' }]) })).toBeNull();
    expect(
      validateReceived('preset', { layout: layout([{ type: 'link', options: { url: 'file:///etc' } }]) }),
    ).toBeNull();
    expect(validateReceived('theme', { appearance: { theme: 'x' } })).toEqual({
      content: { appearance: { theme: 'x' } },
      targets: [],
      problems: [],
    });
    expect(validateReceived('preset', null)).toBeNull();
    expect(validateReceived('preset', [])).toBeNull();
  });

  it('publish() POSTs the payload with the bearer token', async () => {
    const payload = {
      kind: 'preset' as const,
      slug: 'mini',
      name: 'Mini',
      description: '',
      author: 'Alp',
      content: preset(),
      note: 'first',
    };
    const { c, calls } = client([json({ id: 'alp/mini', version: 1, hash: H }, 201)], { token: 'tok-1' });
    expect(await c.publish(payload)).toEqual({ id: 'alp/mini', version: 1, hash: H });
    expect(calls[0]!.url).toBe(`${BASE}/v1/entries`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.authorization).toBe('Bearer tok-1');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.body!)).toEqual(payload);
  });

  it('writes without a token send no authorization header', async () => {
    const { c, calls } = client([json({ handle: 'alp', token: 'b'.repeat(64) }, 201)]);
    expect(await c.register('alp', 'Alp')).toEqual({ handle: 'alp', token: 'b'.repeat(64) });
    expect(calls[0]!.url).toBe(`${BASE}/v1/publishers`);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(calls[0]!.body!)).toEqual({ handle: 'alp', displayName: 'Alp' });
  });

  it('a malformed write answer fails with bad-json', async () => {
    const { c } = client([
      json({ handle: 'alp', token: 'x\ny' }, 201),
      json({ id: 'nope', version: 1, hash: H }, 201),
      json({ version: 0, hash: H }, 201),
    ]);
    expect((await failure(c.register('alp', 'Alp'))).code).toBe('bad-json');
    const p = {
      kind: 'preset' as const,
      slug: 's',
      name: 'n',
      description: '',
      author: '',
      content: preset(),
      note: '',
    };
    expect((await failure(c.publish(p))).code).toBe('bad-json');
    expect((await failure(c.addVersion('alp/s', 1, { content: preset(), note: '' }))).code).toBe('bad-json');
  });

  it('addVersion sends if-match; a 412 stale maps to stale with status', async () => {
    const { c, calls } = client(
      [json({ version: 4, hash: H }, 201), json({ error: { code: 'stale', message: 'newer exists' } }, 412)],
      { token: 'tok-1' },
    );
    expect(await c.addVersion('alp/mini', 3, { content: preset(), note: 'n' })).toEqual({
      version: 4,
      hash: H,
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/entries/alp/mini/versions`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['if-match']).toBe('"3"');
    const err = await failure(c.addVersion('alp/mini', 3, { content: preset(), note: 'n' }));
    expect(err.code).toBe('stale');
    expect(err.status).toBe(412);
    expect(err.message).toBe('stale');
  });

  it('overwrite PUTs the version and withdraw DELETEs the entry', async () => {
    const { c, calls } = client(
      [json({ version: 2, hash: H }), new Response(null, { status: 204 }), json({ ok: true })],
      { token: 'tok-1' },
    );
    expect(await c.overwrite('alp/mini', 2, { content: preset(), note: '' })).toEqual({
      version: 2,
      hash: H,
    });
    await c.withdraw('alp/mini');
    await c.withdraw('alp/mini');
    expect(calls.map((x) => [x.method, x.url])).toEqual([
      ['PUT', `${BASE}/v1/entries/alp/mini/versions/2`],
      ['DELETE', `${BASE}/v1/entries/alp/mini`],
      ['DELETE', `${BASE}/v1/entries/alp/mini`],
    ]);
    expect(calls[0]!.headers['if-match']).toBeUndefined();
  });

  it('a POST answered by a redirect fails after one call', async () => {
    const { c, calls } = client([redirect(`${BASE}/elsewhere`)], { token: 'tok-1' });
    const p = {
      kind: 'preset' as const,
      slug: 's',
      name: 'n',
      description: '',
      author: '',
      content: preset(),
      note: '',
    };
    expect((await failure(c.publish(p))).code).toBe('redirect');
    expect(calls).toHaveLength(1);
  });

  it('redirects are same-origin, max 3, never on writes', async () => {
    const cross = client([redirect('https://other.example/v1/index.json')]);
    expect((await failure(cross.c.index())).code).toBe('redirect');
    const many = client([redirect('/a'), redirect('/b'), redirect('/c'), redirect('/d')]);
    expect((await failure(many.c.index())).code).toBe('too-many-redirects');
    expect(many.calls).toHaveLength(4);
  });

  it('a 429 carries rate-limited and retryAfterMs', async () => {
    const { c } = client([
      new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
      json({ error: { code: 'rate-limited' } }, 429, { 'retry-after': '5' }),
    ]);
    const a = await failure(c.index());
    expect([a.code, a.status, a.retryAfterMs]).toEqual(['rate-limited', 429, 30_000]);
    const b = await failure(c.index());
    expect([b.code, b.retryAfterMs]).toEqual(['rate-limited', 5000]);
  });

  it('statuses without a known code map to fixed codes', async () => {
    const { c } = client([
      new Response('nope', { status: 404 }),
      json({ error: { code: 'weird-code' } }, 500),
      json({ error: { code: 'withdrawn' } }, 410),
      new Response('x', { status: 503 }),
    ]);
    expect((await failure(c.index())).code).toBe('not-found');
    const e500 = await failure(c.index());
    expect([e500.code, e500.status]).toEqual(['http', 500]);
    expect((await failure(c.index())).code).toBe('withdrawn');
    expect((await failure(c.index())).code).toBe('http');
  });

  it('responses over the cap fail with too-large', async () => {
    const big = streamed(['{"entries":[', `"${'x'.repeat(300 * 1024)}"`, ']}']);
    const { c } = client([new Response(big.body, { status: 200 }), json({ entries: [] })], { capBytes: 8 });
    expect((await failure(c.index())).code).toBe('too-large');
    expect((await failure(c.index())).code).toBe('too-large');
    const d = client([new Response(streamed([`{"entries":[],"x":"${'y'.repeat(1025 * 1024)}"}`]).body)]);
    expect((await failure(d.c.index())).code).toBe('too-large');
  });

  it('caps each document by kind: index pages 1 MiB, entries and versions 320 KiB, others 256 KiB', async () => {
    const pad = (n: number) => 'y'.repeat(n * 1024);
    const ok = client([json({ entries: [], x: pad(900) })]);
    expect((await ok.c.index()).entries).toEqual([]);
    const meta = client([json({ protocol: 1, name: 'm', capabilities: {}, x: pad(300) })]);
    expect((await failure(meta.c.meta())).code).toBe('too-large');
    const big = client([json({ version: 1, hash: 'a'.repeat(64), content: {}, x: pad(330) })]);
    expect((await failure(big.c.version('a/b', 1, 'preset', H))).code).toBe('too-large');
    const fitting = client([json({ version: 1, hash: 'a'.repeat(64), content: {}, x: pad(300) })]);
    expect((await failure(fitting.c.version('a/b', 1, 'preset', H))).code).not.toBe('too-large');
    expect(RESPONSE_CAPS).toEqual({ index: 1024 * 1024, document: (256 + 64) * 1024 });
  });

  it('timeouts fail with a fixed code', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    const { c } = client([hang], { timeoutMs: 20 });
    expect((await failure(c.index())).code).toBe('timeout');
  });

  it('bad JSON and network failures map to codes', async () => {
    const { c } = client([
      new Response('{nope', { status: 200 }),
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
    ]);
    expect((await failure(c.index())).code).toBe('bad-json');
    expect((await failure(c.index())).code).toBe('network');
    expect((await failure(c.index())).code).toBe('network');
  });

  it('a token that cannot be a header value fails before any call', async () => {
    const { c, calls } = client([], { token: 'tok\nevil' });
    expect((await failure(c.withdraw('alp/mini'))).code).toBe('unauthorized');
    expect(calls).toHaveLength(0);
  });

  it('error bodies map to protocol codes without echoing URLs or tokens', async () => {
    const token = 'tok-SECRET-0123456789';
    const host = 'secret-host.example';
    const leak = `LEAKED ${token} https://${host}/v1`;
    const f = fakeFetch([
      json({ error: { code: 'unauthorized', message: leak } }, 401),
      json({ error: { code: leak, message: leak } }, 500),
      new TypeError(`fetch failed for https://${host}/v1/entries ${token}`),
      Object.assign(new Error(leak), { name: 'TimeoutError' }),
      new Response(leak, { status: 200 }),
      redirect(`https://evil.example/${token}`),
    ]);
    const c = createMarketClient({ endpoint: `https://${host}/`, fetch: f.fetch, token });
    const errs: MarketError[] = [];
    errs.push(await failure(c.withdraw('alp/mini')));
    errs.push(await failure(c.withdraw('alp/mini')));
    errs.push(await failure(c.withdraw('alp/mini')));
    errs.push(await failure(c.withdraw('alp/mini')));
    errs.push(await failure(c.index()));
    errs.push(await failure(c.index()));
    expect(errs.map((e) => e.code)).toEqual([
      'unauthorized',
      'http',
      'network',
      'timeout',
      'bad-json',
      'redirect',
    ]);
    for (const e of errs) {
      const all = [e.message, String(e), JSON.stringify(e), e.stack ?? '', String(e.cause ?? '')].join('\n');
      for (const secret of [token, host, 'LEAKED', 'evil.example']) expect(all).not.toContain(secret);
      expect(e.message).toBe(e.code);
    }
    try {
      createMarketClient({ endpoint: `http://${token}.example`, fetch: f.fetch });
    } catch (e) {
      expect(String(e)).not.toContain(token);
    }
  });
});

describe('market client accounts, admin and conditional reads', () => {
  // fixtures only; never shaped like real provider tokens
  const GH = 'test_github_token_aaaaaaaaaaaa';
  const MINE = 'c'.repeat(64);
  const doc = (over: Record<string, unknown> = {}) => ({
    ...summary(over),
    versions: [{ version: 1, at: 'a', hash: H }],
  });
  const noAuth = (calls: { headers: Record<string, string> }[]) =>
    calls.map((x) => x.headers.authorization ?? null);

  it('public reads never send the token; /v1/me and admin reads do', async () => {
    const content = preset();
    const { c, calls } = client(
      [
        json({ entries: [summary()] }),
        json(doc()),
        json({ version: 1, hash: sha(content), content }),
        json({ handle: 'alp', displayName: 'Alp', login: 'alp', entries: [] }),
        json({ entries: [] }),
        json({ reports: [] }),
      ],
      { token: 'tok-1' },
    );
    await c.index();
    await c.entry('alp/mini');
    await c.version('alp/mini', 1, 'preset', sha(content));
    expect(noAuth(calls)).toEqual([null, null, null]);
    expect((await c.me()).handle).toBe('alp');
    expect(await c.admin.pending()).toEqual([]);
    expect(await c.admin.reports()).toEqual([]);
    expect(calls.slice(3).map((x) => [x.method, x.url, x.headers.authorization])).toEqual([
      ['GET', `${BASE}/v1/me`, 'Bearer tok-1'],
      ['GET', `${BASE}/v1/admin/pending`, 'Bearer tok-1'],
      ['GET', `${BASE}/v1/admin/reports`, 'Bearer tok-1'],
    ]);
  });

  it('account calls without a token fail before any request', async () => {
    const { c, calls } = client([]);
    for (const p of [c.me(), c.logout(), c.admin.pending(), c.admin.reject('alp/mini'), c.admin.resolve(1)]) {
      expect((await failure(p)).code).toBe('unauthorized');
    }
    expect(calls).toHaveLength(0);
  });

  it('signIn posts the GitHub token once in the body, without authorization', async () => {
    const { c, calls } = client(
      [
        json({ handle: 'alp', token: MINE, displayName: 'Alp', admin: true }),
        json({ handle: 'alp', token: 'short' }),
      ],
      { token: 'tok-1' },
    );
    expect(await c.signIn(GH)).toEqual({ handle: 'alp', token: MINE, displayName: 'Alp', admin: true });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/github`);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.body).toBe(JSON.stringify({ token: GH }));
    const err = await failure(c.signIn(GH));
    expect(err.code).toBe('bad-json');
    expect([err.message, String(err), JSON.stringify(err), err.stack ?? ''].join('\n')).not.toContain(GH);
    expect(JSON.stringify(c)).not.toContain(GH);
  });

  it('signIn refuses a token that cannot be a GitHub token before any request', async () => {
    const { c, calls } = client([]);
    for (const bad of ['', 'short', `${GH}\n`, 'x'.repeat(256), 'has space in it 12345678']) {
      expect((await failure(c.signIn(bad))).code).toBe('invalid');
    }
    expect(calls).toHaveLength(0);
  });

  it('sign-in answers map to their codes', async () => {
    const { c } = client([
      json({ error: { code: 'unavailable', message: 'sign-in is not configured' } }, 503),
      json({ error: { code: 'upstream', message: 'GitHub down' } }, 502),
      json({ error: { code: 'banned', message: 'publisher is banned' } }, 403),
      json({ error: { code: 'unauthorized' } }, 401),
    ]);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await failure(c.signIn(GH))).code);
    expect(codes).toEqual(['unavailable', 'upstream', 'banned', 'unauthorized']);
  });

  it('logout posts with the token and accepts 204', async () => {
    const { c, calls } = client([new Response(null, { status: 204 })], { token: 'tok-1' });
    await c.logout();
    expect([calls[0]!.method, calls[0]!.url, calls[0]!.headers.authorization]).toEqual([
      'POST',
      `${BASE}/v1/auth/logout`,
      'Bearer tok-1',
    ]);
  });

  it('write results carry pending only when the server holds the entry', async () => {
    const payload = {
      kind: 'preset' as const,
      slug: 'mini',
      name: 'Mini',
      description: '',
      author: 'Alp',
      content: preset(),
      note: '',
    };
    const { c } = client(
      [
        json({ id: 'alp/mini', version: 1, hash: H, pending: true }, 201),
        json({ id: 'alp/mini', version: 1, hash: H }, 201),
        json({ id: 'alp/mini', version: 1, hash: H, pending: 'yes' }, 201),
        json({ version: 2, hash: H, pending: true }, 201),
        json({ version: 2, hash: H, pending: true }),
      ],
      { token: 'tok-1' },
    );
    expect(await c.publish(payload)).toEqual({ id: 'alp/mini', version: 1, hash: H, pending: true });
    const plain = await c.publish(payload);
    expect(plain).toEqual({ id: 'alp/mini', version: 1, hash: H });
    expect(Object.hasOwn(plain, 'pending')).toBe(false);
    expect(Object.hasOwn(await c.publish(payload), 'pending')).toBe(false);
    expect((await c.addVersion('alp/mini', 1, { content: preset(), note: '' })).pending).toBe(true);
    expect((await c.overwrite('alp/mini', 2, { content: preset(), note: '' })).pending).toBe(true);
  });

  it('indexIfChanged sends one conditional request and stops on 304', async () => {
    const { c, calls } = client([new Response(null, { status: 304, headers: { etag: '"g4"' } })]);
    expect(await c.indexIfChanged('"g4"')).toEqual({ changed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/index.json`);
    expect(calls[0]!.headers['if-none-match']).toBe('"g4"');
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('indexIfChanged walks the pages on 200 and returns the page 1 tag', async () => {
    const { c, calls } = client(
      [
        json({ entries: [summary()], next: 'index-2.json', generatedAt: 'g' }, 200, { etag: '"g5"' }),
        json({ entries: [summary({ id: 'alp/two' })] }, 200, { etag: '"g5-2"' }),
      ],
      { token: 'tok-1' },
    );
    const r = await c.indexIfChanged('"g4"');
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.etag).toBe('"g5"');
    expect(r.index.entries.map((e) => e.id)).toEqual(['alp/mini', 'alp/two']);
    expect(r.index.generatedAt).toBe('g');
    expect(calls.map((x) => [x.url, x.headers['if-none-match'] ?? null])).toEqual([
      [`${BASE}/v1/index.json`, '"g4"'],
      [`${BASE}/v1/index-2.json`, null],
    ]);
    expect(noAuth(calls)).toEqual([null, null]);
  });

  it('indexIfChanged without a usable tag reads unconditionally; a bad server tag is dropped', async () => {
    const { c, calls } = client([
      json({ entries: [] }, 200, { etag: '"ok"' }),
      json({ entries: [] }, 200, { etag: 'no quotes' }),
      json({ entries: [] }),
    ]);
    expect(await c.indexIfChanged(null)).toEqual({
      changed: true,
      index: { entries: [], generatedAt: '' },
      etag: '"ok"',
    });
    expect(await c.indexIfChanged('bad\ttag')).toMatchObject({ changed: true, etag: null });
    expect(await c.indexIfChanged('"x"')).toMatchObject({ changed: true, etag: null });
    expect(calls.map((x) => x.headers['if-none-match'] ?? null)).toEqual([null, null, '"x"']);
  });

  it('entryIfChanged revalidates with one conditional request', async () => {
    const { c, calls } = client([
      new Response(null, { status: 304 }),
      json(doc(), 200, { etag: '"e2"' }),
      json(doc({ id: 'alp/other' }), 200, { etag: '"e3"' }),
    ]);
    expect(await c.entryIfChanged('alp/mini', '"e1"')).toEqual({ changed: false });
    expect(calls).toHaveLength(1);
    const r = await c.entryIfChanged('alp/mini', '"e1"');
    expect(r).toMatchObject({ changed: true, etag: '"e2"', entry: { id: 'alp/mini', version: 1 } });
    expect((await failure(c.entryIfChanged('alp/mini', '"e2"'))).code).toBe('bad-json');
    expect(calls.map((x) => [x.url, x.headers['if-none-match']])).toEqual([
      [`${BASE}/v1/entries/alp/mini.json`, '"e1"'],
      [`${BASE}/v1/entries/alp/mini.json`, '"e1"'],
      [`${BASE}/v1/entries/alp/mini.json`, '"e2"'],
    ]);
    expect((await failure(c.entryIfChanged('../x', null))).code).toBe('invalid');
    expect(calls).toHaveLength(3);
  });

  it('admin and moderation codes map from the error body', async () => {
    const { c } = client(
      [
        json({ error: { code: 'not-admin', message: 'admins only' } }, 403),
        json({ error: { code: 'banned' } }, 403),
        json({ error: { code: 'forbidden', message: 'new content waits until an admin approves' } }, 403),
      ],
      { token: 'tok-1' },
    );
    const a = await failure(c.admin.pending());
    expect([a.code, a.status]).toEqual(['not-admin', 403]);
    expect((await failure(c.admin.reports())).code).toBe('banned');
    expect((await failure(c.addVersion('alp/mini', 1, { content: preset(), note: '' }))).code).toBe(
      'forbidden',
    );
  });

  it('report passes the reason through and returns the report id', async () => {
    const reason = 'r'.repeat(300);
    const { c, calls } = client([json({ id: 7 }, 201), json({ id: 'x' }, 201)], { token: 'tok-1' });
    expect(await c.report('alp/mini', reason)).toEqual({ id: 7 });
    expect([calls[0]!.method, calls[0]!.url, calls[0]!.headers.authorization]).toEqual([
      'POST',
      `${BASE}/v1/entries/alp/mini/reports`,
      'Bearer tok-1',
    ]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ reason });
    expect((await failure(c.report('alp/mini', 'x'))).code).toBe('bad-json');
  });

  it('admin review returns the content and its tag; approve sends the tag as If-Match', async () => {
    const content = preset();
    const { c, calls } = client(
      [
        json({ entry: { ...doc(), state: 'pending' }, content, hash: H }, 200, { etag: `"${H}-3"` }),
        json({ id: 'alp/mini', approved: true }),
        json({ id: 'alp/mini', rejected: true }),
        json({ id: 'alp/mini', removed: true }),
        json({ handle: 'bob', banned: true }),
        json({ handle: 'bob', banned: false }),
        json({ id: 4, resolved: true }),
      ],
      { token: 'tok-1' },
    );
    const r = await c.admin.review('alp/mini');
    expect(r.entry.state).toBe('pending');
    expect(r.content).toEqual(content);
    expect(r.etag).toBe(`"${H}-3"`);
    await c.admin.approve('alp/mini', r.etag!, 'looks fine');
    await c.admin.reject('alp/mini');
    await c.admin.remove('alp/mini', 'spam');
    await c.admin.ban('bob', 'abuse');
    await c.admin.unban('bob');
    await c.admin.resolve(4);
    expect(calls.map((x) => [x.method, x.url.slice(BASE.length), x.body ?? null])).toEqual([
      ['GET', '/v1/admin/entries/alp/mini', null],
      ['POST', '/v1/admin/entries/alp/mini/approve', '{"note":"looks fine"}'],
      ['POST', '/v1/admin/entries/alp/mini/reject', '{}'],
      ['POST', '/v1/admin/entries/alp/mini/remove', '{"note":"spam"}'],
      ['POST', '/v1/admin/publishers/bob/ban', '{"note":"abuse"}'],
      ['POST', '/v1/admin/publishers/bob/unban', '{}'],
      ['POST', '/v1/admin/reports/4/resolve', '{}'],
    ]);
    expect(calls[1]!.headers['if-match']).toBe(`"${H}-3"`);
    expect(calls.every((x) => x.headers.authorization === 'Bearer tok-1')).toBe(true);
  });

  it('admin review of another id or a bad document fails with bad-json', async () => {
    const content = preset();
    const { c } = client(
      [
        json({ entry: { ...doc({ id: 'alp/other' }), state: 'pending' }, content, hash: H }),
        json({ entry: { ...doc(), state: 'gone' }, content, hash: H }),
      ],
      { token: 'tok-1' },
    );
    expect((await failure(c.admin.review('alp/mini'))).code).toBe('bad-json');
    expect((await failure(c.admin.review('alp/mini'))).code).toBe('bad-json');
  });

  it('bad ids, handles, report ids and tags fail with invalid before any request', async () => {
    const { c, calls } = client([], { token: 'tok-1' });
    const bad = [
      c.report('../x', 'r'),
      c.admin.review('nope'),
      c.admin.approve('alp/mini', 'no-quotes'),
      c.admin.approve('a/../b', `"${H}-1"`),
      c.admin.reject('ALP/mini'),
      c.admin.remove(''),
      c.admin.ban('Bad Handle'),
      c.admin.unban('../x'),
      c.admin.resolve(0),
      c.admin.resolve(1.5),
    ];
    for (const p of bad) expect((await failure(p)).code).toBe('invalid');
    expect(calls).toHaveLength(0);
  });
});
