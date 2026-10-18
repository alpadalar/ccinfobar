// editor sign-in: the device code stays here; GitHub is asked only when the browser asks (R-11)
import crypto from 'node:crypto';
import { createMarketClient, MarketError } from '../market/client.js';
import { DeviceFlowError, pollOnce, startDeviceFlow, VERIFY_URL } from '../market/github.js';
import { finishSignIn, SignInError } from './signin.js';
import { catalogDir, DEFAULT_MARKETPLACE, marketEndpointInfo } from './store.js';

const MAX_FAILURES = 3;
const MAX_BACKOFF_MS = 60_000;
const GRACE_MS = 30_000;
const FLOW_RE = /^[0-9a-f]{16}$/;

export type FlowStatus = 'pending' | 'ok' | 'expired' | 'denied' | 'disabled' | 'failed' | 'cancelled';

export interface FlowState {
  status: FlowStatus;
  handle?: string;
  admin?: boolean;
  // a marketplace or GitHub code when failed
  code?: string;
  httpStatus?: number;
}

export interface FlowStart {
  flow: string;
  userCode: string;
  verificationUri: typeof VERIFY_URL;
  expiresIn: number;
  interval: number;
}

export interface LoginFlowDeps {
  fetch: typeof fetch;
  now: () => number;
  dir?: string;
  env?: NodeJS.ProcessEnv;
  defaultEndpoint?: string | null;
}

interface Flow {
  endpoint: string;
  clientId: string;
  deviceCode: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
  lastSeen: number;
  failures: number;
  busy: boolean;
  done: FlowState | null;
}

const TRANSIENT = new Set(['network', 'timeout', 'unavailable']);

export const isFlowId = (v: unknown): v is string => typeof v === 'string' && FLOW_RE.test(v);

function startError(err: unknown): SignInError {
  if (err instanceof SignInError) return err;
  if (err instanceof MarketError) return new SignInError(err.code, { status: err.status });
  if (!(err instanceof DeviceFlowError)) return new SignInError('failed');
  if (err.code === 'disabled' || err.code === 'failed') return new SignInError(err.code);
  return new SignInError('upstream');
}

// no timers: abandoned flows are dropped on the next call
export function createLoginFlows(deps: LoginFlowDeps) {
  const flows = new Map<string, Flow>();
  const dir = () => deps.dir ?? catalogDir(deps.env ?? process.env);
  const gh = { fetch: deps.fetch, now: deps.now, sleep: async () => {} };

  function sweep(now: number): void {
    for (const [id, f] of flows) if (now - f.lastSeen > f.interval * 2000 + GRACE_MS) flows.delete(id);
  }

  async function start(): Promise<FlowStart> {
    flows.clear();
    const fallback = deps.defaultEndpoint !== undefined ? deps.defaultEndpoint : DEFAULT_MARKETPLACE;
    const { url: endpoint } = marketEndpointInfo(deps.env ?? process.env, dir(), fallback);
    if (!endpoint) throw new SignInError('no-endpoint');
    let clientId: string;
    let begun: Awaited<ReturnType<typeof startDeviceFlow>>;
    try {
      const meta = await createMarketClient({ endpoint, fetch: deps.fetch }).meta();
      const id = meta.auth.includes('github-device') && meta.github ? meta.github.clientId : null;
      if (!id) {
        const tokenMode = !meta.auth.includes('github-device') && meta.auth.includes('token');
        throw new SignInError('not-github', { tokenMode });
      }
      clientId = id;
      begun = await startDeviceFlow(clientId, gh);
    } catch (err) {
      throw startError(err);
    }
    const now = deps.now();
    const flow = crypto.randomBytes(8).toString('hex');
    // a start that raced another one wins; at most one flow
    flows.clear();
    flows.set(flow, {
      endpoint,
      clientId,
      deviceCode: begun.deviceCode,
      expiresAt: begun.expiresAt,
      interval: begun.interval,
      nextPollAt: now + begun.interval * 1000,
      lastSeen: now,
      failures: 0,
      busy: false,
      done: null,
    });
    return {
      flow,
      userCode: begun.userCode,
      verificationUri: VERIFY_URL,
      expiresIn: Math.max(0, Math.round((begun.expiresAt - now) / 1000)),
      interval: begun.interval,
    };
  }

  const finish = (f: Flow, state: FlowState): FlowState => {
    f.done = state;
    f.deviceCode = '';
    return state;
  };

  async function status(id: string): Promise<FlowState> {
    const now = deps.now();
    sweep(now);
    const f = flows.get(id);
    if (!f) return { status: 'cancelled' };
    f.lastSeen = now;
    if (f.done) return f.done;
    if (now >= f.expiresAt) return finish(f, { status: 'expired' });
    if (f.busy || now < f.nextPollAt) return { status: 'pending' };
    f.busy = true;
    f.nextPollAt = now + f.interval * 1000;
    try {
      let r: Awaited<ReturnType<typeof pollOnce>>;
      try {
        r = await pollOnce(f.clientId, f.deviceCode, gh, f.interval);
      } catch (err) {
        if (flows.get(id) !== f) return { status: 'cancelled' };
        const code = err instanceof DeviceFlowError ? err.code : 'failed';
        if (!TRANSIENT.has(code)) return finish(f, { status: 'failed' });
        if (++f.failures >= MAX_FAILURES) return finish(f, { status: 'failed', code: 'upstream' });
        f.nextPollAt = deps.now() + Math.min(MAX_BACKOFF_MS, f.interval * 1000 * 2 ** f.failures);
        return { status: 'pending' };
      }
      // cancelled while GitHub answered: a token is dropped
      if (flows.get(id) !== f) return { status: 'cancelled' };
      f.failures = 0;
      if (r.status === 'pending') return { status: 'pending' };
      if (r.status === 'slow-down') {
        f.interval = Math.max(f.interval, r.interval);
        f.nextPollAt = deps.now() + f.interval * 1000;
        return { status: 'pending' };
      }
      if (r.status !== 'ok') return finish(f, { status: r.status });
      try {
        const keep = () => flows.get(id) === f;
        const res = await finishSignIn(f.endpoint, r.token, { fetch: deps.fetch, dir: dir(), keep });
        return finish(f, { status: 'ok', handle: res.handle, admin: res.admin });
      } catch (err) {
        const e = err instanceof SignInError ? err : new SignInError('failed');
        if (e.code === 'cancelled') return { status: 'cancelled' };
        return finish(f, {
          status: 'failed',
          code: e.code,
          ...(e.status === null ? {} : { httpStatus: e.status }),
        });
      }
    } finally {
      f.busy = false;
    }
  }

  return {
    start,
    status,
    cancel(id: string): void {
      flows.delete(id);
    },
    active(): number {
      sweep(deps.now());
      return [...flows.values()].filter((f) => !f.done).length;
    },
  };
}

export type LoginFlows = ReturnType<typeof createLoginFlows>;
