import { isLoopback } from '../core/http-spec.js';

// https, or http on loopback only; no credentials, query or fragment
export function checkEndpoint(raw: string | null | undefined): URL | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
  if (!ok || url.username || url.password || url.search || url.hash) return null;
  if (v.includes('?') || v.includes('#')) return null;
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}
