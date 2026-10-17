import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMarketClient } from '../../src/market/client.js';
import { parseServeArgs, runServe } from '../../src/market/serve.js';
import { startMarketServer } from '../../src/market/server.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-market-int-'));
});

// thousands of entry files are slow to delete on Windows
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}, 120_000);

describe('self-hosting entry', () => {
  it('parses --data, --port, --host and --no-overwrite', () => {
    expect(parseServeArgs(['--data', 'd'])).toEqual({
      dataDir: path.resolve('d'),
      port: 8787,
      host: '127.0.0.1',
      allowOverwrite: true,
    });
    expect(parseServeArgs(['--data', 'd', '--port', '0', '--host', '::1', '--no-overwrite'])).toEqual({
      dataDir: path.resolve('d'),
      port: 0,
      host: '::1',
      allowOverwrite: false,
    });
    for (const bad of [
      [],
      ['--port', '1'],
      ['--data'],
      ['--data', '--port'],
      ['--data', 'd', '--port', '70000'],
      ['--data', 'd', '--port', '-1'],
      ['--data', 'd', '--port', 'x'],
      ['--data', 'd', '--nope'],
    ]) {
      expect(typeof parseServeArgs(bad), bad.join(' ')).toBe('string');
    }
  });

  it('prints only the bound url and serves meta.json', async () => {
    const lines: string[] = [];
    const s = await runServe(['--data', path.join(dir, 'self'), '--port', '0', '--no-overwrite'], (l) =>
      lines.push(l),
    );
    try {
      expect(lines).toEqual([`listening on ${s.url}\n`]);
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const meta = await (await fetch(`${s.url}/v1/meta.json`)).json();
      expect(meta).toMatchObject({ protocol: 1, capabilities: { overwrite: false } });
      expect(fs.existsSync(path.join(dir, 'self', 'v1', 'meta.json'))).toBe(true);
    } finally {
      await s.close();
    }
    await expect(runServe(['--port', '0'], () => {})).rejects.toThrow('missing --data <dir>');
  });
});

// CR-03: a full index built from files; the HTTP cap cases live in conformance.ts
describe('reference server filled to its caps', () => {
  const wide = (ch: string, n: number) => ch.repeat(n);
  const HASH = 'a'.repeat(64);
  const at = '2026-10-16T10:00:00.000Z';

  it('pages a 5000-entry index with the longest fields and the client reads all of it', async () => {
    const data = path.join(dir, 'full');
    for (let p = 0; p < 25; p++) {
      const pub = `pub-${p}`;
      fs.mkdirSync(path.join(data, 'v1', 'entries', pub), { recursive: true });
      for (let i = 0; i < 200; i++) {
        const slug = `entry-${i}`;
        const entry = {
          id: `${pub}/${slug}`,
          kind: 'bundle',
          name: wide('\u{1F600}', 64),
          description: wide('\u{1F600}', 200),
          author: wide('"', 64),
          publisher: pub,
          version: 1,
          updatedAt: at,
          hash: HASH,
          versions: [{ version: 1, at, note: '', hash: HASH }],
        };
        fs.writeFileSync(path.join(data, 'v1', 'entries', pub, `${slug}.json`), JSON.stringify(entry));
      }
    }
    const s = await startMarketServer({ dataDir: data });
    try {
      const pages = fs.readdirSync(path.join(data, 'v1')).filter((f) => /^index(-\d+)?\.json$/.test(f));
      expect(pages.sort()).toEqual(
        ['index-10.json', ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `index-${n}.json`), 'index.json'].sort(),
      );
      for (const f of pages) expect(fs.statSync(path.join(data, 'v1', f)).size).toBeLessThan(1024 * 1024);
      const first = await (await fetch(`${s.url}/v1/index.json`)).json();
      expect(first.entries).toHaveLength(500);
      expect(first.next).toBe('index-2.json');
      const last = await (await fetch(`${s.url}/v1/index-10.json`)).json();
      expect(last.next).toBeUndefined();
      expect((await fetch(`${s.url}/v1/index-11.json`)).status).toBe(404);
      const c = createMarketClient({ endpoint: s.url, fetch: globalThis.fetch });
      const index = await c.index();
      expect(index.entries).toHaveLength(5000);
      expect(new Set(index.entries.map((e) => e.id)).size).toBe(5000);
    } finally {
      await s.close();
    }
  }, 120_000);
});
