import { foldSearch } from '../core/i18n/format.js';
import { languageLocale } from '../core/i18n/index.js';
import { categoryText, widgetText } from '../core/i18n/widget-text.js';
import type { WidgetCategory, WidgetDef } from '../core/types.js';
import { ALL_WIDGETS, CATEGORIES } from '../widgets/index.js';

export function categoryOrder(): WidgetCategory[] {
  const ordered: WidgetCategory[] = CATEGORIES.map((c) => c.id);
  for (const w of ALL_WIDGETS) if (!ordered.includes(w.category)) ordered.push(w.category);
  return ordered;
}

function englishCategory(id: WidgetCategory): string {
  return CATEGORIES.find((c) => c.id === id)?.name ?? id;
}

export function categoryName(id: WidgetCategory): string {
  return categoryText(id, englishCategory(id));
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

interface Token {
  plain: string;
  folded: string;
}

function tokenScore(def: WidgetDef, token: Token, locale: string): number | null {
  const { plain, folded } = token;
  const name = def.name.toLowerCase();
  const type = def.type.toLowerCase();
  const english = englishCategory(def.category);
  const cat = english.toLowerCase();
  const shown = widgetText(def, 'name');
  const tname = shown === def.name ? null : foldSearch(shown, locale);
  const shownCat = categoryText(def.category, english);
  const tcat = shownCat === english ? null : foldSearch(shownCat, locale);
  let best: number | null = null;
  const consider = (v: number | null) => {
    if (v !== null && (best === null || v > best)) best = v;
  };
  const byName = (hay: string, t: string) => {
    const at = hay.indexOf(t);
    if (at >= 0) consider(300 - at + (at === 0 ? 100 : 0));
  };
  byName(name, plain);
  if (tname !== null) byName(tname, folded);
  const typeAt = type.indexOf(plain);
  if (typeAt >= 0) consider(250 - typeAt + (typeAt === 0 ? 50 : 0));
  if (cat.includes(plain) || tcat?.includes(folded) || def.category.includes(plain)) consider(150);
  consider(subsequence(name, plain));
  if (tname !== null) consider(subsequence(tname, folded));
  consider(subsequence(type, plain));
  return best;
}

export function widgetScore(def: WidgetDef, filter: string): number | null {
  const locale = languageLocale();
  const tokens = filter
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ({ plain: t.toLowerCase(), folded: foldSearch(t, locale) }));
  let total = 0;
  for (const t of tokens) {
    const s = tokenScore(def, t, locale);
    if (s === null) return null;
    total += s;
  }
  return total;
}

export function pickerItems(filter: string, gsd = true): WidgetDef[] {
  const order = categoryOrder();
  const defs = ALL_WIDGETS.filter((d) => !d.hidden && (gsd || d.category !== 'gsd'));
  const scored = defs
    .map((def, i) => ({ def, i, score: widgetScore(def, filter) }))
    .filter((x): x is { def: WidgetDef; i: number; score: number } => x.score !== null);
  scored.sort(
    (a, b) => order.indexOf(a.def.category) - order.indexOf(b.def.category) || b.score - a.score || a.i - b.i,
  );
  return scored.map((x) => x.def);
}
