// GitHub device flow on the user's machine; the token goes to the caller only
import { sanitizeText } from '../core/sanitize.js';
import { errorCode, type JsonResponse, requestJson } from '../data/jobs/fetch.js';
import { CLIENT_ID_RE } from './protocol.js';

export const VERIFY_URL = 'https://github.com/login/device';
const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CAP = 16 * 1024;
const TIMEOUT_MS = 10_000;
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 60;
const DEFAULT_EXPIRES = 900;
const MAX_EXPIRES = 1800;
const MAX_RETRIES = 3;
const USER_CODE_RE = /^[A-Z0-9-]{4,16}$/;
const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{8,255}$/;
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

export type DeviceFlowCode = 'failed' | 'disabled' | 'network' | 'timeout' | 'unavailable' | 'cancelled';

// fixed codes only, never response text
export class DeviceFlowError extends Error {
  readonly code: DeviceFlowCode;
  constructor(code: DeviceFlowCode) {
    super(code);
    this.name = 'DeviceFlowError';
    this.code = code;
  }
}

export interface GitHubDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: typeof VERIFY_URL;
  expiresAt: number;
  interval: number;
}

export type PollResult =
  | { status: 'ok'; token: string }
  | { status: 'pending' }
  | { status: 'slow-down'; interval: number }
  | { status: 'expired' | 'denied' | 'disabled' | 'failed' };

export type FlowResult = Exclude<PollResult, { status: 'pending' | 'slow-down' }> | { status: 'cancelled' };

const TERMINAL: Record<string, 'expired' | 'denied' | 'disabled'> = {
  expired_token: 'expired',
  access_denied: 'denied',
  device_flow_disabled: 'disabled',
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

const clampInterval = (v: number): number => Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.ceil(v)));

const seconds = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

async function post(url: string, form: Record<string, string>, deps: GitHubDeps): Promise<JsonResponse> {
  if (deps.signal?.aborted) throw new DeviceFlowError('cancelled');
  let res: JsonResponse;
  try {
    res = await requestJson(new URL(url), {
      fetch: deps.fetch,
      method: 'POST',
      form,
      anyStatus: true,
      capBytes: CAP,
      timeoutMs: TIMEOUT_MS,
      maxRedirects: 0,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (err) {
    if (deps.signal?.aborted) throw new DeviceFlowError('cancelled');
    const c = errorCode(err);
    throw new DeviceFlowError(
      c === 'timeout' ? 'timeout' : c === 'network' || c === 'dns' ? 'network' : 'failed',
    );
  }
  if (res.status >= 500 || res.status === 429) throw new DeviceFlowError('unavailable');
  return res;
}

const ok = (res: JsonResponse): boolean => res.status >= 200 && res.status < 300;

export async function startDeviceFlow(clientId: string, deps: GitHubDeps): Promise<DeviceStart> {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) throw new DeviceFlowError('failed');
  const res = await post(DEVICE_URL, { client_id: clientId }, deps);
  const b = res.body;
  if (!isObject(b)) throw new DeviceFlowError('failed');
  if (own(b, 'error') === 'device_flow_disabled') throw new DeviceFlowError('disabled');
  if (!ok(res) || own(b, 'error') !== undefined) throw new DeviceFlowError('failed');
  const deviceCode = own(b, 'device_code');
  const raw = own(b, 'user_code');
  const userCode = typeof raw === 'string' ? sanitizeText(raw).trim() : '';
  if (typeof deviceCode !== 'string' || !DEVICE_CODE_RE.test(deviceCode)) throw new DeviceFlowError('failed');
  if (!USER_CODE_RE.test(userCode) || own(b, 'verification_uri') !== VERIFY_URL) {
    throw new DeviceFlowError('failed');
  }
  const interval = seconds(own(b, 'interval'));
  const expires = Math.min(seconds(own(b, 'expires_in')) ?? DEFAULT_EXPIRES, MAX_EXPIRES);
  return {
    deviceCode,
    userCode,
    verificationUri: VERIFY_URL,
    expiresAt: deps.now() + Math.round(expires * 1000),
    interval: interval === null ? MIN_INTERVAL : clampInterval(interval),
  };
}

// transient failures throw DeviceFlowError; every other answer is a result
export async function pollOnce(
  clientId: string,
  deviceCode: string,
  deps: GitHubDeps,
  interval = MIN_INTERVAL,
): Promise<PollResult> {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) return { status: 'failed' };
  if (typeof deviceCode !== 'string' || !DEVICE_CODE_RE.test(deviceCode)) return { status: 'failed' };
  const res = await post(
    TOKEN_URL,
    { client_id: clientId, device_code: deviceCode, grant_type: GRANT },
    deps,
  );
  const b = res.body;
  if (!isObject(b)) return { status: 'failed' };
  const error = own(b, 'error');
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') {
    const next = seconds(own(b, 'interval')) ?? interval + 5;
    return { status: 'slow-down', interval: Math.max(clampInterval(interval), clampInterval(next)) };
  }
  if (typeof error === 'string')
    return { status: Object.hasOwn(TERMINAL, error) ? TERMINAL[error]! : 'failed' };
  const token = own(b, 'access_token');
  // refresh_token and the rest are dropped
  if (ok(res) && typeof token === 'string' && TOKEN_RE.test(token)) return { status: 'ok', token };
  return { status: 'failed' };
}

const TRANSIENT = new Set<DeviceFlowCode>(['network', 'timeout', 'unavailable']);

// bounded: expiry, cancel and MAX_RETRIES failures in a row end the loop (R-11)
export async function pollDeviceFlow(
  clientId: string,
  start: DeviceStart,
  deps: GitHubDeps,
): Promise<FlowResult> {
  let interval = clampInterval(seconds(start.interval) ?? MIN_INTERVAL);
  let failures = 0;
  for (;;) {
    if (deps.signal?.aborted) return { status: 'cancelled' };
    if (deps.now() >= start.expiresAt) return { status: 'expired' };
    const wait = Math.min(interval * 2 ** failures, MAX_INTERVAL);
    try {
      await deps.sleep(Math.max(interval, wait) * 1000, deps.signal);
    } catch {
      return { status: deps.signal?.aborted ? 'cancelled' : 'failed' };
    }
    if (deps.signal?.aborted) return { status: 'cancelled' };
    if (deps.now() >= start.expiresAt) return { status: 'expired' };
    let r: PollResult;
    try {
      r = await pollOnce(clientId, start.deviceCode, deps, interval);
    } catch (err) {
      if (deps.signal?.aborted) return { status: 'cancelled' };
      const code = err instanceof DeviceFlowError ? err.code : 'failed';
      if (!TRANSIENT.has(code) || ++failures > MAX_RETRIES) return { status: 'failed' };
      continue;
    }
    failures = 0;
    if (r.status === 'pending') continue;
    if (r.status === 'slow-down') {
      interval = Math.max(interval, r.interval);
      continue;
    }
    return r;
  }
}
