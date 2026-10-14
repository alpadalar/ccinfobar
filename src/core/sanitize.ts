// pure and browser-safe
const SEQ =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|\x9c|$)|\x9b[0-?]*[ -/]*[@-~]|[\x9d\x90\x98\x9e\x9f][\s\S]*?(?:\x07|\x1b\\|\x9c|$)|\x1b[ -/]*[0-~]?/g;
const WS = /[\t\r\n\u2028\u2029]+/g;
const CTRL = /[\x00-\x1f\x7f-\x9f]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
const SGR = /^\x1b\[[0-9;:]*m$/;
const OSC8 = /^\x1b\]8;[^;]*;([\s\S]*?)(?:\x07|\x1b\\)$/;
const URL_BAD = /[\x00-\x20\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const LINK_CLOSE = '\x1b]8;;\x1b\\';

function cleanText(s: string): string {
  return s.replace(WS, ' ').replace(CTRL, '').replace(BIDI, '');
}

export function sanitizeText(s: string): string {
  return cleanText(s.replace(SEQ, ''));
}

export function keepSgrAndLinks(s: string): string {
  let out = '';
  let last = 0;
  let open = false;
  let styled = false;
  for (const m of s.matchAll(SEQ)) {
    const seq = m[0];
    out += cleanText(s.slice(last, m.index));
    last = m.index + seq.length;
    if (SGR.test(seq)) {
      out += seq;
      styled = !/(?:^|[;:])0*$/.test(seq.slice(2, -1));
      continue;
    }
    const link = OSC8.exec(seq);
    if (!link) continue;
    const url = link[1] ?? '';
    if (url === '') {
      if (open) out += LINK_CLOSE;
      open = false;
      continue;
    }
    const href = safeUrl(url);
    if (href) {
      out += `\x1b]8;;${href}\x1b\\`;
      open = true;
    }
  }
  out += cleanText(s.slice(last));
  return out + (open ? LINK_CLOSE : '') + (styled ? '\u001b[0m' : '');
}

function parseUrl(u: string): URL | null {
  if (typeof u !== 'string' || URL_BAD.test(u)) return null;
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

export function safeUrl(u: string): string | null {
  const url = parseUrl(u);
  return url && (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
}

export function safeConfigUrl(u: string): string | null {
  const url = parseUrl(u);
  return url && url.protocol !== 'javascript:' && url.protocol !== 'data:' ? url.href : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const NONE: ReadonlySet<string> = new Set();

// skipKeys apply to top-level keys only
export function deepSanitize<T>(value: T, skipKeys: ReadonlySet<string> = NONE): T {
  if (typeof value === 'string') return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map((v) => deepSanitize(v)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = sanitizeText(k);
      if (key === '__proto__') continue;
      out[key] = skipKeys.has(k) ? v : deepSanitize(v);
    }
    return out as T;
  }
  return value;
}
