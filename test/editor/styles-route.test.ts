import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { styleHistoryOf } from '../../src/editor/routes/styles.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';

let dir: string;
let file: string;
let stylesFile: string;
let handle: EditorHandle;
let port: number;
let prevDir: string | undefined;

function put(raw: string): Promise<{ status: number; body: string }> {
  const headers = { 'x-ccinfobar-token': handle.token, 'content-type': 'application/json' };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/styles', method: 'PUT', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
}

function getState(): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const headers = { 'x-ccinfobar-token': handle.token };
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/state', method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const ok = { color: 'red', bold: true, options: { show: 'bar', width: 10 } };
const send = (history: unknown) => put(JSON.stringify({ history }));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-styles-'));
  file = path.join(dir, 'c.json');
  stylesFile = path.join(dir, 'styles.json');
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

describe('PUT /api/styles', () => {
  const bad: [string, string][] = [
    ['array body', '[]'],
    ['extra key', JSON.stringify({ history: {}, extra: 1 })],
    ['history array', JSON.stringify({ history: [] })],
    [
      '501 ids',
      JSON.stringify({ history: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`w${i}`, []])) }),
    ],
    ['81 char id', JSON.stringify({ history: { [`a${'x'.repeat(80)}`]: [] } })],
    ['empty id', JSON.stringify({ history: { '': [] } })],
    ['non-array value', JSON.stringify({ history: { a: {} } })],
    ['4 snapshots', JSON.stringify({ history: { a: [{}, {}, {}, {}] } })],
    ['snapshot not object', JSON.stringify({ history: { a: ['x'] } })],
    ['snapshot null', JSON.stringify({ history: { a: [null] } })],
    ['unknown snapshot key', JSON.stringify({ history: { a: [{ shadow: true }] } })],
    ['color number', JSON.stringify({ history: { a: [{ color: 5 }] } })],
    ['color 65 chars', JSON.stringify({ history: { a: [{ color: 'c'.repeat(65) }] } })],
    ['bold string', JSON.stringify({ history: { a: [{ bold: 'yes' }] } })],
    ['options array', JSON.stringify({ history: { a: [{ options: [] }] } })],
    ['non-look option', JSON.stringify({ history: { a: [{ options: { maxItems: 3 } }] } })],
    ['option 201 chars', JSON.stringify({ history: { a: [{ options: { style: 'v'.repeat(201) } }] } })],
    ['option object', JSON.stringify({ history: { a: [{ options: { style: {} } }] } })],
    ['option array value', JSON.stringify({ history: { a: [{ options: { style: [] } }] } })],
    ['option null', JSON.stringify({ history: { a: [{ options: { style: null } }] } })],
    ['proto id', '{"history":{"__proto__":[]}}'],
    ['proto in snapshot', '{"history":{"a":[{"__proto__":{"bold":true}}]}}'],
    ['proto in options', '{"history":{"a":[{"options":{"__proto__":1}}]}}'],
    ['proto top', '{"__proto__":{},"history":{}}'],
  ];

  for (const [name, raw] of bad) {
    it(`400 for ${name}`, async () => {
      fs.writeFileSync(stylesFile, '{"keep":[]}\n');
      const res = await put(raw);
      expect(res.status).toBe(400);
      expect(res.body).toContain('Invalid style history');
      expect(fs.readFileSync(stylesFile, 'utf8')).toBe('{"keep":[]}\n');
    });
  }

  it('writes a valid history exactly', async () => {
    const history = { budget: [ok] };
    const res = await send(history);
    expect(res.status).toBe(200);
    expect(fs.readFileSync(stylesFile, 'utf8')).toBe(`${JSON.stringify(history, null, 2)}\n`);
  });

  it('accepts old aliased option names', async () => {
    const history = { budget: [{ options: { display: 'bar' } }] };
    expect((await send(history)).status).toBe(200);
  });

  it('lenient read drops junk and a valid save still works', async () => {
    fs.writeFileSync(
      stylesFile,
      JSON.stringify({ good: [{ bold: true }], junk: [{ shadow: 1 }], worse: 'x' }),
    );
    const s = await getState();
    expect(s.styleHistory).toEqual({ good: [{ bold: true }] });
    expect((await send({ good: [{ bold: true }] })).status).toBe(200);
  });
});

describe('styleHistoryOf', () => {
  it('rejects non-finite numbers in strict mode', () => {
    expect(styleHistoryOf({ a: [{ options: { width: Number.NaN } }] }, 'strict')).toBeNull();
    expect(styleHistoryOf({ a: [{ options: { width: Number.POSITIVE_INFINITY } }] }, 'strict')).toBeNull();
    expect(styleHistoryOf({ a: [{ options: { width: 5 } }] }, 'strict')).not.toBeNull();
  });

  it('lenient keeps what is valid', () => {
    const out = styleHistoryOf(
      { a: [{ bold: true, shadow: 1 }, { color: 'red' }], b: 3, c: [{ options: { width: 4, maxItems: 2 } }] },
      'lenient',
    );
    expect(out).toEqual({ a: [{ color: 'red' }], c: [{ options: { width: 4 } }] });
  });

  it('lenient on a non-object is empty', () => {
    expect(styleHistoryOf([], 'lenient')).toEqual({});
    expect(styleHistoryOf(null, 'lenient')).toEqual({});
  });
});
