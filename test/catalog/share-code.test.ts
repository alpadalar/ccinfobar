import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeShare, encodeShare } from '../../src/catalog/share-code.js';
import { defaultConfig } from '../../src/core/config.js';
import { PERSONAL_KEYS } from '../../src/core/entry-keys.js';
import { MAX_CODE_CHARS, SHARE_PREFIX } from '../../src/core/share-code.js';
import type { Config } from '../../src/core/types.js';

let root = '';
let prev: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-share-code-'));
  fs.mkdirSync(path.join(root, 'themes'));
  prev = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = root;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prev;
  fs.rmSync(root, { recursive: true, force: true });
});

const cfg = (extra: Partial<Config> = {}): Config => ({
  ...defaultConfig(),
  lines: [
    [
      { id: 'm', type: 'model' },
      { id: 'c', type: 'cwd', options: { style: 'short' } },
    ],
    [{ id: 'g', type: 'git-branch' }],
  ],
  ...extra,
});

const pack = (doc: unknown) =>
  SHARE_PREFIX + zlib.deflateRawSync(Buffer.from(JSON.stringify(doc))).toString('base64url');

const risky = (): Config =>
  cfg({
    lines: [
      [
        { id: 'm', type: 'model' },
        { id: 'k', type: 'command', options: { command: 'echo hi' } },
        { id: 'h', type: 'http', options: { url: 'https://example.com/api' } },
        { id: 'l', type: 'link', options: { url: 'https://example.com/', text: 'x' } },
        { id: 'e', type: 'env', options: { name: 'ANTHROPIC_API_KEY' } },
      ],
    ],
  });

describe('encodeShare / decodeShare', () => {
  it('round-trips layout and a built-in theme', () => {
    const config = cfg({ theme: 'nord', align: 'right', overflow: 'wrap' } as Partial<Config>);
    const enc = encodeShare(config, { cols: 120 });
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(enc.code.startsWith('ccib1:')).toBe(true);
    expect(enc.chars).toBe(enc.code.length);
    const dec = decodeShare(enc.code);
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.content.layout?.lines).toEqual(config.lines);
    expect(dec.content.layout?.align).toBe('right');
    expect(dec.content.appearance).toEqual({ theme: 'nord' });
    expect(dec.content.theme).toBeUndefined();
    expect(dec.cols).toBe(120);
    expect(dec.code).toBe(enc.code);
  });

  it('embeds the theme for appearance overrides and user themes', () => {
    const over = encodeShare(cfg({ theme: 'nord', separator: '|' }));
    if (!over.ok) throw new Error('encode');
    const a = decodeShare(over.code);
    if (!a.ok) throw new Error('decode');
    expect(a.content.theme?.separator).toBe('|');

    fs.writeFileSync(
      path.join(root, 'themes', 'mine.json'),
      JSON.stringify({ id: 'mine', name: 'Mine', colors: { fg: '#ff0000' } }),
    );
    const user = encodeShare(cfg({ theme: 'mine' }));
    if (!user.ok) throw new Error('encode');
    const b = decodeShare(user.code);
    if (!b.ok) throw new Error('decode');
    expect(b.content.appearance?.theme).toBe('mine');
    expect(b.content.theme?.colors?.fg).toBe('#ff0000');
  });

  it('never carries personal settings', () => {
    const config = cfg({
      budget: { daily: 5 },
      profiles: [{ match: 'x' }],
      language: 'tr',
      charset: 'emoji',
      update: { check: false },
      usageApi: false,
      savePayload: true,
    } as unknown as Partial<Config>);
    const enc = encodeShare(config);
    if (!enc.ok) throw new Error('encode');
    const dec = decodeShare(enc.code);
    if (!dec.ok) throw new Error('decode');
    const keys = [...Object.keys(dec.content.layout ?? {}), ...Object.keys(dec.content.appearance ?? {})];
    for (const k of PERSONAL_KEYS) expect(keys, k).not.toContain(k);
    const json = zlib.inflateRawSync(Buffer.from(enc.code.slice(6), 'base64url')).toString();
    expect(json).not.toContain('budget');
    expect(json).not.toContain('profiles');
  });

  it('removes commands, HTTP calls and links unless asked', () => {
    const enc = encodeShare(risky());
    if (!enc.ok) throw new Error('encode');
    expect(enc.dropped.map((x) => x.kind)).toEqual(['command', 'http', 'link', 'env']);
    expect(enc.dropped[0]!.target).toBe('echo hi');
    const dec = decodeShare(enc.code);
    if (!dec.ok) throw new Error('decode');
    expect(dec.content.layout?.lines?.[0]?.map((i) => i.type)).toEqual(['model']);
    expect(dec.targets).toEqual([]);

    const all = encodeShare(risky(), { includeCommands: true });
    if (!all.ok) throw new Error('encode');
    expect(all.dropped).toEqual([]);
    expect(all.targets).toHaveLength(4);
    const kept = decodeShare(all.code);
    if (!kept.ok) throw new Error('decode');
    expect(kept.targets.map((x) => x.kind)).toEqual(['command', 'http', 'link', 'env']);
    expect(kept.content.layout?.lines?.[0]?.some((i) => i.type === 'env')).toBe(true);
  });

  it('reads every pasted form', () => {
    const enc = encodeShare(cfg());
    if (!enc.ok) throw new Error('encode');
    const body = enc.code.slice(6);
    const half = Math.floor(body.length / 2);
    const want = decodeShare(enc.code);
    for (const s of [
      `  "${enc.code}"\n`,
      `#c=${enc.code}`,
      `c=${enc.code}`,
      `https://example.org/any/path?q=1#c=${enc.code}`,
      `ccib1:${body.slice(0, half)}\n${body.slice(half)}`,
    ]) {
      expect(decodeShare(s), s).toEqual(want);
    }
  });

  it('refuses a config too big for a code', () => {
    const lines = Array.from({ length: 40 }, (_, l) =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `t${l}-${i}`,
        type: 'text',
        options: { text: crypto.randomBytes(60).toString('hex') },
      })),
    );
    const enc = encodeShare(cfg({ lines } as Partial<Config>));
    expect(enc.ok).toBe(false);
    if (enc.ok) return;
    expect(enc.errorId).toBe('err.share.tooBig');
    expect(enc.params?.max).toBe(MAX_CODE_CHARS);
  });
});

describe('decodeShare on hostile input', () => {
  const bad = (input: unknown) => {
    const r = decodeShare(input);
    expect(r.ok, String(input).slice(0, 40)).toBe(false);
    return r.ok ? '' : r.errorId;
  };

  it('never throws on garbage', () => {
    expect(bad('')).toBe('err.share.notCode');
    expect(bad('hello')).toBe('err.share.notCode');
    expect(bad(null)).toBe('err.share.notCode');
    expect(bad('ccib2:abc')).toBe('err.share.version');
    expect(bad('ccib1:!!!')).toBe('err.share.notCode');
    expect(bad('ccib1:AAAA')).toBe('err.share.corrupt');
    expect(bad(`ccib1:${Buffer.from('not deflate at all').toString('base64url')}`)).toBe('err.share.corrupt');
    const notJson = zlib.deflateRawSync(Buffer.from('{nope')).toString('base64url');
    expect(bad(`ccib1:${notJson}`)).toBe('err.share.corrupt');
    expect(bad(pack([1, 2]))).toBe('err.share.corrupt');
    expect(bad(pack({ v: 2, content: { layout: { lines: [] } } }))).toBe('err.share.corrupt');
    expect(bad(pack({ v: 1 }))).toBe('err.share.corrupt');
    expect(bad(pack({ v: 1, content: { layout: { lines: 'x' } } }))).toBe('err.share.corrupt');
    expect(bad(`ccib1:${'A'.repeat(MAX_CODE_CHARS)}`)).toBe('err.share.tooLong');
  });

  it('stops a deflate bomb', () => {
    const bomb = zlib.deflateRawSync(Buffer.alloc(1024 * 1024, ' ')).toString('base64url');
    expect(bomb.length).toBeLessThan(MAX_CODE_CHARS);
    expect(bad(`ccib1:${bomb}`)).toBe('err.share.tooLarge');
  });

  it('drops unsafe links and cleans labels', () => {
    const code = pack({
      v: 1,
      content: {
        layout: {
          lines: [
            [
              { id: 'a', type: 'link', options: { url: 'javascript:alert(1)', text: 'x' } },
              { id: 'b', type: 'link', options: { url: 'data:text/html,hi', text: 'y' } },
              { id: 't', type: 'text', options: { text: 'hi\u001b[31m\u0007there' } },
              { id: 'k', type: 'command', options: { command: 'rm -rf ~' } },
            ],
          ],
        },
      },
    });
    const r = decodeShare(code);
    if (!r.ok) throw new Error(r.errorId);
    const items = r.content.layout?.lines?.[0] ?? [];
    expect(items.map((i) => i.type)).toEqual(['text', 'command']);
    expect(items[0]!.options?.text).toBe('hithere');
    expect(r.targets).toEqual([{ kind: 'command', line: 0, index: 1, target: 'rm -rf ~' }]);
  });

  it('drops a broken embedded theme', () => {
    const r = decodeShare(
      pack({ v: 1, content: { layout: { lines: [] }, appearance: { theme: 'gone' }, theme: { nope: 1 } } }),
    );
    if (!r.ok) throw new Error(r.errorId);
    expect(r.content.theme).toBeUndefined();
    expect(r.content.appearance?.theme).toBe('classic');
  });
});
