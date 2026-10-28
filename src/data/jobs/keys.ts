import { createHash } from 'node:crypto';
import { normalizeHeaderSpec, parseHeaderSpec } from '../../core/http-spec.js';
import type { Config, OptionValue, StatusPayload } from '../../core/types.js';
import type { JobNetwork } from './runner.js';

export function hash16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// the template, never the env-resolved url
export function httpKey(url: string, headers: string): string {
  return `http-${hash16(`${url}\0${normalizeHeaderSpec(parseHeaderSpec(headers).headers)}`)}`;
}

export function ghKey(param: string): string {
  return `gh-${hash16(param)}`;
}

export const GH_PARAM_RE =
  /^[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*#[1-9]\d{0,9}$/;
export const GH_HOSTS_KEY = 'gh-hosts';

export function ghParam(payload: StatusPayload): string | null {
  const pr = payload?.pr;
  const repo = payload?.workspace?.repo;
  if (!pr || pr.kind === 'mr' || !Number.isInteger(pr.number) || (pr.number ?? 0) <= 0) return null;
  const host = typeof repo?.host === 'string' ? repo.host.toLowerCase() : 'github.com';
  if (typeof repo?.owner !== 'string' || typeof repo?.name !== 'string') return null;
  const p = `${host}/${repo.owner}/${repo.name}#${pr.number}`;
  return GH_PARAM_RE.test(p) ? p : null;
}

// shared by the http job and doctor
export interface HttpGroup {
  key: string;
  url: string;
  headers: string;
  paths: string[];
  intervalS: number;
  timeoutMs: number;
}

const DEFAULT_INTERVAL = 300;
const MIN_INTERVAL = 30;
const DEFAULT_TIMEOUT = 5000;
const MIN_TIMEOUT = 1000;
const MAX_TIMEOUT = 15_000;

const num = (raw: OptionValue | undefined, fallback: number): number => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const text = (raw: OptionValue | undefined): string => (typeof raw === 'string' ? raw : '');

export function httpGroups(config: Pick<Config, 'lines'>): Map<string, HttpGroup> {
  const out = new Map<string, HttpGroup>();
  const lines = Array.isArray(config?.lines) ? config.lines : [];
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    for (const item of line) {
      if (item?.type !== 'http') continue;
      const url = text(item.options?.url);
      if (!url) continue;
      const headers = text(item.options?.headers);
      const path = text(item.options?.path) || '$';
      const interval = Math.max(MIN_INTERVAL, num(item.options?.interval, DEFAULT_INTERVAL));
      const timeout = num(item.options?.timeout, DEFAULT_TIMEOUT);
      const key = httpKey(url, headers);
      const g = out.get(key);
      if (!g) {
        out.set(key, { key, url, headers, paths: [path], intervalS: interval, timeoutMs: timeout });
        continue;
      }
      if (!g.paths.includes(path)) g.paths.push(path);
      g.intervalS = Math.min(g.intervalS, interval);
      g.timeoutMs = Math.max(g.timeoutMs, timeout);
    }
  }
  for (const g of out.values()) g.timeoutMs = Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, g.timeoutMs));
  return out;
}

const NETWORK: [RegExp, JobNetwork][] = [
  [/^(update|status|usage-[0-9a-f]{16})$/, 'auto'],
  [/^(http|gh)-[0-9a-f]{16}$/, 'explicit'],
  [/^(repos-dirty|cmd)-[0-9a-f]{20}$/, 'none'],
];

// doctor reads it without loading the registry; a test keeps it in step
export function keyNetwork(key: string): JobNetwork | null {
  return NETWORK.find(([re]) => re.test(key))?.[1] ?? null;
}
