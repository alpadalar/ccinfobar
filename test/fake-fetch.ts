export interface FakeCall {
  url: string;
  method: string;
  redirect: string | undefined;
  headers: Record<string, string>;
  body?: string;
}

export type FakeStep = Response | Error | ((url: string, init: RequestInit) => Response | Promise<Response>);

export interface StreamProbe {
  body: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => boolean;
}

// a body that hands out one chunk per pull and records cancel
export function streamed(chunks: (Uint8Array | string)[]): StreamProbe {
  const enc = new TextEncoder();
  const queue = chunks.map((c) => (typeof c === 'string' ? enc.encode(c) : c));
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      pulls++;
      const next = queue.shift();
      if (next) ctrl.enqueue(next);
      else ctrl.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, pulls: () => pulls, cancelled: () => cancelled };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } });

export function fakeFetch(steps: FakeStep[]): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const queue = [...steps];
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init.headers).entries()) headers[k] = v;
    const call: FakeCall = { url, method: init.method ?? 'GET', redirect: init.redirect, headers };
    if (typeof init.body === 'string') call.body = init.body;
    calls.push(call);
    const step = queue.shift();
    if (!step) throw new Error(`fakeFetch: no step for ${url}`);
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, init);
    return step;
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}
