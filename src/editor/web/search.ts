import { foldSearch } from '../../core/i18n/format.js';
import { languageLocale } from '../../core/i18n/index.js';
import { categoryText, type DefLike, widgetText } from '../../core/i18n/widget-text.js';

export function paletteMatches(w: DefLike, catId: string, catEnglish: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const plain = q.toLowerCase();
  if ([w.name, w.type, w.description, catEnglish].some((s) => s.toLowerCase().includes(plain))) return true;
  const shown = [
    [widgetText(w, 'name'), w.name],
    [widgetText(w, 'description'), w.description],
    [categoryText(catId, catEnglish), catEnglish],
  ].filter(([s, english]) => s !== english);
  if (!shown.length) return false;
  const locale = languageLocale();
  const folded = foldSearch(q, locale);
  return shown.some(([s]) => foldSearch(s!, locale).includes(folded));
}
