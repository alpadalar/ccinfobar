import { parseHeaderSpec } from './http-spec.js';
import { t } from './i18n/index.js';
import type { Config } from './types.js';

// doctor and explain only, so the render does not load it
type Env = Record<string, string | undefined>;

const URL_BAD = /[\u0000-\u0020\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function parse(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

const TOKENISH = /^[A-Za-z0-9_.:%+=~-]+$/;

// webhook and bot urls keep their secret in the path
const pathSegment = (seg: string): string =>
  TOKENISH.test(seg) && (seg.length >= 24 || (seg.length >= 12 && /\d/.test(seg) && /[A-Za-z]/.test(seg)))
    ? '\u2026'
    : seg;

export function redactUrl(raw: string): string {
  const url = typeof raw === 'string' && !URL_BAD.test(raw) ? parse(raw) : null;
  if (!url) return t('err.http.invalidUrl');
  const base = `${url.protocol}//${url.host}${url.pathname.split('/').map(pathSegment).join('/')}`;
  const query = url.search.slice(1);
  if (!query) return base;
  const pairs = query.split('&').map((p) => {
    const eq = p.indexOf('=');
    return eq === -1 ? '\u2026' : `${p.slice(0, eq)}=\u2026`;
  });
  return `${base}?${pairs.join('&')}`;
}

export function describeHeaders(spec: string, env: Env): string[] {
  return parseHeaderSpec(spec).headers.map((h) =>
    t(env[h.env] ? 'doctor.http.envSet' : 'doctor.http.envUnset', { name: `${h.name}=$${h.env}` }),
  );
}

export interface ExternalTarget {
  kind: 'command' | 'http';
  line: number;
  index: number;
  target: string;
}

export function externalTargets(config: Pick<Config, 'lines'>): ExternalTarget[] {
  const out: ExternalTarget[] = [];
  const lines = Array.isArray(config?.lines) ? config.lines : [];
  lines.forEach((items, line) => {
    if (!Array.isArray(items)) return;
    items.forEach((item, index) => {
      const opts = item?.options;
      if (!opts) return;
      if (item.type === 'command' && typeof opts.command === 'string' && opts.command.trim()) {
        out.push({ kind: 'command', line, index, target: opts.command });
      } else if (item.type === 'http' && typeof opts.url === 'string' && opts.url) {
        out.push({ kind: 'http', line, index, target: opts.url });
      }
    });
  });
  return out;
}
