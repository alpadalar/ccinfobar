import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';
import { startMarketServer } from '../../src/market/server.js';
import { fakeFetch, json } from '../fake-fetch.js';

let dir: string;
let handle: EditorHandle;
let port: number;
const saved: Record<string, string | undefined> = {};
const ENV = [
  'CCINFOBAR_CONFIG_DIR',
  'CCINFOBAR_MARKETPLACE_URL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'HOME',
  'USERPROFILE',
];
const servers: { close(): Promise<void> }[] = [];

type Res = { status: number; json: () => Record<string, any> };

function request(method: string, p: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { 'x-ccinfobar-token': handle.token };
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

const config = (lines: Config['lines'] = [[{ id: 'm', type: 'model' }]]) => ({
  ...defaultConfig(),
  lines,
  language: 'tr',
  budget: { daily: 5 },
  profiles: { builtIn: false },
});

async function save(body: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await request('POST', '/api/catalog/save', {
    kind: 'preset',
    name: 'X',
    description: 'my layout',
    author: 'Alp',
    share: true,
    mode: 'new',
    config: config(),
    ...body,
  });
  expect(res.status).toBe(200);
  return res.json().entry;
}

async function market(): Promise<string> {
  const s = await startMarketServer({ dataDir: path.join(dir, `market-${servers.length}`) });
  servers.push(s);
  process.env.CCINFOBAR_MARKETPLACE_URL = s.url;
  return s.url;
}

const plan = async (refs?: string[]) =>
  request('POST', '/api/catalog/publish/plan', refs === undefined ? {} : { refs });

async function publish(refs?: string[]): Promise<Res> {
  const p = (await plan(refs)).json();
  return request('POST', '/api/catalog/publish', {
    ...(refs ? { refs } : {}),
    confirm: true,
    planHash: p.planHash,
  });
}

const stateOf = async (id: string) =>
  ((await request('GET', '/api/catalog')).json().user as any[]).find((e) => e.ref === id)?.share.state;

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-publish-routes-'));
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.HOME = path.join(dir, 'home');
  process.env.USERPROFILE = path.join(dir, 'home');
  delete process.env.CCINFOBAR_MARKETPLACE_URL;
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  handle = await startEditor({ configPath: path.join(dir, 'c.json'), open: false, port: 0 });
  port = Number(new URL(handle.url).port);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await handle.close();
  for (const s of servers.splice(0)) await s.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('editor publish routes', () => {
  it('answers 409 noEndpoint and makes no network call without an endpoint', async () => {
    await save();
    const spy = vi.spyOn(globalThis, 'fetch');
    const before = fs.readdirSync(path.join(dir, 'cfg', 'catalog')).sort();
    const replies = [
      await plan(),
      await request('POST', '/api/catalog/publish', { confirm: true, planHash: 'x' }),
      await request('GET', '/api/catalog/remote'),
      await request('GET', '/api/catalog/remote/alp/x'),
    ];
    for (const r of replies) {
      expect(r.status).toBe(409);
      expect(r.json()).toMatchObject({
        error: 'No marketplace endpoint set; entries stay waiting to publish',
        errorId: 'err.catalog.noEndpoint',
      });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(dir, 'cfg', 'catalog')).sort()).toEqual(before);
  });

  it('shows the exact payloads and sends only with confirm and the same planHash', async () => {
    const url = await market();
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    const e = await save();
    const res = await plan();
    expect(res.status).toBe(200);
    const p = res.json();
    expect(p).toMatchObject({ endpoint: url, notice: 'catalog.publish.where', skipped: [] });
    expect(p.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.plan).toHaveLength(1);
    expect(p.plan[0]).toMatchObject({
      id: e.ref,
      name: 'X',
      kind: 'preset',
      action: 'publish',
      remoteId: null,
    });
    expect(p.plan[0].payload).toMatchObject({ kind: 'preset', slug: 'x', name: 'X', author: 'Alp' });
    const sent = JSON.stringify(p.plan[0].payload);
    for (const bad of ['budget', 'profiles', 'language', dir]) expect(sent).not.toContain(bad);
    expect((await plan()).json().planHash).toBe(p.planHash);

    const unconfirmed = await request('POST', '/api/catalog/publish', { planHash: p.planHash });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.json()).toMatchObject({
      error: 'Confirm the publish first',
      errorId: 'err.catalog.needsConfirm',
    });
    expect((await request('GET', '/api/catalog/remote')).json().entries).toEqual([]);

    const ok = await request('POST', '/api/catalog/publish', { confirm: true, planHash: p.planHash });
    expect(ok.status).toBe(200);
    const body = ok.json();
    expect(body).toMatchObject({ ok: true, code: null });
    expect(body.results).toEqual([
      { id: e.ref, ok: true, code: null, remoteId: 'alp/x', version: 1, errorId: null },
    ]);
    expect(body.catalog.user[0]).toMatchObject({ ref: e.ref, share: { state: 'published' } });
    expect(body.catalog.user[0].remote).toMatchObject({ id: 'alp/x', version: 1 });
    expect((await plan()).json().plan).toEqual([]);
  });

  it('refuses a changed plan with 409 planChanged and sends nothing', async () => {
    await market();
    const e = await save();
    const old = (await plan()).json();
    await save({ mode: 'update', id: e.ref, rev: e.rev, config: config([[{ id: 'c', type: 'clock' }]]) });
    const res = await request('POST', '/api/catalog/publish', { confirm: true, planHash: old.planHash });
    expect(res.status).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({
      error: 'The entries changed since you reviewed them; review again',
      errorId: 'err.catalog.planChanged',
      notice: 'catalog.publish.where',
    });
    expect(body.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.planHash).not.toBe(old.planHash);
    expect(body.plan[0].payload.content).not.toEqual(old.plan[0].payload.content);
    const missing = await request('POST', '/api/catalog/publish', { confirm: true });
    expect(missing.json().errorId).toBe('err.catalog.planChanged');
    expect((await request('GET', '/api/catalog/remote')).json().entries).toEqual([]);
    expect(await stateOf(e.ref)).toBe('pending');
    const again = await request('POST', '/api/catalog/publish', { confirm: true, planHash: body.planHash });
    expect(again.json().results[0]).toMatchObject({ ok: true, remoteId: 'alp/x' });
  });

  it('withdraws an unshared entry', async () => {
    await market();
    const e = await save();
    expect((await publish()).status).toBe(200);
    const off = await request('POST', '/api/catalog/share', { ref: e.ref, share: false });
    expect(off.status).toBe(200);
    const p = (await plan()).json();
    expect(p.plan).toEqual([
      {
        id: e.ref,
        rev: expect.any(Number),
        name: 'X',
        kind: 'preset',
        action: 'withdraw',
        remoteId: 'alp/x',
        payload: null,
      },
    ]);
    const res = await publish();
    expect(res.json().results).toEqual([
      { id: e.ref, ok: true, code: null, remoteId: 'alp/x', version: null, errorId: null },
    ]);
    expect(await stateOf(e.ref)).toBe('withdrawn');
    expect((await request('GET', '/api/catalog/remote')).json().entries).toEqual([]);
  });

  it('limits the plan to the given refs and checks them', async () => {
    await market();
    const a = await save();
    await save({ name: 'Y' });
    const one = (await plan([a.ref])).json();
    expect(one.plan.map((i: any) => i.id)).toEqual([a.ref]);
    const res = await publish([a.ref]);
    expect(res.json().results.map((r: any) => r.id)).toEqual([a.ref]);
    const done = (await plan([a.ref])).json();
    expect(done.plan).toEqual([]);
    expect(done.skipped).toEqual([{ id: a.ref, reason: 'up-to-date' }]);
    expect((await plan(['bundle/nord-minimal'])).json().errorId).toBe('err.catalog.systemReadOnly');
    expect((await plan(['nope'])).json().errorId).toBe('err.catalog.badRef');
    expect((await plan(['u-000000000000'])).status).toBe(404);
    const bad = await request('POST', '/api/catalog/publish/plan', { refs: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.json().errorId).toBe('err.catalog.badRequest');
  });

  it('reports a read-only marketplace and per-entry failure ids', async () => {
    process.env.CCINFOBAR_MARKETPLACE_URL = 'https://market.example.com';
    await save();
    const meta = { protocol: 1, name: 'Pages', capabilities: { write: false, submit: 'pull-request' } };
    const fake = fakeFetch([json({ ...meta, submitUrl: 'https://market.example.com/submit' })]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetch);
    const res = await publish();
    expect(res.json()).toMatchObject({
      ok: true,
      code: 'read-only',
      submitUrl: 'https://market.example.com/submit',
      results: [],
    });
    expect(fake.calls.map((c) => c.method)).toEqual(['GET']);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch([new TypeError('fetch failed')]).fetch);
    const down = await publish();
    expect(down.status).toBe(502);
    expect(down.json()).toMatchObject({ code: 'network', errorId: 'market.error.network' });
  });
});

describe('editor remote browse routes', () => {
  it('lists published entries and shows versions with consent targets', async () => {
    await market();
    await save({
      config: config([[{ id: 'l', type: 'link', options: { url: 'https://example.com/docs' } }]]),
    });
    expect((await publish()).status).toBe(200);
    const list = await request('GET', '/api/catalog/remote');
    expect(list.status).toBe(200);
    expect(list.json().endpoint).toBe(process.env.CCINFOBAR_MARKETPLACE_URL);
    expect(list.json().entries).toEqual([
      expect.objectContaining({
        id: 'alp/x',
        kind: 'preset',
        name: 'X',
        author: 'Alp',
        publisher: 'alp',
        version: 1,
      }),
    ]);
    const show = await request('GET', '/api/catalog/remote/alp/x');
    expect(show.status).toBe(200);
    const body = show.json();
    expect(body.entry).toMatchObject({ id: 'alp/x', version: 1 });
    expect(body.entry.versions).toHaveLength(1);
    expect(body.latest.version).toBe(1);
    expect(body.latest.content.layout.lines[0][0].type).toBe('link');
    expect(body.latest.targets).toEqual([{ kind: 'link', target: 'https://example.com/docs' }]);
    const missing = await request('GET', '/api/catalog/remote/alp/none');
    expect(missing.status).toBe(404);
    expect(missing.json().errorId).toBe('market.error.not-found');
  });

  it('refuses ids that are not publisher/slug before any request', async () => {
    await market();
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const p of ['..%2Fx/y', 'alp', 'alp/x/y', 'Alp/x', '%E0%A4%A/x', 'alp/x%2F..']) {
      const res = await request('GET', `/api/catalog/remote/${p}`);
      expect(res.status, p).toBe(400);
      expect(res.json().errorId, p).toBe('catalog.remote.badId');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
