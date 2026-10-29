import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { cacheKey, readCache, writeCache } from './cache.js';
import { applyLine } from './transcript-parse.js';
import {
  CHUNK,
  emptyState,
  HEAD_BYTES,
  MIN_CHUNK,
  type State,
  TAIL_BYTES,
  TRANSCRIPT_BUDGET,
  TRANSCRIPT_DEADLINE_MS,
  type TranscriptInfo,
  toInfo,
  VERSION,
} from './transcript-state.js';

export { MASK_MAX, MASK_RULES, maskSecrets, shortArg } from './transcript-parse.js';
export type { AgentCall, RunningTool, Todo, TranscriptInfo } from './transcript-state.js';
export { emptyState, TRANSCRIPT_BUDGET } from './transcript-state.js';

function advance(
  s: State,
  fd: number,
  size: number,
  budget = Number.POSITIVE_INFINITY,
  now: () => number = Date.now,
): boolean {
  const st = { prevTs: s.lastTimestamp };
  const started = now();
  const end = Math.min(size, s.offset + Math.max(0, budget));
  const from = s.offset;
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(end - from, MIN_CHUNK)));
  let parts: Buffer[] = [];
  let carryLen = 0;
  let pos = from;
  // a line longer than the budget is read through to its newline
  while (pos < end || (s.offset === from && carryLen > 0 && pos < size)) {
    const limit = pos < end ? end - pos : size - pos;
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, limit), pos);
    if (n <= 0) break;
    pos += n;
    const chunk = buf.subarray(0, n);
    let start = 0;
    let nl = chunk.indexOf(10, start);
    while (nl !== -1) {
      const seg = parts.length
        ? Buffer.concat([...parts, chunk.subarray(start, nl)])
        : chunk.subarray(start, nl);
      parts = [];
      if (seg.length > 0) applyLine(s, seg.toString('utf8'), st);
      start = nl + 1;
      nl = chunk.indexOf(10, start);
    }
    carryLen = n - start + (start === 0 ? carryLen : 0);
    if (start < n) parts.push(Buffer.from(chunk.subarray(start)));
    s.offset = pos - carryLen;
    if (pos < end && now() - started > TRANSCRIPT_DEADLINE_MS) break;
  }
  return pos < size;
}

export function parseTranscriptText(text: string): TranscriptInfo {
  const s = emptyState();
  const st = { prevTs: null as number | null };
  for (const line of text.split('\n')) if (line) applyLine(s, line, st);
  return toInfo(s);
}

export function transcriptCacheName(file: string): string {
  return `transcript-${cacheKey(file)}.json`;
}

function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function headHash(fd: number, size: number): { head: string; headLen: number } {
  const len = Math.min(HEAD_BYTES, size);
  if (len <= 0) return { head: '', headLen: 0 };
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, 0);
  return { head: sha1(buf.subarray(0, n)), headLen: n };
}

function tailHash(fd: number, offset: number): string {
  if (offset <= 0) return '';
  const len = Math.min(TAIL_BYTES, offset);
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, offset - len);
  return sha1(buf.subarray(0, n));
}

function headChanged(fd: number, state: State, h: { head: string; headLen: number }, size: number): boolean {
  if (state.headLen <= 0) return false;
  if (h.headLen === state.headLen) return h.head !== state.head;
  // small file grew past its old head length
  if (state.headLen < HEAD_BYTES && size > state.size && h.headLen > state.headLen) {
    return headHash(fd, state.headLen).head !== state.head;
  }
  return true;
}

export function readTranscript(
  file: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  opts: { persist?: boolean; budget?: number } = {},
): TranscriptInfo | null {
  if (!file) return null;
  let fd: number | null = null;
  try {
    const st = fs.statSync(file);
    const name = transcriptCacheName(file);
    let state = readCache<State>(name, env);
    if (!state || state.v !== VERSION || state.offset > st.size) state = emptyState();
    else if (state.ino !== 0 && st.ino !== 0 && state.ino !== st.ino) state = emptyState();
    // mtime moves on every append; only the anchors decide a reset
    else if (state.complete && st.mtimeMs === state.mtimeMs && st.size === state.size) return toInfo(state);
    fd = fs.openSync(file, 'r');
    const h = headHash(fd, st.size);
    if (
      state.offset > 0 &&
      (headChanged(fd, state, h, st.size) || tailHash(fd, state.offset) !== state.tail)
    ) {
      state = emptyState();
    }
    const budget = opts.budget ?? (opts.persist === false ? Number.POSITIVE_INFINITY : TRANSCRIPT_BUDGET);
    const cut = advance(state, fd, st.size, budget);
    state.ino = st.ino;
    state.mtimeMs = st.mtimeMs;
    state.size = st.size;
    state.head = h.head;
    state.headLen = h.headLen;
    state.tail = tailHash(fd, state.offset);
    state.complete = !cut;
    if (opts.persist !== false) writeCache(name, state, env);
    const info = toInfo(state);
    if (cut) info.partial = true;
    return info;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}
