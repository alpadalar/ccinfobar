// a fake api.github.com; every call is recorded, unknown hosts throw
export interface FakeUser {
  id: unknown;
  login: unknown;
  name?: unknown;
  type?: unknown;
  [k: string]: unknown;
}

export interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeGitHubOpts {
  users: Record<string, FakeUser>;
  status?: number;
  headers?: Record<string, string>;
  delayMs?: number;
  bigBody?: boolean;
  checkToken?: { clientId: string; secret: string; status?: number; noUser?: boolean };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = Number.isFinite(ms) ? setTimeout(resolve, ms) : null;
    signal?.addEventListener('abort', () => {
      if (t) clearTimeout(t);
      reject(signal.reason);
    });
  });
}

export function fakeGitHub(o: FakeGitHubOpts): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchFn = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host !== 'api.github.com' || url.protocol !== 'https:')
      throw new Error(`unexpected host ${url.host}`);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = req.method === 'GET' ? '' : await req.text();
    calls.push({ method: req.method, url: req.url, headers, body });
    if (o.delayMs) await wait(o.delayMs, init.signal);
    if (o.bigBody) return json(200, `{"pad":"${'x'.repeat(20 * 1024)}"}`);
    if (o.status) return json(o.status, { message: 'GitHub says no' }, o.headers);
    const ct = o.checkToken;
    const check = /^\/applications\/([^/]+)\/token$/.exec(url.pathname);
    if (check && req.method === 'POST' && ct) {
      if (check[1] !== ct.clientId) return json(404, { message: 'Not Found' });
      if (headers.authorization !== `Basic ${btoa(`${ct.clientId}:${ct.secret}`)}`) {
        return json(401, { message: 'Bad credentials' });
      }
      if (ct.status) return json(ct.status, { message: 'GitHub says no' });
      let token = '';
      try {
        token = String((JSON.parse(body) as { access_token?: unknown }).access_token ?? '');
      } catch {}
      const user = o.users[token];
      if (!user) return json(404, { message: 'Not Found' });
      return json(200, {
        id: 1,
        app: { client_id: ct.clientId, name: 'ccinfobar' },
        ...(ct.noUser ? {} : { user }),
      });
    }
    if (url.pathname === '/user' && req.method === 'GET') {
      const m = /^Bearer (.+)$/.exec(headers.authorization ?? '');
      const user = m ? o.users[m[1]!] : undefined;
      return user ? json(200, user) : json(401, { message: 'Bad credentials' });
    }
    return json(404, { message: 'Not Found' });
  };
  return { fetch: fetchFn as typeof fetch, calls };
}
