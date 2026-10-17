import { describe, expect, it } from 'vitest';
import {
  DeviceFlowError,
  type DeviceStart,
  type GitHubDeps,
  pollDeviceFlow,
  pollOnce,
  startDeviceFlow,
  VERIFY_URL,
} from '../../src/market/github.js';
import { type FakeStep, fakeFetch, json } from '../fake-fetch.js';

const CLIENT = 'Ov23liVCN9Nf6VlLv3St';
const DEVICE = '3584d83530557fdd1f46af8289938c8ef79f9dc5';
const T0 = Date.UTC(2026, 9, 17, 12);
// built at runtime so no fixture looks like a real secret
const TOKEN = ['gho', 'x'.repeat(16), 'Y7'].join('_');

// docs example answer
const docsStart = {
  device_code: DEVICE,
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

function harness(steps: FakeStep[], opts: { signal?: AbortSignal; onSleep?: (ms: number) => void } = {}) {
  const f = fakeFetch(steps);
  let t = T0;
  const sleeps: number[] = [];
  const deps: GitHubDeps = {
    fetch: f.fetch,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
      opts.onSleep?.(ms);
    },
  };
  if (opts.signal) deps.signal = opts.signal;
  return { deps, calls: f.calls, sleeps, advance: (ms: number) => (t += ms), time: () => t };
}

const start = (over: Partial<DeviceStart> = {}): DeviceStart => ({
  deviceCode: DEVICE,
  userCode: 'WDJB-MJHT',
  verificationUri: VERIFY_URL,
  expiresAt: T0 + 900_000,
  interval: 5,
  ...over,
});

const pending = () => json({ error: 'authorization_pending', error_description: 'wait' });
const netErr = () => new TypeError('fetch failed');

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DeviceFlowError);
    return (e as DeviceFlowError).code;
  }
  throw new Error('expected a DeviceFlowError');
}

describe('GitHub device flow: start', () => {
  it('asks for a code with only client_id and reads the docs example', async () => {
    const h = harness([json(docsStart)]);
    const s = await startDeviceFlow(CLIENT, h.deps);
    expect(s).toEqual({
      deviceCode: DEVICE,
      userCode: 'WDJB-MJHT',
      verificationUri: VERIFY_URL,
      expiresAt: T0 + 900_000,
      interval: 5,
    });
    expect(VERIFY_URL).toBe('https://github.com/login/device');
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0]!;
    expect(c.url).toBe('https://github.com/login/device/code');
    expect(c.method).toBe('POST');
    expect(c.body).toBe(`client_id=${CLIENT}`);
    expect(c.headers.accept).toBe('application/json');
    expect(c.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(c.redirect).toBe('manual');
  });

  it('accepts only the fixed verification URL and a clean user code', async () => {
    for (const bad of [
      'https://evil.example/login/device',
      'http://github.com/login/device',
      'https://github.com/login/device/',
      'https://github.com/login/device?x=1',
      7,
    ]) {
      const h = harness([json({ ...docsStart, verification_uri: bad })]);
      expect(await code(startDeviceFlow(CLIENT, h.deps)), String(bad)).toBe('failed');
    }
    for (const bad of ['ab c', 'wdjb-mjht', 'ABC', 'A'.repeat(17), '', 5, undefined]) {
      const h = harness([json({ ...docsStart, user_code: bad })]);
      expect(await code(startDeviceFlow(CLIENT, h.deps)), String(bad)).toBe('failed');
    }
    const h = harness([json({ ...docsStart, user_code: 'WDJB-\u001b[31mMJHT\u0007' })]);
    expect((await startDeviceFlow(CLIENT, h.deps)).userCode).toBe('WDJB-MJHT');
    for (const bad of ['', 'x'.repeat(300), 'a b', 9]) {
      const g = harness([json({ ...docsStart, device_code: bad })]);
      expect(await code(startDeviceFlow(CLIENT, g.deps)), String(bad)).toBe('failed');
    }
  });

  it('clamps interval and expiry', async () => {
    const cases: [Record<string, unknown>, number, number][] = [
      [{ interval: 1 }, 5, 900],
      [{ interval: 600 }, 60, 900],
      [{ interval: 7.2 }, 8, 900],
      [{ interval: 'x', expires_in: 'y' }, 5, 900],
      [{ interval: undefined, expires_in: undefined }, 5, 900],
      [{ expires_in: 99_999 }, 5, 1800],
      [{ expires_in: 120 }, 5, 120],
      [{ expires_in: -5 }, 5, 900],
    ];
    for (const [over, interval, expires] of cases) {
      const h = harness([json({ ...docsStart, ...over })]);
      const s = await startDeviceFlow(CLIENT, h.deps);
      expect([s.interval, s.expiresAt - T0], JSON.stringify(over)).toEqual([interval, expires * 1000]);
    }
  });

  it('maps GitHub errors to fixed codes and checks the client id first', async () => {
    let h = harness([json({ error: 'device_flow_disabled', error_description: 'off' }, 400)]);
    expect(await code(startDeviceFlow(CLIENT, h.deps))).toBe('disabled');
    h = harness([json({ error: 'incorrect_client_credentials' }, 400)]);
    expect(await code(startDeviceFlow(CLIENT, h.deps))).toBe('failed');
    h = harness([json({ message: 'nope' }, 502)]);
    expect(await code(startDeviceFlow(CLIENT, h.deps))).toBe('unavailable');
    h = harness([netErr()]);
    expect(await code(startDeviceFlow(CLIENT, h.deps))).toBe('network');
    h = harness([new Response('<html>', { status: 200 })]);
    expect(await code(startDeviceFlow(CLIENT, h.deps))).toBe('failed');
    h = harness([new Response('x'.repeat(17 * 1024), { status: 200 })]);
    expect(await code(startDeviceFlow(CLIENT, h.deps))).toBe('failed');
    h = harness([new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })]);
    expect(await code(startDeviceFlow(CLIENT, h.deps))).toBe('failed');
    for (const bad of ['a b', 'abc', 'x'.repeat(65), '']) {
      const g = harness([]);
      expect(await code(startDeviceFlow(bad, g.deps)), bad).toBe('failed');
      expect(g.calls).toEqual([]);
    }
  });

  it('stops at once when the signal is already aborted', async () => {
    const c = new AbortController();
    c.abort();
    const h = harness([], { signal: c.signal });
    expect(await code(startDeviceFlow(CLIENT, h.deps))).toBe('cancelled');
    expect(h.calls).toEqual([]);
  });
});

describe('GitHub device flow: poll once', () => {
  it('sends the device grant and maps every answer', async () => {
    const h = harness([pending()]);
    expect(await pollOnce(CLIENT, DEVICE, h.deps)).toEqual({ status: 'pending' });
    const c = h.calls[0]!;
    expect(c.url).toBe('https://github.com/login/oauth/access_token');
    expect(c.method).toBe('POST');
    expect(new URLSearchParams(c.body)).toEqual(
      new URLSearchParams({
        client_id: CLIENT,
        device_code: DEVICE,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    );
    expect(c.headers.accept).toBe('application/json');
    const cases: [unknown, number, unknown][] = [
      [{ error: 'expired_token' }, 200, { status: 'expired' }],
      [{ error: 'access_denied' }, 200, { status: 'denied' }],
      [{ error: 'device_flow_disabled' }, 200, { status: 'disabled' }],
      [{ error: 'incorrect_client_credentials' }, 200, { status: 'failed' }],
      [{ error: 'incorrect_device_code' }, 200, { status: 'failed' }],
      [{ error: 'unsupported_grant_type' }, 200, { status: 'failed' }],
      [{ error: 'something_new' }, 200, { status: 'failed' }],
      [{ error: 'expired_token' }, 400, { status: 'expired' }],
      [{ error: 'authorization_pending' }, 400, { status: 'pending' }],
      [{ access_token: 'short' }, 200, { status: 'failed' }],
      [{ access_token: 'bad token with spaces 123' }, 200, { status: 'failed' }],
      [{}, 200, { status: 'failed' }],
      [[], 200, { status: 'failed' }],
      [{ access_token: TOKEN }, 400, { status: 'failed' }],
    ];
    for (const [body, status, want] of cases) {
      const g = harness([json(body, status)]);
      expect(await pollOnce(CLIENT, DEVICE, g.deps), JSON.stringify([body, status])).toEqual(want);
    }
  });

  it('returns the token only and drops refresh_token', async () => {
    const h = harness([
      json({
        access_token: TOKEN,
        token_type: 'bearer',
        scope: '',
        refresh_token: 'ghr_refresh',
        expires_in: 28_800,
      }),
    ]);
    expect(await pollOnce(CLIENT, DEVICE, h.deps)).toEqual({ status: 'ok', token: TOKEN });
  });

  it('honours slow_down with or without a new interval', async () => {
    let h = harness([json({ error: 'slow_down', interval: 10 })]);
    expect(await pollOnce(CLIENT, DEVICE, h.deps, 5)).toEqual({ status: 'slow-down', interval: 10 });
    h = harness([json({ error: 'slow_down' })]);
    expect(await pollOnce(CLIENT, DEVICE, h.deps, 8)).toEqual({ status: 'slow-down', interval: 13 });
    h = harness([json({ error: 'slow_down', interval: 2 })]);
    expect(await pollOnce(CLIENT, DEVICE, h.deps, 8)).toEqual({ status: 'slow-down', interval: 8 });
    h = harness([json({ error: 'slow_down', interval: 900 })]);
    expect(await pollOnce(CLIENT, DEVICE, h.deps, 8)).toEqual({ status: 'slow-down', interval: 60 });
  });

  it('throws fixed transient codes for network, timeout and 5xx', async () => {
    let h = harness([netErr()]);
    expect(await code(pollOnce(CLIENT, DEVICE, h.deps))).toBe('network');
    h = harness([json({ error: 'x' }, 503)]);
    expect(await code(pollOnce(CLIENT, DEVICE, h.deps))).toBe('unavailable');
    h = harness([new Response('busy', { status: 429 })]);
    expect(await code(pollOnce(CLIENT, DEVICE, h.deps))).toBe('unavailable');
    h = harness([Object.assign(new Error('t'), { name: 'TimeoutError' })]);
    expect(await code(pollOnce(CLIENT, DEVICE, h.deps))).toBe('timeout');
    h = harness([]);
    expect(await pollOnce(CLIENT, 'a b', h.deps)).toEqual({ status: 'failed' });
    expect(h.calls).toEqual([]);
  });
});

describe('GitHub device flow: polling loop', () => {
  it('waits the interval before every poll and returns the token', async () => {
    const h = harness([pending(), pending(), json({ access_token: TOKEN, refresh_token: 'ghr_x' })]);
    expect(await pollDeviceFlow(CLIENT, start(), h.deps)).toEqual({ status: 'ok', token: TOKEN });
    expect(h.sleeps).toEqual([5000, 5000, 5000]);
    expect(h.calls).toHaveLength(3);
  });

  it('slows down as GitHub asks', async () => {
    let h = harness([
      json({ error: 'slow_down', interval: 10 }),
      pending(),
      json({ error: 'access_denied' }),
    ]);
    expect(await pollDeviceFlow(CLIENT, start(), h.deps)).toEqual({ status: 'denied' });
    expect(h.sleeps).toEqual([5000, 10_000, 10_000]);
    h = harness([
      json({ error: 'slow_down' }),
      json({ error: 'slow_down' }),
      json({ error: 'expired_token' }),
    ]);
    expect(await pollDeviceFlow(CLIENT, start(), h.deps)).toEqual({ status: 'expired' });
    expect(h.sleeps).toEqual([5000, 10_000, 15_000]);
  });

  it('ends with the terminal answers', async () => {
    for (const [error, status] of [
      ['expired_token', 'expired'],
      ['access_denied', 'denied'],
      ['device_flow_disabled', 'disabled'],
      ['incorrect_device_code', 'failed'],
    ]) {
      const h = harness([pending(), json({ error }, 400)]);
      expect(await pollDeviceFlow(CLIENT, start(), h.deps)).toEqual({ status });
      expect(h.calls).toHaveLength(2);
    }
  });

  it('stops at expiry without another request', async () => {
    const h = harness([pending(), pending()]);
    expect(await pollDeviceFlow(CLIENT, start({ expiresAt: T0 + 12_000 }), h.deps)).toEqual({
      status: 'expired',
    });
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([5000, 5000, 5000]);
    const g = harness([]);
    g.advance(900_000);
    expect(await pollDeviceFlow(CLIENT, start(), g.deps)).toEqual({ status: 'expired' });
    expect(g.calls).toEqual([]);
    expect(g.sleeps).toEqual([]);
  });

  it('cancels when the signal aborts during the wait', async () => {
    const c = new AbortController();
    const h = harness([pending(), pending()], {
      signal: c.signal,
      onSleep: () => h.calls.length === 1 && c.abort(),
    });
    expect(await pollDeviceFlow(CLIENT, start(), h.deps)).toEqual({ status: 'cancelled' });
    expect(h.calls).toHaveLength(1);
    const d = new AbortController();
    d.abort();
    const g = harness([], { signal: d.signal });
    expect(await pollDeviceFlow(CLIENT, start(), g.deps)).toEqual({ status: 'cancelled' });
    expect(g.calls).toEqual([]);
  });

  it('cancels when the sleep rejects on abort', async () => {
    const c = new AbortController();
    const f = fakeFetch([pending()]);
    const deps: GitHubDeps = {
      fetch: f.fetch,
      now: () => T0,
      signal: c.signal,
      sleep: (_ms, signal) =>
        f.calls.length === 0
          ? Promise.resolve()
          : new Promise((_, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('aborted')));
              c.abort();
            }),
    };
    expect(await pollDeviceFlow(CLIENT, start(), deps)).toEqual({ status: 'cancelled' });
    expect(f.calls).toHaveLength(1);
  });

  it('cancels when the request is aborted', async () => {
    const c = new AbortController();
    const h = harness(
      [
        () => {
          c.abort();
          throw Object.assign(new Error('a'), { name: 'AbortError' });
        },
      ],
      { signal: c.signal },
    );
    expect(await pollDeviceFlow(CLIENT, start(), h.deps)).toEqual({ status: 'cancelled' });
  });

  it('retries network failures three times with backoff, then fails', async () => {
    const h = harness([netErr(), netErr(), json({}, 502), netErr(), pending()]);
    expect(await pollDeviceFlow(CLIENT, start(), h.deps)).toEqual({ status: 'failed' });
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toEqual([5000, 10_000, 20_000, 40_000]);
  });

  it('caps the backoff at 60 s', async () => {
    const h = harness([netErr(), netErr(), netErr(), netErr()]);
    expect(await pollDeviceFlow(CLIENT, start({ interval: 20 }), h.deps)).toEqual({ status: 'failed' });
    expect(h.sleeps).toEqual([20_000, 40_000, 60_000, 60_000]);
  });

  it('resets the retry count after an answer', async () => {
    const h = harness([
      netErr(),
      netErr(),
      netErr(),
      pending(),
      netErr(),
      netErr(),
      netErr(),
      json({ access_token: TOKEN }),
    ]);
    expect(await pollDeviceFlow(CLIENT, start(), h.deps)).toEqual({ status: 'ok', token: TOKEN });
    expect(h.sleeps).toEqual([5000, 10_000, 20_000, 40_000, 5000, 10_000, 20_000, 40_000]);
  });

  it('never polls faster than the start interval', async () => {
    const h = harness([json({ error: 'slow_down', interval: 1 }), json({ access_token: TOKEN })]);
    await pollDeviceFlow(CLIENT, start({ interval: 1 }), h.deps);
    expect(h.sleeps).toEqual([5000, 5000]);
  });

  it('never puts the token or response text in an error', async () => {
    const leaks: string[] = [];
    const steps: (() => FakeStep)[] = [
      () => json({ error: 'nope', error_description: TOKEN, access_token: TOKEN }, 500),
      () => new Error(`boom ${TOKEN}`),
      () => json({ error: TOKEN }, 400),
    ];
    for (const s of steps) {
      const h = harness([s()]);
      try {
        await pollOnce(CLIENT, DEVICE, h.deps);
      } catch (e) {
        leaks.push(String(e), (e as Error).message, JSON.stringify(e));
      }
      const g = harness([s()]);
      try {
        await startDeviceFlow(CLIENT, g.deps);
      } catch (e) {
        leaks.push(String(e), (e as Error).message, JSON.stringify(e));
      }
    }
    expect(leaks.length).toBeGreaterThan(0);
    for (const l of leaks) {
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain('boom');
    }
    const err = new DeviceFlowError('failed');
    expect(err.message).toBe('failed');
    expect(err.name).toBe('DeviceFlowError');
  });
});
