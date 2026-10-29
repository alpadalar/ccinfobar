import { windowOf } from '../rules.js';

export const MEMORY_LIMITS = { r: 60, w: 30, a: 20 } as const;

const MEMORY_KEYS = 5_000;

// per isolate; resets each window
export class MemoryLimiter {
  private win = -1;
  private n = new Map<string, number>();

  hit(key: string, limit: number, now: number): boolean {
    const w = windowOf(now);
    if (w !== this.win) {
      this.win = w;
      this.n.clear();
    }
    if (!this.n.has(key) && this.n.size >= MEMORY_KEYS) this.n.clear();
    const c = (this.n.get(key) ?? 0) + 1;
    this.n.set(key, c);
    return c <= limit;
  }

  get size(): number {
    return this.n.size;
  }
}
