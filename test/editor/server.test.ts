import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLanguage, resetLanguageCache } from '../../src/cli/lang.js';
import { defaultConfig } from '../../src/core/config.js';
import { language, t } from '../../src/core/i18n/index.js';
import { SCENARIOS } from '../../src/core/scenarios.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';
import { withLang } from '../helpers.js';

let dir: string;
let file: string;
let handle: EditorHandle;
let port: number;
let prevDir: string | undefined;

function request(
  method: string,
  p: string,
  opts: { body?: string; headers?: Record<string, string>; token?: boolean } = {},
): Promise<{ status: number; body: string; json: () => Record<string, any> }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== false) headers['x-ccinfobar-token'] = handle.token;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', (e) => {
      if (opts.body && opts.body.length > 1024 * 1024) resolve({ status: 413, body: '', json: () => ({}) });
      else reject(e);
    });
    req.end(opts.body);
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-editor-'));
  file = path.join(dir, 'c.json');
  prevDir = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = dir;
  handle = await startEditor({ configPath: file, open: false, port: 0 });
  port = Number(new URL(handle.url).port);
});

afterEach(async () => {
  await handle.close();
  if (prevDir === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('editor server', () => {
  it('binds to loopback with a 32-hex token', () => {
    expect(handle.token).toMatch(/^[0-9a-f]{32}$/);
    expect(handle.url).toBe(`http://127.0.0.1:${port}/?t=${handle.token}`);
  });

  it('serves html at /', async () => {
    const res = await request('GET', '/', { token: false });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<');
  });

  it('serves the content security policy with no inline script allowance', async () => {
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve(res.headers);
      });
      req.on('error', reject);
      req.end();
    });
    expect(headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(String(headers['content-security-policy']).match(/script-src [^;]*/)?.[0]).not.toContain(
      'unsafe-inline',
    );
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
  });

  it('compares the token in constant time and never answers 500 (SEC2-09)', async () => {
    const t = handle.token;
    const last = t.endsWith('0') ? '1' : '0';
    for (const bad of [`${t.slice(0, -1)}${last}`, t.slice(0, 31), `${t}a`, 'é'.repeat(16)]) {
      const r = await request('GET', '/api/state', { token: false, headers: { 'x-ccinfobar-token': bad } });
      expect(r.status).toBe(401);
    }
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/state', headers: { 'x-ccinfobar-token': [t, t] } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(401);
    expect((await request('GET', '/api/state')).status).toBe(200);
  });

  it('requires the token for the api', async () => {
    expect((await request('GET', '/api/state', { token: false })).status).toBe(401);
    expect(
      (await request('GET', '/api/state', { token: false, headers: { 'x-ccinfobar-token': 'nope' } })).status,
    ).toBe(401);
  });

  it('rejects foreign Host headers', async () => {
    const res = await request('GET', '/api/state', { headers: { host: 'evil.example:80' } });
    expect(res.status).toBe(403);
    const ok = await request('GET', '/api/state', { headers: { host: `localhost:${port}` } });
    expect(ok.status).toBe(200);
  });

  it('answers 401 when the token is only in the query', async () => {
    const r = await request('GET', `/api/state?t=${handle.token}`, { token: false });
    expect(r.status).toBe(401);
  });

  it('checks the Host header on /', async () => {
    const bad = await request('GET', '/', { token: false, headers: { host: 'evil.example:80' } });
    expect(bad.status).toBe(403);
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const ok = await request('GET', '/', { token: false, headers: { host } });
      expect(ok.status).toBe(200);
    }
  });

  it('rejects mismatching Origin on mutating requests', async () => {
    const body = JSON.stringify({ config: defaultConfig() });
    const bad = await request('PUT', '/api/config', { body, headers: { origin: 'http://evil.example' } });
    expect(bad.status).toBe(403);
    expect(fs.existsSync(file)).toBe(false);
    const good = await request('PUT', '/api/config', {
      body,
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(good.status).toBe(200);
  });

  it('upgrades a legacy usable switch on load', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ lines: [[{ id: 'c', type: 'context-bar', options: { usable: 'true' } }]] }),
    );
    const s = (await request('GET', '/api/state')).json();
    expect(s.config.lines[0][0].options).toEqual({ basis: 'usable' });
    expect(s.savedConfig).toEqual(s.config);
  });

  it('returns the state shape', async () => {
    const res = await request('GET', '/api/state');
    expect(res.status).toBe(200);
    const s = res.json();
    expect(typeof s.version).toBe('string');
    expect(s.configPath).toBe(file);
    expect(Array.isArray(s.config.lines)).toBe(true);
    expect(s.savedConfig).toEqual(s.config);
    expect(s.widgets.length).toBeGreaterThan(0);
    expect(s.widgets[0]).toHaveProperty('type');
    expect(s.widgets[0]).not.toHaveProperty('render');
    expect(Array.isArray(s.widgets[0].options)).toBe(true);
    const timed = (type: string) => s.widgets.find((w: { type: string }) => w.type === type)?.timeBased;
    expect([timed('turn-timer'), timed('clock'), timed('model')]).toEqual([true, true, false]);
    expect(s.categories.length).toBeGreaterThan(0);
    expect(s.presets[0]).toHaveProperty('config');
    expect(Array.isArray(s.themes)).toBe(true);
    expect(s.themes.length).toBeGreaterThan(10);
    expect(s.themes[0]).toMatchObject({ id: 'classic', source: 'builtin' });
    expect(s.styles.map((x: { id: string }) => x.id)).toEqual([
      'text',
      'blocks',
      'powerline',
      'capsule',
      'tui',
    ]);
    expect(s.themesDir).toBe(path.join(dir, 'themes'));
    expect(s.claude).toHaveProperty('installed');
    expect(typeof s.claude.defaultCommand).toBe('string');
    expect(typeof s.hasLastPayload).toBe('boolean');
  });

  it('renders previews', async () => {
    const res = await request('POST', '/api/preview', {
      body: JSON.stringify({ config: defaultConfig(), source: 'sample', width: 140 }),
    });
    expect(res.status).toBe(200);
    const { lines } = res.json();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('\x1b[');
  });

  it('returns the ids hidden by a rule next to the lines', async () => {
    const config = {
      lines: [
        [
          { id: 'g1', type: 'model', hideWhen: '!git' },
          { id: 'm2', type: 'model' },
        ],
      ],
    };
    const post = async (c: unknown) =>
      (
        await request('POST', '/api/preview', {
          body: JSON.stringify({ config: c, source: 'scenario', scenario: 'fresh-session', width: 120 }),
        })
      ).json();
    const ruled = await post(config);
    expect(ruled.hidden).toEqual(['g1']);
    expect(ruled.dropped).toEqual([]);
    const plain = await post({ lines: [[{ id: 'm2', type: 'model' }]] });
    expect(plain.hidden).toEqual([]);
    expect(ruled.lines).toEqual(plain.lines);
  });

  it('marks the ids dropped by priority overflow', async () => {
    const config = {
      overflow: 'priority',
      widthOffset: 0,
      lines: [
        [
          { id: 'm', type: 'model' },
          { id: 'r', type: 'model', hideWhen: '!git' },
          { id: 'p', type: 'gsd-phase' },
          { id: 'c', type: 'context-percentage' },
          { id: 'g', type: 'git-branch' },
        ],
      ],
    };
    const res = await request('POST', '/api/preview', {
      body: JSON.stringify({ config, source: 'scenario', scenario: 'fresh-session', width: 20 }),
    });
    const body = res.json();
    expect(body.hidden).toContain('r');
    expect(body.dropped.length).toBeGreaterThan(0);
    expect(body.dropped).not.toContain('r');
    for (const id of body.dropped) expect(body.hidden).toContain(id);
  });

  it('survives garbage preview input', async () => {
    const res = await request('POST', '/api/preview', { body: JSON.stringify({ config: 42 }) });
    expect(res.status).toBe(200);
  });

  it('lists scenarios in the state', async () => {
    const { scenarios } = (await request('GET', '/api/state')).json();
    expect(scenarios).toHaveLength(SCENARIOS.length);
    for (const s of scenarios) {
      expect(Object.keys(s).sort()).toEqual(['description', 'id', 'label']);
      expect(typeof s.id).toBe('string');
      expect(typeof s.label).toBe('string');
      expect(typeof s.description).toBe('string');
    }
    expect(scenarios.map((s: { id: string }) => s.id)).toContain('context-full');
  });

  it('renders scenario previews on the server', async () => {
    const lines = async (extra: Record<string, unknown>) =>
      (
        await request('POST', '/api/preview', {
          body: JSON.stringify({ config: defaultConfig(), width: 140, ...extra }),
        })
      ).json().lines as string[];
    const full = await request('POST', '/api/preview', {
      body: JSON.stringify({
        config: defaultConfig(),
        source: 'scenario',
        scenario: 'context-full',
        width: 140,
      }),
    });
    expect(full.status).toBe(200);
    expect(full.json().lines).not.toEqual(await lines({ source: 'sample' }));
    expect(await lines({ source: 'scenario', scenario: 'context-full' })).toEqual(full.json().lines);
  });

  it('applies the over-budget scenario config to the preview', async () => {
    const config = { ...defaultConfig(), colorLevel: 0, lines: [[{ id: 'b', type: 'budget' }]] };
    const res = await request('POST', '/api/preview', {
      body: JSON.stringify({ config, source: 'scenario', scenario: 'over-budget', width: 140 }),
    });
    expect(res.status).toBe(200);
    expect(res.json().lines.join('')).toContain('~$4.12/$3');
  });

  it('falls back to sample for unknown scenarios', async () => {
    const config = {
      ...defaultConfig(),
      lines: [
        [
          { id: 'model-1', type: 'model' },
          { id: 'context-percentage-1', type: 'context-percentage' },
        ],
      ],
    };
    const lines = async (extra: Record<string, unknown>) => {
      const res = await request('POST', '/api/preview', {
        body: JSON.stringify({ config, width: 140, ...extra }),
      });
      expect(res.status).toBe(200);
      return res.json().lines as string[];
    };
    const sample = await lines({ source: 'sample' });
    expect(sample.join('')).not.toBe('');
    for (const scenario of ['nope', 42, '../x', null]) {
      expect(await lines({ source: 'scenario', scenario })).toEqual(sample);
    }
    expect(await lines({ source: 'scenario' })).toEqual(sample);
    expect(await lines({ source: 'context-full' })).toEqual(sample);
  });

  it('renders theme previews for a scenario', async () => {
    const res = await request('POST', '/api/theme-previews', {
      body: JSON.stringify({
        config: defaultConfig(),
        source: 'scenario',
        scenario: 'api-key-user',
        width: 100,
      }),
    });
    expect(res.status).toBe(200);
    const { previews } = res.json();
    const ids = (await request('GET', '/api/state')).json().themes.map((t: { id: string }) => t.id);
    expect(Object.keys(previews).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(previews[id].length).toBeGreaterThan(0);
  });

  it('keeps the token check on scenario previews', async () => {
    const body = JSON.stringify({ config: defaultConfig(), source: 'scenario', scenario: 'context-full' });
    expect((await request('POST', '/api/preview', { body, token: false })).status).toBe(401);
    expect((await request('POST', '/api/theme-previews', { body, token: false })).status).toBe(401);
    expect(
      (await request('POST', '/api/preview', { body, headers: { origin: 'http://evil.example' } })).status,
    ).toBe(403);
  });

  it('writes the config file', async () => {
    const config = { ...defaultConfig(), separator: ' :: ' };
    const res = await request('PUT', '/api/config', { body: JSON.stringify({ config }) });
    expect(res.status).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).separator).toBe(' :: ');
    const state = (await request('GET', '/api/state')).json();
    expect(state.config.separator).toBe(' :: ');
  });

  it('saves legacy usable as basis usable', async () => {
    const config = {
      ...defaultConfig(),
      lines: [[{ id: 'p', type: 'context-percentage', options: { usable: true } }]],
    };
    const res = await request('PUT', '/api/config', { body: JSON.stringify({ config }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).lines[0][0].options).toEqual({ basis: 'usable' });
  });

  it('rejects invalid json and oversized bodies', async () => {
    expect((await request('PUT', '/api/config', { body: '{nope' })).status).toBe(400);
    const big = JSON.stringify({ config: defaultConfig(), pad: 'x'.repeat(1024 * 1024 + 10) });
    const res = await request('PUT', '/api/config', { body: big });
    expect(res.status).toBe(413);
    // the socket may close before the reply arrives
    if (res.body)
      expect(res.json()).toEqual({ error: 'Request body too large', errorId: 'err.server.tooLarge' });
  });

  it('renders a preview for every theme without overrides', async () => {
    const config = { ...defaultConfig(), style: 'capsule', separator: ' ZZZ ' };
    const res = await request('POST', '/api/theme-previews', {
      body: JSON.stringify({ config, source: 'sample', width: 100 }),
    });
    expect(res.status).toBe(200);
    const { previews } = res.json();
    const ids = (await request('GET', '/api/state')).json().themes.map((t: { id: string }) => t.id);
    expect(Object.keys(previews).sort()).toEqual([...ids].sort());
    expect(previews.classic.length).toBe(1);
    expect(previews.classic[0]).not.toContain('ZZZ');
    expect(previews.nord[0]).not.toBe(previews.classic[0]);
    expect(previews.panel.length).toBeGreaterThan(2);
    expect(previews.panel.join('\n')).toContain('╭');
  });

  it('ignores tui overrides in theme previews and keeps them in previews', async () => {
    const config = { ...defaultConfig(), theme: 'panel', tui: { box: 'double' } };
    const body = (c: unknown) => JSON.stringify({ config: c, source: 'sample', width: 100 });
    const themes = (await request('POST', '/api/theme-previews', { body: body(config) })).json();
    expect(themes.previews.panel.join('\n')).toContain('╭');
    const own = (await request('POST', '/api/preview', { body: body(config) })).json();
    expect(own.lines.join('\n')).toContain('╔');
  });

  it('saves, lists and deletes user themes', async () => {
    const theme = { id: 'mine', name: 'Mine', extends: 'nord', separator: ' ~ ' };
    const res = await request('POST', '/api/themes', { body: JSON.stringify({ theme }) });
    expect(res.status).toBe(200);
    const saved = res.json().themes.find((t: { id: string }) => t.id === 'mine');
    expect(saved).toMatchObject({ source: 'user', style: 'powerline' });
    expect(fs.existsSync(path.join(dir, 'themes', 'mine.json'))).toBe(true);
    const del = await request('DELETE', '/api/themes/mine');
    expect(del.status).toBe(200);
    expect(del.json().themes.some((t: { id: string }) => t.id === 'mine')).toBe(false);
    expect(fs.existsSync(path.join(dir, 'themes', 'mine.json'))).toBe(false);
  });

  it('creates a theme from the current config overrides', async () => {
    const config = { ...defaultConfig(), theme: 'nord', separator: ' @@ ', padding: 2 };
    const res = await request('POST', '/api/themes', {
      body: JSON.stringify({ theme: { id: 'from-cfg', name: 'From cfg' }, fromConfig: config }),
    });
    expect(res.status).toBe(200);
    const t = res.json().themes.find((x: { id: string }) => x.id === 'from-cfg');
    expect(t).toMatchObject({ separator: ' @@ ', padding: 2, style: 'powerline', source: 'user' });
  });

  it('rejects invalid theme ids and path traversal', async () => {
    for (const id of ['../evil', 'a/b', '', '.hidden', 'x'.repeat(80)]) {
      const r = await request('POST', '/api/themes', { body: JSON.stringify({ theme: { id } }) });
      expect(r.status).toBe(400);
    }
    expect((await request('DELETE', '/api/themes/..%2Fc')).status).toBe(400);
    expect((await request('DELETE', '/api/themes/%E0%A4%A')).status).toBe(400);
    expect((await request('DELETE', '/api/themes/classic')).status).toBe(404);
    expect(fs.existsSync(path.join(dir, 'evil.json'))).toBe(false);
  });

  it('refuses device-name ids for themes and presets', async () => {
    const th = await request('POST', '/api/themes', { body: JSON.stringify({ theme: { id: 'con' } }) });
    expect(th.status).toBe(400);
    expect(th.json().errorId).toBe('err.id.reserved');
    const pr = await request('POST', '/api/presets', { body: JSON.stringify({ preset: { id: 'com1' } }) });
    expect(pr.status).toBe(400);
    expect(pr.json().errorId).toBe('err.id.reserved');
    expect(fs.existsSync(path.join(dir, 'themes', 'con.json'))).toBe(false);
  });

  it('requires the token for theme endpoints', async () => {
    expect((await request('DELETE', '/api/themes/x', { token: false })).status).toBe(401);
    expect((await request('POST', '/api/themes', { token: false, body: '{}' })).status).toBe(401);
  });

  it('404s unknown routes', async () => {
    expect((await request('GET', '/api/nope')).status).toBe(404);
    expect((await request('GET', '/other', { token: false })).status).toBe(404);
  });

  it('shuts down on request', async () => {
    const res = await request('POST', '/api/shutdown', { body: '{}' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    await expect(request('GET', '/api/state')).rejects.toThrow();
  });
});

describe('editor server language', () => {
  let prevLang: string | undefined;
  const restart = async (lang: string | undefined) => {
    await handle.close();
    if (lang === undefined) delete process.env.CCINFOBAR_LANG;
    else process.env.CCINFOBAR_LANG = lang;
    resetLanguageCache();
    applyLanguage();
    handle = await startEditor({ configPath: file, open: false, port: 0 });
    port = Number(new URL(handle.url).port);
  };
  const preview = async (config: object) =>
    (
      await request('POST', '/api/preview', {
        body: JSON.stringify({ config, source: 'scenario', scenario: 'fresh-session', width: 120 }),
      })
    )
      .json()
      .lines.join('\n') as string;
  const LINE = [[{ id: 'ctx', type: 'context-percentage' }]];
  const trLoading = withLang('tr', () => t('loading.default'));

  beforeEach(() => {
    prevLang = process.env.CCINFOBAR_LANG;
  });

  afterEach(() => {
    if (prevLang === undefined) delete process.env.CCINFOBAR_LANG;
    else process.env.CCINFOBAR_LANG = prevLang;
    resetLanguageCache();
  });

  it('sends the env answer in /api/state and keeps the process English', async () => {
    expect((await request('GET', '/api/state')).json().language).toEqual({ id: 'en', source: 'LC_ALL' });
    await restart('tr');
    expect(language()).toBe('en');
    const state = (await request('GET', '/api/state')).json();
    expect(state.language).toEqual({ id: 'tr', source: 'CCINFOBAR_LANG' });
    expect(state.widgets.find((w: { type: string }) => w.type === 'model').name).toBe('Model');
  });

  it('renders previews with the auto answer unless the config sets a language', async () => {
    await restart('tr');
    expect(await preview({ lines: LINE })).toContain(trLoading);
    expect(await preview({ language: 'auto', lines: LINE })).toContain(trLoading);
    const en = await preview({ language: 'en', lines: LINE });
    expect(en).toContain(t('loading.default'));
    expect(en).not.toContain(trLoading);
    expect(language()).toBe('en');
    await restart(undefined);
    expect(await preview({ language: 'tr', lines: LINE })).toContain(trLoading);
    expect(await preview({ lines: LINE })).not.toContain(trLoading);
  });

  it('keeps API errors English under a Turkish env', async () => {
    await restart('tr');
    const res = await request('POST', '/api/hooks', { body: JSON.stringify({ enabled: 'yes' }) });
    expect(res.status).toBe(400);
    expect(res.json().error).toBe(t('hooks.badBody'));
    expect(res.json().error).not.toBe(withLang('tr', () => t('hooks.badBody')));
    expect((await request('GET', '/api/nope')).json().error).toBe('Not found');
  });

  it('sends ids with English user-facing errors and none with developer-only ones', async () => {
    await restart('tr');
    const body = async (method: string, p: string, json?: object) =>
      (await request(method, p, json === undefined ? {} : { body: JSON.stringify(json) })).json();
    expect(await body('POST', '/api/themes', { theme: { id: '../evil' } })).toEqual({
      error: 'Theme id must be letters, numbers, dot, dash or underscore',
      errorId: 'err.theme.badId',
    });
    expect(await body('POST', '/api/presets', { preset: { id: '../p' } })).toEqual({
      error: 'Preset id must be letters, numbers, dot, dash or underscore',
      errorId: 'err.server.presetIdRule',
    });
    expect(await body('DELETE', '/api/presets/..%2Fx')).toMatchObject({ errorId: 'err.server.badPresetId' });
    expect(await body('DELETE', '/api/presets/default')).toEqual({
      error: 'Not a user preset',
      errorId: 'err.server.notUserPreset',
    });
    expect(await body('DELETE', '/api/themes/..%2Fc')).toMatchObject({ errorId: 'err.server.badThemeId' });
    expect(await body('DELETE', '/api/themes/classic')).toEqual({
      error: 'Not a user theme',
      errorId: 'err.server.notUserTheme',
    });
    expect(await body('POST', '/api/preview', { config: {}, theme: { extends: '../x' } })).toEqual({
      error: 'Invalid extends id',
      errorId: 'err.server.badExtendsId',
    });
    expect((await request('PUT', '/api/config', { body: '{nope' })).json()).toEqual({
      error: 'Invalid JSON',
      errorId: 'err.server.badJson',
    });
    expect(await body('GET', '/api/nope')).toEqual({ error: 'Not found' });
    expect((await request('GET', '/api/state', { token: false })).json()).toEqual({
      error: 'Invalid token',
      errorId: 'err.server.badToken',
    });
    expect((await request('GET', '/api/state', { headers: { host: 'evil.example:80' } })).json()).toEqual({
      error: 'Forbidden host',
    });
  });

  it('prints the startup lines in the cli language', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => void lines.push(s));
    try {
      await restart('tr');
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([
      `ccinfobar editörü çalışıyor: ${handle.url}`,
      'Durdurmak için Ctrl+C tuşlarına basın',
    ]);
  });

  it('keeps a broken config error English with the file as a param', async () => {
    await restart('tr');
    fs.writeFileSync(file, '{ "lines": [');
    const res = await request('PUT', '/api/config', { body: JSON.stringify({ config: defaultConfig() }) });
    expect(res.status).toBe(409);
    const json = res.json();
    expect(json.error).toBe(withLang('en', () => t('config.refuseBroken', { file })));
    expect(json.errorId).toBe('config.refuseBroken');
    expect(json.errorParams).toEqual({ file });
    expect(typeof json.line).toBe('number');
  });
});
