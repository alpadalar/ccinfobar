// a leaf: loaded only by the worker, it imports no render module
export const CAP_BYTES = 256 * 1024;
const MAX_RETRY_AFTER_MS = 86_400_000;

// seconds or an HTTP date; zero, past or garbage means none
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  const v = header?.trim();
  if (!v) return null;
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

export class JobFetchError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | null;
  constructor(code: string, retryAfter: number | null = null) {
    super(code);
    this.name = 'JobFetchError';
    this.code = code;
    this.retryAfterMs = retryAfter;
  }
}

export interface FetchJsonOpts {
  fetch: typeof fetch;
  timeoutMs: number;
  headers?: Record<string, string>;
  capBytes?: number;
  maxRedirects?: number;
  now?: number;
  signal?: AbortSignal;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {}
}

function nextHop(cur: URL, location: string | null): URL {
  if (!location) throw new JobFetchError('bad-redirect');
  let next: URL;
  try {
    next = new URL(location, cur);
  } catch {
    throw new JobFetchError('bad-redirect');
  }
  const same = next.origin === cur.origin;
  const upgrade = cur.protocol === 'http:' && next.protocol === 'https:' && next.host === cur.host;
  if (!same && !upgrade) throw new JobFetchError('cross-origin-redirect');
  return next;
}

async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > cap) {
    await discard(res);
    throw new JobFetchError('too-large');
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      try {
        await reader.cancel();
      } catch {}
      throw new JobFetchError('too-large');
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

// AbortSignal.any needs Node 20.3
function anySignal(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const c = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) c.abort(s.reason);
    else s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

export async function fetchJson(url: URL, opts: FetchJsonOpts): Promise<unknown> {
  const cap = opts.capBytes ?? CAP_BYTES;
  const max = opts.maxRedirects ?? 3;
  // one timeout covers every hop and the body; the job's signal stops it early
  const signal = anySignal(AbortSignal.timeout(opts.timeoutMs), opts.signal);
  // lower case, or fetch would send both Accept and accept
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.accept = 'application/json';
  headers['user-agent'] = 'ccinfobar';
  let cur = url;
  for (let hop = 0; ; hop++) {
    const res = await opts.fetch(cur, { method: 'GET', redirect: 'manual', signal, headers });
    if (res.status >= 300 && res.status < 400) {
      await discard(res);
      if (hop >= max) throw new JobFetchError('too-many-redirects');
      cur = nextHop(cur, res.headers.get('location'));
      continue;
    }
    if (!res.ok) {
      await discard(res);
      const wait =
        res.status === 429 || res.status === 503
          ? retryAfterMs(res.headers.get('retry-after'), opts.now)
          : null;
      throw new JobFetchError(`http-${res.status}`, wait);
    }
    const raw = (await readCapped(res, cap)).toString('utf8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new JobFetchError('bad-json');
    }
  }
}

const TLS = /^(ERR_TLS|ERR_SSL|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT)/;

// fixed codes only: messages can echo URLs and secrets
export function errorCode(err: unknown): string {
  try {
    if (err instanceof JobFetchError) return err.code;
    if (err instanceof SyntaxError) return 'bad-json';
    if (!err || typeof err !== 'object') return 'network';
    const e = err as { name?: unknown; cause?: unknown };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
    const cause = e.cause && typeof e.cause === 'object' ? (e.cause as { code?: unknown }).code : undefined;
    const code = typeof cause === 'string' ? cause : '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
    if (TLS.test(code)) return 'tls';
  } catch {}
  return 'network';
}
