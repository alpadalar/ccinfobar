import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewPublish } from '../../src/catalog/publish.js';
import {
  DEFAULT_MARKETPLACE,
  marketEndpoint,
  marketEndpointInfo,
  readCredential,
  readProfile,
  saveEntry,
  writeCredential,
  writeProfile,
  writePublisher,
} from '../../src/catalog/store.js';
import { checkEndpoint } from '../../src/market/endpoint.js';
import { fakeFetch } from '../fake-fetch.js';

let root = '';
let dir = '';
let home = '';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-profile-'));
  dir = path.join(root, 'cfg', 'catalog');
  home = path.join(root, 'home');
  fs.mkdirSync(home);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const profileFile = () => path.join(dir, 'profile.json');
const credFile = () => path.join(dir, 'credentials.json');
const ESC = '\u001b';

function walk(d: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(path.relative(root, p));
  }
  return out.sort();
}

describe('profile', () => {
  it('defaults when missing or corrupt', () => {
    const empty = { schema: 1, author: '', endpoint: null, publishers: {} };
    expect(readProfile(dir)).toEqual(empty);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(profileFile(), '{nope');
    expect(readProfile(dir)).toEqual(empty);
    fs.writeFileSync(profileFile(), '[1]');
    expect(readProfile(dir)).toEqual(empty);
    fs.writeFileSync(profileFile(), '{"author":5,"endpoint":7,"publishers":[]}');
    expect(readProfile(dir)).toEqual(empty);
  });

  it('remembers the author and keeps unknown keys', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(profileFile(), '﻿{"schema":1,"future":{"a":1},"endpoint":"http://127.0.0.1:9"}');
    const p = writeProfile({ author: 'Alperen' }, dir);
    expect(p).toEqual({ schema: 1, author: 'Alperen', endpoint: 'http://127.0.0.1:9', publishers: {} });
    expect(readProfile(dir).author).toBe('Alperen');
    const raw = JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
    expect(raw.future).toEqual({ a: 1 });
    expect(raw.schema).toBe(1);
    writePublisher('https://m.example.com/team-a/', 'alp', dir);
    expect(readProfile(dir)).toMatchObject({
      author: 'Alperen',
      publishers: { 'https://m.example.com/team-a': 'alp' },
    });
    writeProfile({ endpoint: '  ' }, dir);
    expect(readProfile(dir).endpoint).toBeNull();
  });

  it('sanitizes and cuts the author', () => {
    expect(writeProfile({ author: `${ESC}[31mRed${ESC}[0m\u0007 one` }, dir).author).toBe('Red one');
    expect(readProfile(dir).author).toBe('Red one');
    const long = writeProfile({ author: 'ş'.repeat(80) }, dir).author;
    expect([...long]).toHaveLength(64);
    fs.writeFileSync(profileFile(), JSON.stringify({ author: `${ESC}]8;;x${ESC}\\A${'b'.repeat(100)}` }));
    const read = readProfile(dir).author;
    expect(read).not.toContain(ESC);
    expect([...read].length).toBeLessThanOrEqual(64);
  });

  it('drops own __proto__ keys', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(profileFile(), '{"__proto__":{"polluted":true},"author":"a"}');
    writeProfile({ author: 'b' }, dir);
    expect(fs.readFileSync(profileFile(), 'utf8')).not.toContain('polluted');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('marketEndpoint', () => {
  it('falls back to the shipped default, or null without one', () => {
    expect(marketEndpoint({}, dir)).toBe(DEFAULT_MARKETPLACE);
    expect(marketEndpoint({}, dir, null)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('uses the env, then the profile', () => {
    expect(marketEndpoint({ CCINFOBAR_MARKETPLACE_URL: 'http://127.0.0.1:5' }, dir)).toBe(
      'http://127.0.0.1:5',
    );
    expect(marketEndpoint({ CCINFOBAR_MARKETPLACE_URL: '  http://127.0.0.1:5 \n' }, dir)).toBe(
      'http://127.0.0.1:5',
    );
    writeProfile({ endpoint: 'https://market.example.com' }, dir);
    expect(marketEndpoint({}, dir)).toBe('https://market.example.com');
    expect(marketEndpoint({ CCINFOBAR_MARKETPLACE_URL: 'http://127.0.0.1:5' }, dir)).toBe(
      'http://127.0.0.1:5',
    );
    expect(marketEndpoint({ CCINFOBAR_MARKETPLACE_URL: '   ' }, dir)).toBe('https://market.example.com');
  });
});

describe('marketEndpointInfo (D-12, R-06)', () => {
  const DEF = 'https://m.example.com';
  const env = (v: string) => ({ CCINFOBAR_MARKETPLACE_URL: v });

  it('ships the live marketplace as the default (D-12)', () => {
    expect(DEFAULT_MARKETPLACE).toMatch(/^https:\/\/ccinfobar-market\.[a-z0-9-]+\.workers\.dev$/);
    expect(checkEndpoint(DEFAULT_MARKETPLACE)?.href).toBe(`${DEFAULT_MARKETPLACE}/`);
    expect(marketEndpointInfo({}, dir)).toEqual({ url: DEFAULT_MARKETPLACE, source: 'default' });
    expect(marketEndpointInfo({ CCINFOBAR_MARKETPLACE_URL: 'off' }, dir)).toEqual({
      url: null,
      source: 'off',
    });
    expect(fs.existsSync(dir)).toBe(false);
    writeProfile({ endpoint: false }, dir);
    expect(marketEndpointInfo({}, dir)).toEqual({ url: null, source: 'off' });
    writeProfile({ endpoint: 'https://set.example.com' }, dir);
    expect(marketEndpointInfo({}, dir)).toEqual({ url: 'https://set.example.com', source: 'set' });
  });

  it('falls back to the default', () => {
    expect(marketEndpointInfo({}, dir, DEF)).toEqual({ url: DEF, source: 'default' });
    expect(marketEndpoint({}, dir, DEF)).toBe(DEF);
    expect(marketEndpointInfo({}, dir, null)).toEqual({ url: null, source: 'none' });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('env wins, and off switches it off', () => {
    writeProfile({ endpoint: 'https://set.example.com' }, dir);
    expect(marketEndpointInfo(env('OFF'), dir, DEF)).toEqual({ url: null, source: 'off' });
    expect(marketEndpointInfo(env(' off\n'), dir, DEF)).toEqual({ url: null, source: 'off' });
    expect(marketEndpointInfo(env(' http://127.0.0.1:5 '), dir, DEF)).toEqual({
      url: 'http://127.0.0.1:5',
      source: 'env',
    });
    expect(marketEndpoint(env('off'), dir, DEF)).toBeNull();
  });

  it('a set URL wins over the default; false is off', () => {
    writeProfile({ endpoint: 'https://set.example.com' }, dir);
    expect(marketEndpointInfo({}, dir, DEF)).toEqual({ url: 'https://set.example.com', source: 'set' });
    writeProfile({ endpoint: false }, dir);
    expect(marketEndpointInfo({}, dir, DEF)).toEqual({ url: null, source: 'off' });
    expect(marketEndpointInfo({}, dir, null)).toEqual({ url: null, source: 'off' });
    expect(marketEndpointInfo(env('http://127.0.0.1:5'), dir, DEF).source).toBe('env');
    writeProfile({ endpoint: null }, dir);
    expect(marketEndpointInfo({}, dir, DEF)).toEqual({ url: DEF, source: 'default' });
  });

  it('round-trips false and keeps unknown keys (CR-01)', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(profileFile(), '{"future":{"a":1},"author":"Alp"}');
    expect(writeProfile({ endpoint: false }, dir).endpoint).toBe(false);
    expect(readProfile(dir).endpoint).toBe(false);
    const raw = JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
    expect(raw.endpoint).toBe(false);
    expect(raw.future).toEqual({ a: 1 });
    writeProfile({ author: 'Other' }, dir);
    expect(readProfile(dir)).toMatchObject({ author: 'Other', endpoint: false });
    expect(JSON.parse(fs.readFileSync(profileFile(), 'utf8')).future).toEqual({ a: 1 });
  });

  it('reads odd values as no endpoint', () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const v of ['42', 'true', '{}', '[]', '""']) {
      fs.writeFileSync(profileFile(), `{"endpoint":${v}}`);
      expect(readProfile(dir).endpoint).toBeNull();
      expect(marketEndpointInfo({}, dir, DEF).source).toBe('default');
    }
  });
});

describe('publish with the default endpoint', () => {
  const DEF = 'http://127.0.0.1:9';
  const mine = () =>
    saveEntry(
      {
        kind: 'preset',
        name: 'Mine',
        description: '',
        author: 'Alp',
        content: { layout: { lines: [[{ id: 'a', type: 'model' }]] } },
        share: true,
        mode: 'new',
        now: new Date('2026-10-16T10:00:00.000Z'),
      },
      dir,
    );

  it('uses the injected default', async () => {
    mine();
    const f = fakeFetch([new Error('down')]);
    const review = await reviewPublish(null, { dir, env: {}, fetch: f.fetch, defaultEndpoint: DEF });
    expect(review.endpoint).toBe(DEF);
    expect(review.code).not.toBe('no-endpoint');
    expect(f.calls.map((c) => new URL(c.url).origin)).toEqual([DEF]);
  });

  it('sends nothing when switched off', async () => {
    mine();
    writeProfile({ endpoint: false }, dir);
    const f = fakeFetch([]);
    const review = await reviewPublish(null, { dir, env: {}, fetch: f.fetch, defaultEndpoint: DEF });
    expect(review.code).toBe('no-endpoint');
    expect(f.calls).toEqual([]);
  });
});

describe('credentials', () => {
  it('stores tokens by endpoint (origin and path) with mode 0600 (WR-05)', () => {
    expect(readCredential('https://market.example.com', dir)).toBeNull();
    writeCredential('https://market.example.com', 'tok-1', dir);
    writeCredential('http://127.0.0.1:5', 'tok-2', dir);
    expect(readCredential('https://market.example.com', dir)).toBe('tok-1');
    expect(readCredential('https://market.example.com/', dir)).toBe('tok-1');
    // another marketplace on the same host never gets this token
    expect(readCredential('https://market.example.com/team-b', dir)).toBeNull();
    writeCredential('https://market.example.com/team-b/', 'tok-b', dir);
    expect(readCredential('https://market.example.com/team-b', dir)).toBe('tok-b');
    expect(readCredential('https://market.example.com', dir)).toBe('tok-1');
    expect(readCredential('http://127.0.0.1:5', dir)).toBe('tok-2');
    expect(readCredential('https://other.example.com', dir)).toBeNull();
    if (process.platform !== 'win32') expect(fs.statSync(credFile()).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(fs.readFileSync(credFile(), 'utf8'));
    expect(raw['https://market.example.com']).toEqual({ token: 'tok-1' });
  });

  it('keeps unknown keys, removes a token when empty and ignores bad origins', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(credFile(), '{"keep":1,"https://a.example.com":{"token":"t","extra":2}}');
    writeCredential('https://b.example.com', 'u', dir);
    const raw = JSON.parse(fs.readFileSync(credFile(), 'utf8'));
    expect(raw.keep).toBe(1);
    expect(raw['https://a.example.com']).toEqual({ token: 't', extra: 2 });
    writeCredential('https://a.example.com', '', dir);
    expect(readCredential('https://a.example.com', dir)).toBeNull();
    expect(readCredential('__proto__', dir)).toBeNull();
    expect(readCredential('not a url', dir)).toBeNull();
    expect(() => writeCredential('not a url', 'x', dir)).toThrow();
    expect(readCredential('https://b.example.com', dir)).toBe('u');
  });

  it('writes nothing outside the given dir', () => {
    const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      writeProfile({ author: 'me', endpoint: 'http://127.0.0.1:5' }, dir);
      writeCredential('http://127.0.0.1:5', 'tok', dir);
      readProfile(dir);
      readCredential('http://127.0.0.1:5', dir);
      marketEndpoint({}, dir);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(walk(home)).toEqual([]);
    expect(walk(root)).toEqual([
      path.join('cfg', 'catalog', 'credentials.json'),
      path.join('cfg', 'catalog', 'profile.json'),
    ]);
  });
});
