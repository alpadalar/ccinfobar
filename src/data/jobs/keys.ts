import { createHash } from 'node:crypto';
import { normalizeHeaderSpec, parseHeaderSpec } from '../../core/http-spec.js';

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
