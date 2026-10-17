import { fail, isJsonType, MarketHttpError } from '../rules.js';

export const PUBLIC_HEADERS: Record<string, string> = {
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
  'access-control-allow-origin': '*',
};

export const PRIVATE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export const JSON_TYPE = 'application/json; charset=utf-8';

export function text(
  status: number,
  body: string,
  type: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { 'content-type': type, ...extra } });
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return text(status, JSON.stringify(body), JSON_TYPE, { ...PRIVATE_HEADERS, ...extra });
}

// stored JSON text, sent as is
export const publicJson = (body: string, etag: string): Response =>
  text(200, body, JSON_TYPE, { ...PUBLIC_HEADERS, etag });

export const notModified = (etag: string): Response =>
  new Response(null, { status: 304, headers: { ...PUBLIC_HEADERS, etag } });

// a strong or weak tag, or a list of them
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const v = t.trim();
    return (v.startsWith('W/') ? v.slice(2) : v) === etag;
  });
}

// fixed codes only: never headers, bodies, tokens or IPs
export function errorResponse(err: unknown): Response {
  let e: MarketHttpError;
  if (err instanceof MarketHttpError) e = err;
  else {
    console.error('market: internal');
    e = fail(500, 'internal');
  }
  const extra: Record<string, string> = {};
  if (e.retryAfter !== null) extra['retry-after'] = String(e.retryAfter);
  return json(e.status, { error: { code: e.code, message: e.message } }, extra);
}

// type before size, like the reference server
export async function readJsonBody(req: Request, cap: number): Promise<unknown> {
  if (!isJsonType(req.headers.get('content-type') ?? undefined)) throw fail(415, 'unsupported-media');
  if (Number(req.headers.get('content-length')) > cap) throw fail(413, 'too-large');
  const body = req.body;
  if (!body) return {};
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw fail(413, 'too-large');
    }
    chunks.push(value);
  }
  if (!size) return {};
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  try {
    // a BOM stays and fails, as in the reference server
    return JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(all));
  } catch {
    throw fail(400, 'invalid', 'body is not JSON');
  }
}
