import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultConfig,
  loadConfig,
  normalizeConfig,
  normalizeHttpOptions,
  saveConfig,
} from '../../src/core/config.js';

describe('config', () => {
  it('falls back to defaults for garbage', () => {
    expect(normalizeConfig(null)).toEqual(defaultConfig());
    expect(normalizeConfig({ lines: 'x', padding: -1 }).padding).toBe(defaultConfig().padding);
  });

  it('drops invalid items and dedupes ids', () => {
    const cfg = normalizeConfig({
      lines: [
        [{ type: 'model', id: 'a' }, { nope: 1 }, { type: 'cwd', id: 'a', bold: true, options: { x: {} } }],
      ],
    });
    expect(cfg.lines[0]!.map((i) => i.id)).toEqual(['a', 'a-2']);
    expect(cfg.lines[0]![1]).toEqual({ id: 'a-2', type: 'cwd', bold: true, options: {} });
  });

  it('round-trips through disk', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-')), 'c.json');
    expect(loadConfig(file).exists).toBe(false);
    const cfg = { ...defaultConfig(), separator: ' / ' };
    saveConfig(cfg, file);
    const loaded = loadConfig(file);
    expect(loaded.exists).toBe(true);
    expect(loaded.config.separator).toBe(' / ');
  });

  it('keeps a valid budget and clamps warnAt', () => {
    expect(normalizeConfig({ budget: { daily: 10, session: 2.5, warnAt: 0.75 } }).budget).toEqual({
      daily: 10,
      session: 2.5,
      warnAt: 0.75,
    });
    expect(normalizeConfig({ budget: { daily: 1.234, warnAt: 2 } }).budget).toEqual({
      daily: 1.234,
      warnAt: 1,
    });
    expect(normalizeConfig({ budget: { session: 3, warnAt: 0.01 } }).budget).toEqual({
      session: 3,
      warnAt: 0.05,
    });
  });

  it('drops invalid budget values and unknown budget keys', () => {
    for (const daily of [0, -1, Number.NaN, '10', Number.POSITIVE_INFINITY, null]) {
      expect(normalizeConfig({ budget: { daily, session: 2 } }).budget).toEqual({ session: 2 });
    }
    expect(normalizeConfig({ budget: { daily: 5, weekly: 50 } }).budget).toEqual({ daily: 5 });
    expect(normalizeConfig({ budget: { warnAt: Number.NaN, daily: 5 } }).budget).toEqual({ daily: 5 });
    for (const budget of [{}, { daily: 0, session: -2 }, { weekly: 3 }, 'x', 10, null, []]) {
      expect('budget' in normalizeConfig({ budget })).toBe(false);
    }
    expect('budget' in normalizeConfig({})).toBe(false);
  });

  it('never copies prototype keys into the budget', () => {
    const budget = normalizeConfig(JSON.parse('{"budget":{"__proto__":{"daily":1},"session":4}}')).budget;
    expect(budget).toEqual({ session: 4 });
    expect(Object.getPrototypeOf(budget)).toBe(Object.prototype);
  });

  it('reports parse errors without throwing', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-')), 'c.json');
    fs.writeFileSync(file, '{oops');
    const loaded = loadConfig(file);
    expect(loaded.error).toBeTruthy();
    expect(loaded.config).toEqual(defaultConfig());
  });
});

describe('http options', () => {
  const http = (options: Record<string, unknown>) =>
    normalizeConfig({ lines: [[{ id: 'h', type: 'http', options }]] }).lines[0]![0]!.options;

  it('drops only invalid header entries', () => {
    expect(http({ url: 'https://x.com/', headers: 'Authorization=Bearer abc, X-Key=$K' })).toEqual({
      url: 'https://x.com/',
      headers: 'X-Key=$K',
    });
    expect(http({ headers: 'Bad Name=$A, Host=$H, X-A=${A}' })?.headers).toBe('X-A=$A');
    expect(http({ headers: 'Authorization=abc' })).toEqual({});
    expect(http({ headers: 'Authorization=Bearer ${TOK}\nX-B = $B' })?.headers).toBe(
      'Authorization=Bearer $TOK, X-B=$B',
    );
  });

  it('keeps only valid urls', () => {
    expect(http({ url: 'https://u:p@x.com' })).toEqual({});
    expect(http({ url: 'https://x.com/?k=${K}' })).toEqual({ url: 'https://x.com/?k=${K}' });
    expect(http({ url: 'https://${H}.com/' })).toEqual({});
    expect(http({ url: 'ftp://x.com/' })).toEqual({});
    expect(http({ url: '', path: '$.a' })).toEqual({ path: '$.a' });
  });

  it('clamps numbers and keeps the rest of the item', () => {
    expect(http({ interval: 5, timeout: 60000, decimals: 50, maxLength: 0 })).toEqual({
      interval: 30,
      timeout: 15000,
      decimals: 10,
      maxLength: 1,
    });
    expect(http({ interval: '90', timeout: 200, decimals: -7, maxLength: 999 })).toEqual({
      interval: 90,
      timeout: 1000,
      decimals: -1,
      maxLength: 200,
    });
    expect(http({ interval: 'soon', decimals: 2.7, format: '${value}' })).toEqual({
      decimals: 2,
      format: '${value}',
    });
    expect(http({ path: 'x'.repeat(300) })?.path).toHaveLength(256);
    const item = normalizeConfig({
      lines: [[{ id: 'h', type: 'http', color: 'red', options: { url: 'https://u:p@x.com', path: '$.a' } }]],
    }).lines[0]![0]!;
    expect(item).toEqual({ id: 'h', type: 'http', color: 'red', options: { path: '$.a' } });
  });

  it('leaves other widgets alone', () => {
    const opts = { url: 'https://u:p@x.com', headers: 'A=b', interval: 1 };
    expect(
      normalizeConfig({ lines: [[{ id: 't', type: 'text', options: opts }]] }).lines[0]![0]!.options,
    ).toEqual(opts);
    expect(normalizeHttpOptions({ list: [1], url: 'https://x.com/' })).toEqual({ url: 'https://x.com/' });
  });

  it('round-trips a valid item through save and load', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-')), 'c.json');
    const item = {
      id: 'h',
      type: 'http',
      options: {
        url: 'https://relay.example.com/balance?key=${RELAY_KEY}',
        path: '$.data.balance',
        format: '${value}',
        interval: 600,
        timeout: 8000,
        headers: 'Authorization=Bearer $RELAY_TOKEN, X-Org=$ORG',
        decimals: 2,
        maxLength: 30,
      },
    };
    const cfg = { ...defaultConfig(), lines: [[item]] };
    saveConfig(cfg, file);
    expect(loadConfig(file).config.lines).toEqual([[item]]);
  });
});
