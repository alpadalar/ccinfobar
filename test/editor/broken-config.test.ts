import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';

const BROKEN = '{\n  "lines": [,]\n}';

let dir: string;
let file: string;
let handle: EditorHandle | undefined;
let port: number;
let prevDir: string | undefined;

function request(
  method: string,
  p: string,
  body?: string,
): Promise<{ status: number; json: () => Record<string, any> }> {
  const headers: Record<string, string> = { 'x-ccinfobar-token': handle?.token ?? '' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function start(content: string): Promise<void> {
  fs.writeFileSync(file, content);
  handle = await startEditor({ configPath: file, open: false, port: 0 });
  port = Number(new URL(handle.url).port);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-broken-'));
  file = path.join(dir, 'config.json');
  prevDir = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = dir;
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  if (prevDir === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('editor with a broken config', () => {
  it('reports configIssue in state', async () => {
    await start(BROKEN);
    const res = await request('GET', '/api/state');
    expect(res.status).toBe(200);
    const issue = res.json().configIssue;
    expect(issue).toMatchObject({ kind: 'parse', line: 2 });
    expect(issue.column).toBeGreaterThan(0);
    expect(typeof issue.message).toBe('string');
  });

  it('returns null configIssue for a valid file', async () => {
    await start(JSON.stringify(defaultConfig()));
    expect((await request('GET', '/api/state')).json().configIssue).toBeNull();
  });

  it('refuses to save over a broken file with 409 and keeps the bytes', async () => {
    await start(BROKEN);
    const before = fs.readFileSync(file);
    const res = await request('PUT', '/api/config', JSON.stringify({ config: defaultConfig() }));
    expect(res.status).toBe(409);
    const body = res.json();
    expect(typeof body.error).toBe('string');
    expect(body.line).toBe(2);
    expect(body.column).toBeGreaterThan(0);
    expect(typeof body.message).toBe('string');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('saves a valid file as before', async () => {
    await start(JSON.stringify(defaultConfig()));
    const res = await request('PUT', '/api/config', JSON.stringify({ config: defaultConfig() }));
    expect(res.status).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
