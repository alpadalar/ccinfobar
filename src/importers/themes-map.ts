import '../core/i18n/lazy.js';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { ImportNote } from './index.js';

export interface ThemeTable {
  exact: Record<string, string>;
  approx?: Record<string, string>;
  fallback?: string;
}

export function mapTheme(
  name: unknown,
  table: ThemeTable,
  tool: string,
): { theme: string; notes: ImportNote[] } {
  const key = typeof name === 'string' ? name.trim().toLowerCase() : null;
  if (key !== null && Object.hasOwn(table.exact, key)) return { theme: table.exact[key]!, notes: [] };
  const shown = sanitizeText(typeof name === 'string' ? name.trim() : String(name));
  if (key !== null && table.approx && Object.hasOwn(table.approx, key)) {
    const theme = table.approx[key]!;
    return {
      theme,
      notes: [{ kind: 'approx', text: t('import.note.themeApprox', { tool, name: shown, theme }) }],
    };
  }
  const theme = table.fallback ?? 'classic';
  return {
    theme,
    notes: [{ kind: 'info', text: t('import.note.themeMissing', { tool, name: shown, theme }) }],
  };
}
