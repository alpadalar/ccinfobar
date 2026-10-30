import { windowOf } from '../rules.js';

export const MEMORY_LIMITS = { r: 60, w: 30, a: 20 } as const;

const MEMORY_KEYS = 5_000;

// per isolate; resets each window
export class MemoryLimiter {
  private win = -1;
  private n = new Map<string, number>();

  hit(key: string, limit: number, now: number): boolean {
    const w = windowOf(now);
    if (w > this.win) {
      this.win = w;
      this.n.clear();
    } else if (w < this.win) return true;
    if (!this.n.has(key) && this.n.size >= MEMORY_KEYS) this.n.clear();
    const c = (this.n.get(key) ?? 0) + 1;
    this.n.set(key, c);
    return c <= limit;
  }

  get size(): number {
    return this.n.size;
  }
}

const DO_KEYS = 10_000;

export const SHARDS = 16;

// a full shard counts untracked keys together at limit x this
export const OVERFLOW_FACTOR = 20;

// fnv-1a; the same key always lands on the same counter
export function shardOf(key: string): number {
  let h = 0x811c9dc5 ^ 0x5bd1e995;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 0) % SHARDS;
}

const isCount = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;

// Durable Object class; memory only, no storage rows
export class RateCounter {
  private win = Number.NaN;
  private n = new Map<string, number>();
  private over = 0;

  constructor(_state: unknown, _env: unknown) {}

  async fetch(req: Request): Promise<Response> {
    let body: { key?: unknown; limit?: unknown; win?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false }, { status: 400 });
    }
    const { key, limit, win } = body ?? {};
    if (
      typeof key !== 'string' ||
      !key ||
      key.length > 80 ||
      !isCount(limit, 1000) ||
      typeof win !== 'number' ||
      !Number.isFinite(win)
    )
      return Response.json({ ok: false }, { status: 400 });
    if (Number.isNaN(this.win) || win > this.win) {
      this.win = win;
      this.n.clear();
      this.over = 0;
    } else if (win < this.win) return Response.json({ ok: true });
    // full: untracked keys share one generous count; tracked keys keep their own
    if (!this.n.has(key) && this.n.size >= DO_KEYS) {
      this.over++;
      const out = { ok: this.over <= limit * OVERFLOW_FACTOR, overflow: true };
      return Response.json(this.over === 1 ? { ...out, first: true } : out);
    }
    const c = (this.n.get(key) ?? 0) + 1;
    this.n.set(key, c);
    return Response.json({ ok: c <= limit });
  }
}
