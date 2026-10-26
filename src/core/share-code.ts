// pure and browser-safe
import { APPEARANCE_KEYS, type EntryContent, LAYOUT_KEYS, parseCols } from './entry-keys.js';
import type { MessageId } from './i18n/index.js';

export const SHARE_PREFIX = 'ccib1:';
export const SHARE_VERSION = 1;
export const MAX_CODE_CHARS = 32768;
export const MAX_JSON_BYTES = 262144;

export interface ShareDoc {
  v: 1;
  content: EntryContent;
  cols?: number;
}

const PREFIX_RE = /^ccib(\d+):/;
const BODY_RE = /^[A-Za-z0-9_-]+$/;
const WRAP_RE = /^[\s"'`<]+|[\s"'`>]+$/g;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function extractCode(input: unknown): { data: string } | { errorId: MessageId } {
  if (typeof input !== 'string') return { errorId: 'err.share.notCode' };
  // a pasted link is read before its size, a giant paste is not
  if (input.length > MAX_CODE_CHARS * 4) return { errorId: 'err.share.tooLong' };
  let s = input.replace(WRAP_RE, '');
  const hash = s.indexOf('#');
  if (hash >= 0) {
    const frag = s.slice(hash + 1);
    s = frag.startsWith('c=') ? frag.slice(2) : frag;
  } else if (s.startsWith('c=')) s = s.slice(2);
  s = s.replace(/\s+/g, '').replace(WRAP_RE, '');
  try {
    if (s.includes('%')) s = decodeURIComponent(s);
  } catch {
    return { errorId: 'err.share.notCode' };
  }
  const m = PREFIX_RE.exec(s);
  if (!m) return { errorId: 'err.share.notCode' };
  if (m[1] !== String(SHARE_VERSION)) return { errorId: 'err.share.version' };
  const data = s.slice(m[0].length);
  if (!data || !BODY_RE.test(data)) return { errorId: 'err.share.notCode' };
  if (SHARE_PREFIX.length + data.length > MAX_CODE_CHARS) return { errorId: 'err.share.tooLong' };
  return { data };
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function keep(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (BAD_KEYS.has(k) || !Object.hasOwn(src, k) || src[k] === undefined) continue;
    out[k] = src[k];
  }
  return out;
}

export function parseShareDoc(raw: unknown): ShareDoc | null {
  if (!isPlain(raw) || raw.v !== SHARE_VERSION || !isPlain(raw.content)) return null;
  const c = raw.content;
  if (Object.keys(c).some((k) => k !== 'layout' && k !== 'appearance' && k !== 'theme')) return null;
  const layout = c.layout;
  if (!isPlain(layout) || !Array.isArray(layout.lines)) return null;
  if (!layout.lines.every((l) => Array.isArray(l) && l.every(isPlain))) return null;
  const content: EntryContent = { layout: keep(layout, LAYOUT_KEYS) as EntryContent['layout'] };
  if (c.appearance !== undefined) {
    if (!isPlain(c.appearance)) return null;
    content.appearance = keep(c.appearance, APPEARANCE_KEYS) as EntryContent['appearance'];
  }
  if (c.theme !== undefined) {
    if (!isPlain(c.theme)) return null;
    content.theme = c.theme as EntryContent['theme'];
  }
  const doc: ShareDoc = { v: 1, content };
  const cols = parseCols(raw.cols);
  if (cols !== undefined) doc.cols = cols;
  return doc;
}
