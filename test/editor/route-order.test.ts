import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';

let dir: string;
let handle: EditorHandle;
let port: number;
let prevDir: string | undefined;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => Record<string, any>;
}

function request(
  method: string,
  p: string,
  opts: { host?: string; origin?: string; token?: boolean } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
  if (opts.token !== false) headers['x-ccinfobar-token'] = handle.token;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          json: () => JSON.parse(body),
        });
      });
    });
    req.on('error', reject);
    req.end(method === 'POST' || method === 'PUT' ? '{}' : undefined);
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-order-'));
  prevDir = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = dir;
  handle = await startEditor({ configPath: path.join(dir, 'c.json'), open: false, port: 0 });
  port = Number(new URL(handle.url).port);
});

afterEach(async () => {
  await handle.close();
  if (prevDir === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

describe('editor request order', () => {
  for (const method of METHODS) {
    describe(method, () => {
      it('refuses a foreign Host before anything else', async () => {
        for (const p of ['/api/zzz', '/']) {
          const res = await request(method, p, { host: 'evil.example:1', token: false });
          expect(res.status).toBe(403);
          expect(res.json().error).toBe('Forbidden host');
        }
      });

      it('refuses a missing token before the 404', async () => {
        const res = await request(method, '/api/zzz', { token: false });
        expect(res.status).toBe(401);
        expect(res.json().errorId).toBe('err.server.badToken');
      });

      it('answers a non-api path 404 before the token check', async () => {
        const res = await request(method, '/x', { token: false });
        expect(res.status).toBe(404);
      });

      it('answers an unknown api path 404 with a valid token', async () => {
        const res = await request(method, '/api/zzz');
        expect(res.status).toBe(404);
        expect(res.json().error).toBe('Not found');
      });

      if (method !== 'GET') {
        it('refuses a foreign Origin before 404 and 400', async () => {
          const paths = ['/api/zzz', '/api/preview', '/api/config', '/api/presets/x'];
          for (const p of paths) {
            const res = await request(method, p, { origin: 'http://evil.example' });
            expect(res.status).toBe(403);
            expect(res.json().error).toBe('Forbidden origin');
          }
        });

        it('lets a missing Origin through to the route', async () => {
          const res = await request(method, '/api/zzz');
          expect(res.status).toBe(404);
        });
      }
    });
  }

  it('serves / without a token as html with a CSP', async () => {
    const res = await request('GET', '/', { token: false });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toBeTruthy();
  });
});
