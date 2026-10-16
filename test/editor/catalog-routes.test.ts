import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemEntries } from '../../src/catalog/system.js';
import { defaultConfig } from '../../src/core/config.js';
import { bundleText } from '../../src/core/i18n/catalog-text.js';
import type { Config } from '../../src/core/types.js';
import { stripAnsi, visibleWidth } from '../../src/core/width.js';
import { gsdInstalled } from '../../src/data/gsd.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';
import { withLang } from '../helpers.js';

let dir: string;
let file: string;
let handle: EditorHandle;
let port: number;
const saved: Record<string, string | undefined> = {};
const ENV = ['CCINFOBAR_CONFIG_DIR', 'CCINFOBAR_MARKETPLACE_URL', 'HOME', 'USERPROFILE'];

type Res = { status: number; body: string; json: () => Record<string, any> };

function request(
  method: string,
  p: string,
  opts: { body?: unknown; headers?: Record<string, string>; token?: boolean } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== false) headers['x-ccinfobar-token'] = handle.token;
  const text = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (text !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

const enc = encodeURIComponent;
const catalog = async (q = '') => (await request('GET', `/api/catalog${q}`)).json();

function save(body: Record<string, unknown>): Promise<Res> {
  return request('POST', '/api/catalog/save', {
    body: {
      kind: 'bundle',
      name: 'Look',
      description: 'Mine',
      author: '',
      share: true,
      mode: 'new',
      config: oneLine(),
      ...body,
    },
  });
}

async function saveLegacyPreset(id: string, config: unknown = { lines: oneLine().lines }): Promise<void> {
  const res = await request('POST', '/api/presets', { body: { preset: { id, name: 'Old one' }, config } });
  expect(res.status).toBe(200);
}

const oneLine = (): Config => ({ ...defaultConfig(), lines: [[{ id: 'model-1', type: 'model' }]] });
const twoLines = (): Config => ({
  ...oneLine(),
  lines: [...oneLine().lines, [{ id: 'clock-1', type: 'clock' }]],
});

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-catalog-routes-'));
  file = path.join(dir, 'c.json');
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.HOME = path.join(dir, 'home');
  process.env.USERPROFILE = path.join(dir, 'home');
  delete process.env.CCINFOBAR_MARKETPLACE_URL;
  handle = await startEditor({ configPath: file, open: false, port: 0 });
  port = Number(new URL(handle.url).port);
});

afterEach(async () => {
  await handle.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const cfgDir = () => process.env.CCINFOBAR_CONFIG_DIR!;

describe('editor catalog routes: list, entry and previews', () => {
  it('GET /api/catalog returns system, user, profile and endpoint', async () => {
    await saveLegacyPreset('old');
    expect((await save({})).status).toBe(200);
    const body = await catalog();
    expect(Object.keys(body).sort()).toEqual(['endpoint', 'profile', 'publishable', 'system', 'user']);
    expect(body.user).toHaveLength(2);
    expect(body.user[0]).toMatchObject({ source: 'user', kind: 'bundle', name: 'Look', version: 1 });
    expect(body.user[0].ref).toMatch(/^u-[0-9a-f]{12}$/);
    expect(body.user[0].share).toEqual({ wanted: true, state: 'pending' });
    expect(body.user[1]).toMatchObject({
      ref: 'legacy:preset/old',
      source: 'legacy',
      id: 'old',
      // the editor's preset save keeps the theme (D-22)
      kind: 'bundle',
      name: 'Old one',
      rev: null,
      share: null,
    });
    const gsd = gsdInstalled();
    expect(body.system).toHaveLength(systemEntries({ gsd }).length);
    if (gsd) expect(body.system).toHaveLength(61);
    expect(body.profile).toEqual({ author: '' });
    expect(body.endpoint).toBeNull();
    expect(body.publishable).toBe(false);
    for (const s of [...body.user, ...body.system]) {
      expect(s.content).toBeTypeOf('object');
      expect(Object.keys(s).sort()).toEqual(
        [
          'author',
          'content',
          'description',
          'id',
          'kind',
          'name',
          'ref',
          'remote',
          'rev',
          'scenario',
          'share',
          'source',
          'updatedAt',
          'version',
        ].sort(),
      );
    }
    const nord = body.system.find((s: { ref: string }) => s.ref === 'bundle/nord-minimal');
    expect(nord).toMatchObject({ source: 'system', author: 'ccinfobar', version: 1, rev: null });
    expect(nord.content.appearance.theme).toBe('nord');
    const limits = body.system.find((s: { ref: string }) => s.ref === 'bundle/tokyo-night-limits');
    expect(limits.scenario).toBe('near-5h-limit');
  });

  it('shows the endpoint once one is set', async () => {
    process.env.CCINFOBAR_MARKETPLACE_URL = 'https://market.example.com';
    const body = await catalog();
    expect(body.endpoint).toBe('https://market.example.com');
    expect(body.publishable).toBe(true);
  });

  it('localizes system text under the config language and keeps the keys', async () => {
    const en = await catalog();
    fs.writeFileSync(file, JSON.stringify({ language: 'tr', lines: [] }));
    const tr = await catalog();
    const pick = (b: Record<string, any>) =>
      b.system.find((s: { ref: string }) => s.ref === 'bundle/catppuccin-cockpit');
    const sys = { id: 'catppuccin-cockpit', name: 'Mocha cockpit', description: '' };
    expect(pick(tr).name).toBe(withLang('tr', () => bundleText(sys, 'name')));
    expect(pick(tr).name).not.toBe(pick(en).name);
    expect(Object.keys(pick(tr))).toEqual(Object.keys(pick(en)));
    expect(Object.keys(tr)).toEqual(Object.keys(en));
    expect(pick(await catalog('?lang=en')).name).toBe(pick(en).name);
  });

  it('sanitizes user text', async () => {
    const res = await save({ name: 'Look', description: 'a\u001b[31mred\u0007', author: 'A\u009bb' });
    expect(res.status).toBe(200);
    const [mine] = (await catalog()).user;
    expect(mine.description).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(mine.author).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('GET /api/catalog/entries/<id> returns every version with content', async () => {
    const first = (await save({})).json();
    const id = first.entry.id;
    const next = await save({ mode: 'update', id, rev: first.entry.rev, note: 'two', config: twoLines() });
    expect(next.status).toBe(200);
    const res = await request('GET', `/api/catalog/entries/${id}`);
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.entry).toMatchObject({ ref: id, version: 2 });
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(body.versions[1]).toMatchObject({ note: 'two', restoredFrom: null, overwrittenAt: null });
    expect(body.versions[0].content.layout.lines).toHaveLength(1);
    expect(body.versions[1].content.layout.lines).toHaveLength(2);
    expect(typeof body.versions[0].at).toBe('string');

    const sys = (await request('GET', `/api/catalog/entries/${enc('bundle/nord-minimal')}`)).json();
    expect(sys.entry.ref).toBe('bundle/nord-minimal');
    expect(sys.versions).toHaveLength(1);
    expect(sys.versions[0]).toMatchObject({ version: 1, at: null, note: '' });
    expect(sys.versions[0].content.appearance.theme).toBe('nord');

    await saveLegacyPreset('old');
    const legacy = await request('GET', `/api/catalog/entries/${enc('legacy:preset/old')}`);
    expect(legacy.json().versions).toHaveLength(1);
  });

  it('answers 400 for a bad id and 404 for an unknown one', async () => {
    for (const bad of ['%2e%2e%2f', 'u-123', '..%2Fx', '%E0%A4%A']) {
      const res = await request('GET', `/api/catalog/entries/${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.json().errorId).toBe('err.catalog.badId');
    }
    for (const ref of ['u-000000000000', 'bundle/nope', 'legacy:preset/nope']) {
      const res = await request('GET', `/api/catalog/entries/${enc(ref)}`);
      expect(res.status, ref).toBe(404);
      expect(res.json()).toMatchObject({ errorId: 'err.catalog.unknownRef', errorParams: { ref } });
    }
  });

  it('POST /api/catalog/previews renders a batch', async () => {
    const mine = (await save({ config: { ...defaultConfig(), theme: 'nord', separator: '|' } })).json();
    const refs = ['bundle/nord-minimal', 'preset/compact', 'theme/dracula', 'nope/x', mine.entry.id];
    const res = await request('POST', '/api/catalog/previews', {
      body: { config: defaultConfig(), width: 120, refs },
    });
    expect(res.status).toBe(200);
    const { previews } = res.json();
    expect(Object.keys(previews).sort()).toEqual(refs.filter((r) => r !== 'nope/x').sort());
    for (const lines of Object.values(previews) as string[][]) {
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('')).not.toBe('');
    }
  });

  it('previews preset entries with the current theme and themes with the current layout', async () => {
    const config = { ...defaultConfig(), theme: 'dracula' };
    const body = (refs: string[], c: Config = config) => ({ body: { config: c, width: 120, refs } });
    const a = (await request('POST', '/api/catalog/previews', body(['preset/compact']))).json();
    const b = (await request('POST', '/api/catalog/previews', body(['bundle/mono-compact']))).json();
    expect(a.previews['preset/compact']).not.toEqual(b.previews['bundle/mono-compact']);
    const two = twoLines();
    const t = (await request('POST', '/api/catalog/previews', body(['theme/nord'], two))).json();
    expect(t.previews['theme/nord']).toHaveLength(2);
  });

  it('previews built-in labels in the UI language', async () => {
    const body = (lang: string) => ({
      body: { config: defaultConfig(), width: 200, refs: ['preset/cockpit'], lang },
    });
    const text = async (lang: string) =>
      stripAnsi(
        (
          (await request('POST', '/api/catalog/previews', body(lang))).json().previews[
            'preset/cockpit'
          ] as string[]
        ).join('\n'),
      );
    expect(await text('tr')).toContain('Süre: ');
    expect(await text('en')).toContain('Elapsed: ');
  });

  it('cuts the ref list at 100 and clamps the width', async () => {
    const refs = [...Array.from({ length: 99 }, (_, i) => `nope/x${i}`), 'theme/nord', 'theme/dracula'];
    const cut = await request('POST', '/api/catalog/previews', {
      body: { config: defaultConfig(), width: 120, refs },
    });
    expect(Object.keys(cut.json().previews)).toEqual(['theme/nord']);
    const flex: Config = {
      ...defaultConfig(),
      lines: [
        [
          { id: 'm', type: 'model' },
          { id: 'f', type: 'flex' },
          { id: 'c', type: 'text', options: { text: 'end' } },
        ],
      ],
    };
    const at = async (width: unknown) =>
      (
        await request('POST', '/api/catalog/previews', {
          body: { config: flex, width, refs: ['theme/nord'] },
        })
      ).json().previews['theme/nord'] as string[];
    const wide = await at(9999);
    expect(visibleWidth(wide[0]!)).toBeGreaterThan(300);
    expect(visibleWidth(wide[0]!)).toBeLessThanOrEqual(400);
    expect(wide).toEqual(await at(400));
    expect(await at(1)).toEqual(await at(20));
    const all = await request('POST', '/api/catalog/previews', { body: { config: defaultConfig() } });
    expect(Object.keys(all.json().previews).length).toBe(Math.min(100, (await catalog()).system.length));
  });

  it('routes need the editor token and a good Host/Origin', async () => {
    expect((await request('GET', '/api/catalog', { token: false })).status).toBe(401);
    expect((await request('GET', `/api/catalog/entries/${enc('theme/nord')}`, { token: false })).status).toBe(
      401,
    );
    const evil = { origin: 'http://evil.example' };
    const bad = await request('POST', '/api/catalog/save', {
      body: { kind: 'bundle', name: 'X', mode: 'new', config: defaultConfig() },
      headers: evil,
    });
    expect(bad.status).toBe(403);
    expect(fs.existsSync(path.join(cfgDir(), 'catalog'))).toBe(false);
    expect((await request('POST', '/api/catalog/previews', { body: {}, headers: evil })).status).toBe(403);
    expect((await request('DELETE', `/api/catalog/entries/u-000000000000`, { headers: evil })).status).toBe(
      403,
    );
    const host = await request('GET', '/api/catalog', { headers: { host: 'evil.example:80' } });
    expect(host.status).toBe(403);
  });
});

describe('editor catalog routes: save, restore, share, delete and install-theme', () => {
  it('saves a new entry and remembers the author (D-07)', async () => {
    const res = await save({ author: 'Alp' });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.entry).toMatchObject({ source: 'user', name: 'Look', author: 'Alp', version: 1, rev: 1 });
    expect(body.entry.share).toEqual({ wanted: true, state: 'pending' });
    expect(body.catalog.user[0].ref).toBe(body.entry.ref);
    expect(body.catalog.profile.author).toBe('Alp');
    expect((await catalog()).profile.author).toBe('Alp');
  });

  it('answers 409 exists with id, version and name on a clash (D-06)', async () => {
    const first = (await save({})).json();
    const res = await save({});
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({
      errorId: 'err.catalog.exists',
      errorParams: { kind: 'bundle', name: 'Look', version: 1 },
      exists: { id: first.entry.id, version: 1, name: 'Look' },
    });
    expect((await save({ kind: 'preset' })).status).toBe(200);
  });

  it('updates, overwrites and refuses a stale rev', async () => {
    const first = (await save({})).json().entry;
    const up = await save({ mode: 'update', id: first.id, rev: first.rev, config: twoLines() });
    expect(up.status).toBe(200);
    const v2 = up.json().entry;
    expect(v2.version).toBe(2);
    expect(v2.content.layout.lines).toHaveLength(2);
    const over = await save({ mode: 'overwrite', id: first.id, rev: v2.rev, config: oneLine() });
    expect(over.status).toBe(200);
    const v2b = over.json().entry;
    expect(v2b.version).toBe(2);
    expect(v2b.content.layout.lines).toHaveLength(1);
    const full = (await request('GET', `/api/catalog/entries/${first.id}`)).json();
    expect(typeof full.versions[1].overwrittenAt).toBe('string');
    const stale = await save({ mode: 'update', id: first.id, rev: first.rev });
    expect(stale.status).toBe(409);
    expect(stale.json().errorId).toBe('err.catalog.changed');
  });

  it('an overwrite with a share change is one write; no share keeps it (WR-02)', async () => {
    const first = (await save({ share: false })).json().entry;
    const file = path.join(cfgDir(), 'catalog', 'entries', `${first.id}.json`);
    const v1 = fs.readFileSync(file);
    const kept = (
      await save({ mode: 'overwrite', id: first.id, rev: first.rev, config: twoLines(), share: undefined })
    ).json();
    expect(kept.entry.share).toEqual({ wanted: false, state: 'local' });
    expect(kept.entry.rev).toBe(first.rev + 1);
    expect(fs.readFileSync(`${file}.bak`).equals(v1)).toBe(true);
    const v2 = fs.readFileSync(file);
    const on = await save({ mode: 'overwrite', id: first.id, rev: kept.entry.rev, share: true });
    expect(on.json().entry.share).toEqual({ wanted: true, state: 'pending' });
    expect(on.json().entry.rev).toBe(kept.entry.rev + 1);
    expect(fs.readFileSync(`${file}.bak`).equals(v2)).toBe(true);
  });

  it('rejects a bad name, kind, mode or missing config', async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ name: '' }, 400, 'err.catalog.badName'],
      [{ name: 'x'.repeat(65) }, 400, 'err.catalog.badName'],
      [{ name: 'a\u0007b' }, 400, 'err.catalog.badName'],
      [{ kind: 'widget' }, 400, 'err.catalog.badContent'],
      [{ config: null }, 400, 'err.catalog.badContent'],
      [{ mode: 'replace' }, 400, 'err.catalog.badRequest'],
      [{ mode: 'update', id: '../x' }, 400, 'err.catalog.badId'],
      [{ mode: 'update', id: 'u-000000000000' }, 404, 'err.catalog.unknownRef'],
    ];
    for (const [body, status, id] of cases) {
      const res = await save(body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(res.json().errorId).toBe(id);
    }
    expect(fs.existsSync(path.join(cfgDir(), 'catalog', 'entries'))).toBe(false);
  });

  it('shares, unshares and adopts a legacy ref on share', async () => {
    const e = (await save({})).json().entry;
    const off = await request('POST', '/api/catalog/share', {
      body: { ref: e.ref, share: false, rev: e.rev },
    });
    expect(off.status).toBe(200);
    expect(off.json().entry.share).toEqual({ wanted: false, state: 'local' });
    const stale = await request('POST', '/api/catalog/share', {
      body: { ref: e.ref, share: true, rev: e.rev },
    });
    expect(stale.json().errorId).toBe('err.catalog.changed');

    await saveLegacyPreset('old');
    const res = await request('POST', '/api/catalog/share', {
      body: { ref: 'legacy:preset/old', share: true },
    });
    expect(res.status).toBe(200);
    const adopted = res.json().entry;
    expect(adopted).toMatchObject({
      source: 'user',
      name: 'Old one',
      share: { wanted: true, state: 'pending' },
    });
    const refs = res.json().catalog.user.map((s: { ref: string }) => s.ref);
    expect(refs).not.toContain('legacy:preset/old');
    expect(refs).toContain(adopted.ref);
    expect(fs.existsSync(path.join(cfgDir(), 'presets', 'old.json'))).toBe(true);

    const sys = await request('POST', '/api/catalog/share', {
      body: { ref: 'bundle/nord-minimal', share: true },
    });
    expect(sys.status).toBe(403);
    expect(sys.json().errorId).toBe('err.catalog.systemReadOnly');
    const bad = await request('POST', '/api/catalog/share', { body: { ref: '../x', share: true } });
    expect(bad.json()).toMatchObject({ errorId: 'err.catalog.badRef' });
    expect(bad.status).toBe(400);
    const noFlag = await request('POST', '/api/catalog/share', { body: { ref: e.ref } });
    expect(noFlag.status).toBe(400);
  });

  it('restores an old version as a new one', async () => {
    const e = (await save({})).json().entry;
    const v2 = (await save({ mode: 'update', id: e.id, rev: e.rev, config: twoLines() })).json().entry;
    const res = await request('POST', '/api/catalog/restore', {
      body: { id: e.id, version: 1, rev: v2.rev },
    });
    expect(res.status).toBe(200);
    expect(res.json().entry.version).toBe(3);
    expect(res.json().entry.content.layout.lines).toHaveLength(1);
    const full = (await request('GET', `/api/catalog/entries/${e.id}`)).json();
    expect(full.versions[2]).toMatchObject({ version: 3, restoredFrom: 1, note: '' });
    const missing = await request('POST', '/api/catalog/restore', {
      body: { id: e.id, version: 9, rev: res.json().entry.rev },
    });
    expect(missing.status).toBe(404);
    expect(missing.json().errorId).toBe('err.catalog.noVersion');
    const stale = await request('POST', '/api/catalog/restore', { body: { id: e.id, version: 1, rev: 1 } });
    expect(stale.json().errorId).toBe('err.catalog.changed');
    const sys = await request('POST', '/api/catalog/restore', {
      body: { id: 'theme/nord', version: 1, rev: 0 },
    });
    expect(sys.status).toBe(403);
  });

  it('deletes user entries to the trash, legacy files with a copy, never system ones', async () => {
    const e = (await save({})).json().entry;
    const res = await request('DELETE', `/api/catalog/entries/${e.id}`);
    expect(res.status).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().catalog.user).toEqual([]);
    const trash = path.join(cfgDir(), 'catalog', 'trash');
    expect(fs.readdirSync(trash).some((f) => f.startsWith(`${e.id}-`))).toBe(true);
    expect(fs.existsSync(path.join(cfgDir(), 'catalog', 'entries', `${e.id}.json`))).toBe(false);

    await saveLegacyPreset('x');
    const legacy = await request('DELETE', `/api/catalog/entries/${enc('legacy:preset/x')}`);
    expect(legacy.status).toBe(200);
    expect(fs.existsSync(path.join(cfgDir(), 'presets', 'x.json'))).toBe(false);
    expect(fs.readdirSync(trash).some((f) => f.startsWith('legacy-preset-x-'))).toBe(true);
    const again = await request('DELETE', `/api/catalog/entries/${enc('legacy:preset/x')}`);
    expect(again.status).toBe(404);

    const sys = await request('DELETE', `/api/catalog/entries/${enc('bundle/nord-minimal')}`);
    expect(sys.status).toBe(403);
    expect(sys.json().errorId).toBe('err.catalog.systemReadOnly');
    const bad = await request('DELETE', '/api/catalog/entries/%2e%2e%2f');
    expect(bad.status).toBe(400);
    const gone = await request('DELETE', `/api/catalog/entries/${e.id}`);
    expect(gone.status).toBe(404);
  });

  it('installs an embedded theme under <id>-2 when the id is taken (D-26)', async () => {
    const e = (await save({ config: { ...defaultConfig(), theme: 'nord', separator: '|' } })).json().entry;
    expect(e.content.theme).toBeTypeOf('object');
    const res = await request('POST', '/api/catalog/install-theme', { body: { ref: e.ref } });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.theme).toEqual({ id: 'nord-2', written: true, renamed: true });
    expect(body.themes.map((t: { id: string }) => t.id)).toContain('nord-2');
    expect(fs.existsSync(path.join(cfgDir(), 'themes', 'nord-2.json'))).toBe(true);
    const again = (await request('POST', '/api/catalog/install-theme', { body: { ref: e.ref } })).json();
    expect(again.theme).toEqual({ id: 'nord-2', written: false, renamed: true });
    const plain = (
      await request('POST', '/api/catalog/install-theme', { body: { ref: 'theme/nord' } })
    ).json();
    expect(plain.theme).toBeNull();
    const old = await request('POST', '/api/catalog/install-theme', { body: { ref: e.ref, version: 7 } });
    expect(old.json().errorId).toBe('err.catalog.noVersion');
    const bad = await request('POST', '/api/catalog/install-theme', { body: { ref: 5 } });
    expect(bad.json().errorId).toBe('err.catalog.badRef');
  });

  it('never writes the config file (D-11)', async () => {
    const text = `${JSON.stringify({ language: 'en', theme: 'dracula', lines: [[{ id: 'm', type: 'model' }]] })}\n`;
    fs.writeFileSync(file, text);
    const before = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;
    await saveLegacyPreset('old');
    const e = (await save({ author: 'Alp' })).json().entry;
    const v2 = (await save({ mode: 'update', id: e.id, rev: e.rev })).json().entry;
    await request('POST', '/api/catalog/restore', { body: { id: e.id, version: 1, rev: v2.rev } });
    await request('POST', '/api/catalog/share', { body: { ref: 'legacy:preset/old', share: true } });
    await request('POST', '/api/catalog/install-theme', { body: { ref: 'bundle/nord-minimal' } });
    await request('POST', '/api/catalog/previews', { body: { config: defaultConfig() } });
    await catalog();
    await request('GET', `/api/catalog/entries/${e.id}`);
    await request('DELETE', `/api/catalog/entries/${e.id}`);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('error JSON is English with errorId under a Turkish config', async () => {
    fs.writeFileSync(file, JSON.stringify({ language: 'tr', lines: [] }));
    await save({});
    const res = await save({});
    expect(res.status).toBe(409);
    expect(res.json().error).toBe('A bundle named Look already exists (v1)');
    expect(res.json().errorId).toBe('err.catalog.exists');
    const bad = await request('GET', '/api/catalog/entries/nope');
    expect(bad.json()).toMatchObject({ error: 'Not a catalog entry id', errorId: 'err.catalog.badId' });
    const ref = await request('POST', '/api/catalog/share', { body: { ref: 'nope', share: true } });
    expect(ref.json()).toMatchObject({ error: 'Not a catalog reference', errorId: 'err.catalog.badRef' });
  });
});
