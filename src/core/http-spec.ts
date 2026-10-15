export interface HeaderRef {
  name: string;
  scheme?: string;
  env: string;
}

type Env = Record<string, string | undefined>;
type Part = string | { env: string };

const MAX_HEADERS = 10;
const MAX_URL = 2048;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const VALUE_RE = /^(?:([A-Za-z]{1,32})[ \t]+)?\$(\{[^{}]*\}|[^\s{}]*)$/;
const FORBIDDEN = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie']);
const URL_BAD = /[\u0000-\u0020\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const PLACEMENT = 'placeholders are only allowed in query values';
export const NEEDS_TLS = 'secrets need https or localhost';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

function parseEntry(entry: string, n: number, seen: Set<string>): HeaderRef | string {
  const eq = entry.indexOf('=');
  if (eq === -1) return `header ${n}: expected Name=$VAR`;
  const name = entry.slice(0, eq).trim();
  const value = entry.slice(eq + 1).trim();
  if (!TOKEN_RE.test(name)) return `header ${n}: invalid name`;
  const lower = name.toLowerCase();
  if (FORBIDDEN.has(lower)) return `header '${name}' is not allowed`;
  if (seen.has(lower)) return `header '${name}' is repeated`;
  const m = VALUE_RE.exec(value);
  if (!m) {
    return value.includes('$')
      ? `header '${name}': expected Name=$VAR or Name=<Scheme> $VAR`
      : `header '${name}': literal values are not allowed; use Name=$VAR`;
  }
  const ref = m[2]!;
  const env = ref.startsWith('{') ? ref.slice(1, -1) : ref;
  if (!ENV_RE.test(env)) return `header '${name}': bad env name; use $NAME or \${NAME}`;
  return m[1] ? { name, scheme: m[1], env } : { name, env };
}

export function parseHeaderSpec(spec: string): { headers: HeaderRef[]; errors: string[] } {
  const headers: HeaderRef[] = [];
  const errors: string[] = [];
  if (typeof spec !== 'string') return { headers, errors };
  const seen = new Set<string>();
  const entries = spec
    .split(/[,\r\n]/)
    .map((e) => e.trim())
    .filter(Boolean);
  for (const [i, entry] of entries.entries()) {
    const r = parseEntry(entry, i + 1, seen);
    if (typeof r === 'string') errors.push(r);
    else if (headers.length >= MAX_HEADERS) errors.push(`header '${r.name}': at most ${MAX_HEADERS} headers`);
    else {
      seen.add(r.name.toLowerCase());
      headers.push(r);
    }
  }
  return { headers, errors };
}

export function normalizeHeaderSpec(headers: readonly HeaderRef[]): string {
  return headers.map((h) => `${h.name}=${h.scheme ? `${h.scheme} ` : ''}$${h.env}`).join(', ');
}

function scanValue(value: string, parts: Part[]): string | null {
  let pos = 0;
  for (;;) {
    const at = value.indexOf('${', pos);
    if (at === -1) {
      parts.push(value.slice(pos));
      return null;
    }
    parts.push(value.slice(pos, at));
    const close = value.indexOf('}', at + 2);
    if (close === -1) return 'unterminated placeholder';
    const name = value.slice(at + 2, close);
    if (!ENV_RE.test(name)) return 'bad placeholder; use ${NAME}';
    parts.push({ env: name });
    pos = close + 1;
  }
}

// placement is checked on the raw template: URL parsing accepts ${H} in a hostname
function scan(raw: string): { ok: true; parts: Part[] } | { ok: false; error: string } {
  let q = raw.indexOf('?');
  const h = raw.indexOf('#');
  if (h !== -1 && q > h) q = -1;
  const headEnd = q !== -1 ? q : h !== -1 ? h : raw.length;
  if (raw.slice(0, headEnd).includes('${')) return { ok: false, error: PLACEMENT };
  if (q === -1) {
    if (raw.slice(headEnd).includes('${')) return { ok: false, error: PLACEMENT };
    return { ok: true, parts: [raw] };
  }
  const queryEnd = h !== -1 ? h : raw.length;
  const hash = raw.slice(queryEnd);
  if (hash.includes('${')) return { ok: false, error: PLACEMENT };
  const parts: Part[] = [raw.slice(0, q + 1)];
  const pairs = raw.slice(q + 1, queryEnd).split('&');
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    if (i) parts.push('&');
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key.includes('${')) return { ok: false, error: PLACEMENT };
    if (eq === -1) {
      parts.push(key);
      continue;
    }
    parts.push(`${key}=`);
    const error = scanValue(pair.slice(eq + 1), parts);
    if (error) return { ok: false, error };
  }
  parts.push(hash);
  return { ok: true, parts };
}

function parse(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

// ${ or an encoded one; a bare $ is fine, as in /odata/$metadata
const hasPlaceholder = (s: string): boolean => /\$(\{|%7b)/i.test(s);

export function parseUrlTemplate(
  raw: string,
): { ok: true; vars: string[]; plain: boolean; hostname: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw) return { ok: false, error: 'url is empty' };
  if (raw.length > MAX_URL) return { ok: false, error: `url longer than ${MAX_URL} characters` };
  if (URL_BAD.test(raw)) return { ok: false, error: 'url contains spaces or control characters' };
  const s = scan(raw);
  if (!s.ok) return s;
  const url = parse(s.parts.map((p) => (typeof p === 'string' ? p : 'x')).join(''));
  if (!url) return { ok: false, error: 'not a valid url' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'only http and https urls are allowed' };
  }
  if (url.username || url.password) return { ok: false, error: 'credentials in the url are not allowed' };
  if ([url.hostname, url.pathname, url.hash].some(hasPlaceholder)) return { ok: false, error: PLACEMENT };
  const vars: string[] = [];
  for (const p of s.parts) if (typeof p !== 'string' && !vars.includes(p.env)) vars.push(p.env);
  const hostname = url.hostname.toLowerCase();
  return { ok: true, vars, plain: url.protocol === 'http:' && !isLoopback(hostname), hostname };
}

const DENY_PREFIX = [
  'ANTHROPIC_',
  'CLAUDE_',
  'AWS_',
  'GOOGLE_',
  'GCLOUD_',
  'GCP_',
  'AZURE_',
  'CCINFOBAR_',
  'SSH_',
];
const DENY_NAMES = new Set(['NPM_TOKEN', 'NODE_AUTH_TOKEN']);
const GH_TOKENS = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);

export const ghApiHost = (hostname: string): boolean =>
  hostname === 'api.github.com' || hostname.endsWith('.ghe.com');

// gh: only to github hosts or one gh is logged in to
export function envRule(name: string, hostname: string): 'ok' | 'denied' | 'gh' {
  const n = name.toUpperCase();
  if (DENY_NAMES.has(n) || DENY_PREFIX.some((p) => n.startsWith(p))) return 'denied';
  if (GH_TOKENS.has(n)) return ghApiHost(hostname.toLowerCase()) ? 'ok' : 'gh';
  return 'ok';
}

export interface HttpRefusal {
  code: string;
  message: string;
  key: 'url' | 'headers';
}

// gh hosts unknown (undefined): gh tokens are left to the worker
export function httpRefusal(url: string, headers: string, ghHosts?: readonly string[]): HttpRefusal | null {
  const u = parseUrlTemplate(url);
  if (!u.ok) return { code: 'bad-url', message: u.error, key: 'url' };
  const names = parseHeaderSpec(headers).headers.map((h) => h.env);
  if (u.plain && (u.vars.length || names.length))
    return { code: 'insecure-url', message: NEEDS_TLS, key: u.vars.length ? 'url' : 'headers' };
  for (const [key, list] of [
    ['url', u.vars],
    ['headers', names],
  ] as const) {
    for (const name of list) {
      const rule = envRule(name, u.hostname);
      if (rule === 'denied')
        return { code: `env ${name} denied`, message: `env ${name} is not allowed in http items`, key };
      if (rule === 'gh' && ghHosts && !ghHosts.includes(u.hostname))
        return {
          code: `env ${name} denied`,
          message: `env ${name} is sent only to api.github.com, *.ghe.com or a host gh is logged in to`,
          key,
        };
    }
  }
  return null;
}

// what the worker refuses; normalize keeps it so explain can say why
export function httpItemError(url: string, headers: string, ghHosts?: readonly string[]): string | null {
  return httpRefusal(url, headers, ghHosts)?.message ?? null;
}

// env names a url and headers pair sends that need a host gh lists
export function ghTokenNames(url: string, headers: string): string[] {
  const u = parseUrlTemplate(url);
  if (!u.ok) return [];
  const names = [...u.vars, ...parseHeaderSpec(headers).headers.map((h) => h.env)];
  return names.filter((n) => envRule(n, u.hostname) === 'gh');
}

export function resolveUrl(
  raw: string,
  env: Env,
): { ok: true; url: URL } | { ok: false; missing: string } | { ok: false; error: string } {
  const checked = parseUrlTemplate(raw);
  if (!checked.ok) return checked;
  const s = scan(raw);
  if (!s.ok) return s;
  let out = '';
  for (const p of s.parts) {
    if (typeof p === 'string') {
      out += p;
      continue;
    }
    const v = env[p.env];
    if (typeof v !== 'string' || !v) return { ok: false, missing: p.env };
    try {
      out += encodeURIComponent(v);
    } catch {
      return { ok: false, error: `env ${p.env} has an invalid value` };
    }
  }
  const url = parse(out);
  return url ? { ok: true, url } : { ok: false, error: 'not a valid url' };
}
