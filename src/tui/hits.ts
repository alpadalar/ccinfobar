import type { Position } from '../core/edit.js';

export type Hit =
  | { kind: 'chip'; line: number; index: number; x: number; y: number; w: number }
  | { kind: 'line'; line: number; y: number; count: number }
  | { kind: 'item'; area: 'main' | 'sub'; index: number; x: number; y: number; w: number };

export function shiftHits(hits: Hit[], dy: number): Hit[] {
  return hits.map((h) => ({ ...h, y: h.y + dy }));
}

export function chipAt(hits: Hit[], x: number, y: number): Extract<Hit, { kind: 'chip' }> | null {
  for (const h of hits) {
    if (h.kind === 'chip' && h.y === y && x >= h.x && x < h.x + h.w) return h;
  }
  return null;
}

export function dropTarget(hits: Hit[], x: number, y: number): Position | null {
  const row = hits.find((h): h is Extract<Hit, { kind: 'line' }> => h.kind === 'line' && h.y === y);
  if (!row) return null;
  const chips = hits.filter((h): h is Extract<Hit, { kind: 'chip' }> => h.kind === 'chip' && h.y === y);
  if (!chips.length) return { line: row.line, index: row.count };
  for (const c of chips) {
    if (x < c.x + Math.ceil(c.w / 2)) return { line: c.line, index: c.index };
  }
  const last = chips[chips.length - 1]!;
  return { line: last.line, index: last.index + 1 };
}

export function itemAt(hits: Hit[], x: number, y: number): Extract<Hit, { kind: 'item' }> | null {
  for (const h of hits) {
    if (h.kind === 'item' && h.y === y && x >= h.x && x < h.x + h.w) return h;
  }
  return null;
}
