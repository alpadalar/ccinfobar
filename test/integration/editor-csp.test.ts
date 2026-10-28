import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { skipDist } from '../dist.js';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');

let dir: string;
let pid: number | null = null;

afterEach(() => {
  if (pid !== null) {
    try {
      process.kill(pid);
    } catch {}
  }
  pid = null;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function get(url: string): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(skipDist)('editor content security policy (dist)', () => {
  it('pins script-src to the sha256 of the served script', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-csp-'));
    const res = spawnSync(process.execPath, [bin, 'edit', '--detach', '--no-open'], {
      encoding: 'utf8',
      timeout: 6000,
      env: {
        ...process.env,
        CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
        CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
        HOME: path.join(dir, 'home'),
        USERPROFILE: path.join(dir, 'home'),
        CCINFOBAR_NO_JOBS: '1',
      },
    });
    const url = res.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/)?.[0];
    expect(url).toBeDefined();
    pid = JSON.parse(fs.readFileSync(path.join(dir, 'cache', 'editor.json'), 'utf8')).pid;

    const { headers, body } = await get(url as string);
    const csp = String(headers['content-security-policy']);
    const hash = csp.match(/script-src 'sha256-([A-Za-z0-9+/=]+)'/)?.[1];
    expect(hash).toBeDefined();
    expect(csp).toContain("frame-ancestors 'none'");
    const start = body.indexOf('<script>') + '<script>'.length;
    const text = body.slice(start, body.lastIndexOf('</script>'));
    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\0');
    expect(createHash('sha256').update(text, 'utf8').digest('base64')).toBe(hash);
  }, 20_000);
});
