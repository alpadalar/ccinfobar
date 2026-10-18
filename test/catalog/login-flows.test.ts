import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLoginFlows } from '../../src/catalog/login-flows.js';
import { readCredential } from '../../src/catalog/store.js';
import { VERIFY_URL } from '../../src/market/github.js';
import { json } from '../fake-fetch.js';

const ENDPOINT = 'https://market.example.com';
const CLIENT = 'Ov23liVCN9Nf6VlLv3St';
// built at runtime so no fixture looks like a real secret
const GH_TOKEN = ['gho', 'x'.repeat(16), 'Z9'].join('_');
const MARKET_TOKEN = 'b'.repeat(64);

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-flows-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function world() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered: () => void = () => {};
  const exchanging = new Promise<void>((r) => {
    entered = r;
  });
  const calls: { url: string; auth: string | null }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    if (url === `${ENDPOINT}/v1/meta.json`)
      return json({
        protocol: 1,
        name: 'm',
        capabilities: { write: true, overwrite: false, withdraw: true, submit: 'api' },
        auth: ['github-device'],
        github: { clientId: CLIENT },
        limits: {},
      });
    if (url === 'https://github.com/login/device/code')
      return json({
        device_code: 'd'.repeat(40),
        user_code: 'WDJB-MJHT',
        verification_uri: VERIFY_URL,
        expires_in: 900,
        interval: 5,
      });
    if (url === 'https://github.com/login/oauth/access_token')
      return json({ access_token: GH_TOKEN, token_type: 'bearer' });
    if (url === `${ENDPOINT}/v1/auth/github`) {
      entered();
      await gate;
      return json({ handle: 'octo', token: MARKET_TOKEN, displayName: 'Octo', admin: false });
    }
    if (url === `${ENDPOINT}/v1/auth/logout`) return new Response(null, { status: 204 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetch: fetchFn, calls, release: () => release(), exchanging };
}

describe('editor sign-in flows (IN-04)', () => {
  it('a cancel during the marketplace exchange stores nothing and revokes the new token', async () => {
    const w = world();
    let t = Date.UTC(2026, 9, 18, 12);
    const flows = createLoginFlows({ fetch: w.fetch, now: () => t, dir, env: {}, defaultEndpoint: ENDPOINT });
    const { flow } = await flows.start();
    t += 5000;
    const polled = flows.status(flow);
    await w.exchanging;
    flows.cancel(flow);
    w.release();
    expect(await polled).toEqual({ status: 'cancelled' });
    expect(await flows.status(flow)).toEqual({ status: 'cancelled' });
    expect(readCredential(ENDPOINT, dir)).toBeNull();
    const logout = w.calls.find((c) => c.url.endsWith('/v1/auth/logout'));
    expect(logout?.auth).toBe(`Bearer ${MARKET_TOKEN}`);
  });

  it('without a cancel the credential is stored and the flow reports ok', async () => {
    const w = world();
    w.release();
    let t = Date.UTC(2026, 9, 18, 12);
    const flows = createLoginFlows({ fetch: w.fetch, now: () => t, dir, env: {}, defaultEndpoint: ENDPOINT });
    const { flow } = await flows.start();
    t += 5000;
    expect(await flows.status(flow)).toEqual({ status: 'ok', handle: 'octo', admin: false });
    expect(readCredential(ENDPOINT, dir)).toBe(MARKET_TOKEN);
    expect(w.calls.some((c) => c.url.endsWith('/v1/auth/logout'))).toBe(false);
  });
});
