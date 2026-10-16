import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import { contentHash, createMarketClient } from '../../src/market/client.js';
import { parseServeArgs, runServe } from '../../src/market/serve.js';
import { startMarketServer } from '../../src/market/server.js';

let dir: string;
let server: { url: string; close(): Promise<void> };

const preset = (lines: unknown[][]) => ({ layout: { lines } }) as unknown as EntryContent;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-market-int-'));
  server = await startMarketServer({ dataDir: path.join(dir, 'data') });
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('market client against the reference server', () => {
  it('round-trips register, publish, versions, overwrite and withdraw', async () => {
    const anon = createMarketClient({ endpoint: server.url, fetch: globalThis.fetch });
    const meta = await anon.meta();
    expect(meta.capabilities).toMatchObject({ write: true, overwrite: true, withdraw: true });
    const { handle, token } = await anon.register('alp', 'Alp');
    expect(handle).toBe('alp');
    const client = createMarketClient({ endpoint: `${server.url}/`, fetch: globalThis.fetch, token });

    const one = preset([[{ type: 'model' }]]);
    const pub = await client.publish({
      kind: 'preset',
      slug: 'mine',
      name: 'Mine',
      description: 'first try',
      author: 'Alp',
      content: one,
      note: 'v1',
    });
    expect(pub).toEqual({ id: 'alp/mine', version: 1, hash: contentHash(one) });

    const two = preset([[{ type: 'model' }, { type: 'cwd' }]]);
    expect(await client.addVersion('alp/mine', 1, { content: two, note: 'v2' })).toEqual({
      version: 2,
      hash: contentHash(two),
    });
    await expect(client.addVersion('alp/mine', 1, { content: two, note: '' })).rejects.toMatchObject({
      code: 'stale',
      status: 412,
    });

    const fixed = preset([[{ type: 'model' }, { type: 'git-branch' }]]);
    expect(await client.overwrite('alp/mine', 2, { content: fixed, note: 'v2 fixed' })).toEqual({
      version: 2,
      hash: contentHash(fixed),
    });
    await expect(client.overwrite('alp/mine', 1, { content: fixed, note: '' })).rejects.toMatchObject({
      code: 'conflict',
    });

    const index = await anon.index();
    expect(index.entries).toEqual([
      expect.objectContaining({ id: 'alp/mine', version: 2, hash: contentHash(fixed), publisher: 'alp' }),
    ]);
    const entry = await anon.entry('alp/mine');
    expect(entry.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(entry.versions[1]).toMatchObject({ note: 'v2 fixed', hash: contentHash(fixed) });

    const got = await anon.version('alp/mine', 2, 'preset');
    expect(got.hash).toBe(contentHash(fixed));
    expect(got.content.layout?.lines).toHaveLength(1);
    expect(got.content.layout?.lines?.[0]?.map((w) => w.type)).toEqual(['model', 'git-branch']);
    expect((await anon.version('alp/mine', 1, 'preset')).hash).toBe(pub.hash);

    await expect(anon.withdraw('alp/mine')).rejects.toMatchObject({ code: 'unauthorized' });
    await client.withdraw('alp/mine');
    await expect(anon.version('alp/mine', 2, 'preset')).rejects.toMatchObject({
      code: 'withdrawn',
      status: 410,
    });
    expect((await anon.entry('alp/mine')).withdrawn).toBe(true);
    expect((await anon.index()).entries[0]?.withdrawn).toBe(true);
    await expect(
      client.publish({
        kind: 'preset',
        slug: 'mine',
        name: 'Again',
        description: '',
        author: '',
        content: one,
        note: '',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reports overwrite-disabled and rate-limited with retry-after', async () => {
    await server.close();
    server = await startMarketServer({
      dataDir: path.join(dir, 'data'),
      allowOverwrite: false,
      rateLimit: { perMinute: 3 },
      now: () => Date.UTC(2026, 9, 16, 12, 0, 15),
    });
    const anon = createMarketClient({ endpoint: server.url, fetch: globalThis.fetch });
    expect((await anon.meta()).capabilities.overwrite).toBe(false);
    const { token } = await anon.register('alp', 'Alp');
    const client = createMarketClient({ endpoint: server.url, fetch: globalThis.fetch, token });
    const one = preset([[{ type: 'model' }]]);
    await client.publish({
      kind: 'preset',
      slug: 'x',
      name: 'X',
      description: '',
      author: '',
      content: one,
      note: '',
    });
    await expect(client.overwrite('alp/x', 1, { content: one, note: '' })).rejects.toMatchObject({
      code: 'overwrite-disabled',
      status: 403,
    });
    const err = await client.withdraw('alp/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate-limited', status: 429 });
    const wait = (err as { retryAfterMs: number }).retryAfterMs;
    expect(wait).toBe(45_000);
  });
});

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
