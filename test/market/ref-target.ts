import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMarketServer } from '../../src/market/server.js';
import { type MarketTarget, START, type TargetOpts } from './conformance.js';

export async function makeRefTarget(o: TargetOpts = {}): Promise<MarketTarget> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-conf-'));
  let clock = START;
  const server = await startMarketServer({
    dataDir: dir,
    now: () => clock,
    ...(o.allowOverwrite === undefined ? {} : { allowOverwrite: o.allowOverwrite }),
    ...(o.rateLimit ? { rateLimit: o.rateLimit } : {}),
    ...(o.caps ? { caps: o.caps } : {}),
  });
  return {
    url: server.url,
    fetch: globalThis.fetch,
    async signIn(handle) {
      const r = await fetch(`${server.url}/v1/publishers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, displayName: handle.toUpperCase() }),
      });
      const body = (await r.json()) as { token?: string };
      if (r.status !== 201 || typeof body.token !== 'string')
        throw new Error(`sign in ${handle}: ${r.status}`);
      return body.token;
    },
    advance(ms) {
      clock += ms;
    },
    caps: {
      overwrite: o.allowOverwrite ?? true,
      registersAnon: true,
      etag: false,
      review: false,
      rateLimit: true,
    },
    async close() {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
