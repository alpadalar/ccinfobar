import { ALL_WIDGETS, CATEGORIES } from '../widgets/index.js';
import type { WidgetCategory, WidgetDef } from '../core/types.js';

export function categoryOrder(): WidgetCategory[] {
  const ids = CATEGORIES.map((c) => c.id);
  const ordered: WidgetCategory[] = ['gsd', ...ids.filter((c) => c !== 'gsd')];
  for (const w of ALL_WIDGETS) if (!ordered.includes(w.category)) ordered.push(w.category);
  return ordered;
}

export function categoryName(id: WidgetCategory): string {
  return CATEGORIES.find((c) => c.id === id)?.name ?? id;
}

function subsequence(hay: string, needle: string): number | null {
  let at = -1;
  let gaps = 0;
  for (const ch of needle) {
    const next = hay.indexOf(ch, at + 1);
    if (next < 0) return null;
    if (at >= 0) gaps += next - at - 1;
    at = next;
  }
  return Math.max(1, 30 - gaps);
}

function tokenScore(def: WidgetDef, token: string): number | null {
  const name = def.name.toLowerCase();
  const type = def.type.toLowerCase();
  const cat = categoryName(def.category).toLowerCase();
  let best: number | null = null;
  const consider = (v: number | null) => {
    if (v !== null && (best === null || v > best)) best = v;
  };
  const nameAt = name.indexOf(token);
  if (nameAt >= 0) consider(300 - nameAt + (nameAt === 0 ? 100 : 0));
  const typeAt = type.indexOf(token);
  if (typeAt >= 0) consider(250 - typeAt + (typeAt === 0 ? 50 : 0));
  const catAt = cat.indexOf(token);
  if (catAt >= 0 || def.category.includes(token)) consider(150);
  consider(subsequence(name, token));
  consider(subsequence(type, token));
  return best;
}

export function widgetScore(def: WidgetDef, filter: string): number | null {
  const tokens = filter.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const t of tokens) {
    const s = tokenScore(def, t);
    if (s === null) return null;
    total += s;
  }
  return total;
}

export function pickerItems(filter: string): WidgetDef[] {
  const order = categoryOrder();
  const scored = ALL_WIDGETS.map((def, i) => ({ def, i, score: widgetScore(def, filter) })).filter(
    (x): x is { def: WidgetDef; i: number; score: number } => x.score !== null,
  );
  scored.sort(
    (a, b) =>
      order.indexOf(a.def.category) - order.indexOf(b.def.category) || b.score - a.score || a.i - b.i,
  );
  return scored.map((x) => x.def);
}
