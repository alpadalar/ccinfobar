import { metricGetter } from '../core/metrics.js';
import type { ProgressConfig, RenderContext } from '../core/types.js';
import {
  type ProgressState,
  type ProgressWant,
  progressChannel,
  progressFiles,
  readWant,
} from '../data/progress.js';

export { progressChannel };

import { writeAtomic } from '../data/store.js';

export interface ProgressSync {
  changed: boolean;
  want: ProgressWant | null;
}

function metricOf(p: ProgressConfig): string {
  if (p.source === 'usage5h') return 'usage.5h';
  return p.scaleTo === 'autocompact' ? 'context.usable' : 'context.pct';
}

export function progressTarget(
  ctx: RenderContext,
  p: ProgressConfig,
): { state: ProgressState; pct: number } | null {
  const v = metricGetter(ctx)(metricOf(p));
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const pct = Math.max(0, Math.min(100, Math.round(v)));
  const state: ProgressState = pct >= (p.errorAt ?? 80) ? 2 : pct >= (p.warnAt ?? 50) ? 4 : 1;
  return { state, pct };
}

const same = (a: ProgressWant, b: ProgressWant): boolean =>
  a.state === b.state && a.pct === b.pct && a.channel === b.channel && a.always === b.always;

export function syncProgress(
  ctx: RenderContext,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ProgressSync {
  const p = ctx.config.progress;
  if (!p) return { changed: false, want: null };
  const files = progressFiles(ctx.payload.session_id ?? '', env);
  if (!files) return { changed: false, want: null };
  const prev = readWant(files.want);
  const channel = progressChannel(p, platform);
  const always = p.terminals === 'always';
  let next: ProgressWant;
  if (p.enabled === true) {
    const t = progressTarget(ctx, p);
    if (!t) return { changed: false, want: prev };
    next = { v: 1, state: t.state, pct: t.pct, channel, always };
  } else {
    if (!prev || prev.state === 0) return { changed: false, want: prev };
    next = { v: 1, state: 0, pct: 0, channel, always };
  }
  if (prev && same(prev, next)) return { changed: false, want: prev };
  return { changed: writeAtomic(files.want, JSON.stringify(next), { mode: 0o600 }), want: next };
}
