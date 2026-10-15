import { externalTargets } from '../core/http-report.js';
import { t } from '../core/i18n/index.js';
import { deepSanitize, safeConfigUrl, sanitizeText } from '../core/sanitize.js';
import type { Config, WidgetItem } from '../core/types.js';
import { truncate } from '../core/width.js';
import type { ImportResult } from './index.js';

export interface ImportTarget {
  kind: 'command' | 'http' | 'link';
  line: number;
  index: number;
  target: string;
}

const linesOf = (config: Partial<Config>): unknown[] => (Array.isArray(config?.lines) ? config.lines : []);

const linkUrl = (item: unknown): string | null => {
  const it = item as WidgetItem | null;
  const url = it?.type === 'link' ? it.options?.url : undefined;
  return typeof url === 'string' && url ? url : null;
};

export function importTargets(config: Partial<Config>): ImportTarget[] {
  const out: ImportTarget[] = externalTargets({ lines: linesOf(config) as Config['lines'] });
  linesOf(config).forEach((items, line) => {
    if (!Array.isArray(items)) return;
    items.forEach((item, index) => {
      const url = linkUrl(item);
      if (url) out.push({ kind: 'link', line, index, target: url });
    });
  });
  return out.sort((a, b) => a.line - b.line || a.index - b.index);
}

export function dropTargets(config: Partial<Config>, targets: ImportTarget[]): Partial<Config> {
  if (!Array.isArray(config.lines)) return config;
  const gone = new Set(targets.map((x) => `${x.line}:${x.index}`));
  const lines = config.lines.map((items, line) =>
    Array.isArray(items) ? items.filter((_, index) => !gone.has(`${line}:${index}`)) : items,
  );
  return { ...config, lines };
}

export const shortTarget = (s: string, max = 60): string => truncate(sanitizeText(s), max);

export function sanitizeImport(result: ImportResult): ImportResult {
  const config = deepSanitize(result.config);
  const notes = result.notes.map((n) => ({ ...n, text: sanitizeText(n.text) }));
  const unsafe: ImportTarget[] = [];
  for (const x of importTargets(config)) {
    if (x.kind !== 'link' || safeConfigUrl(x.target)) continue;
    unsafe.push(x);
    notes.push({ kind: 'drop', text: t('import.note.unsafeLink', { url: shortTarget(x.target) }) });
  }
  return { ...result, config: unsafe.length ? dropTargets(config, unsafe) : config, notes };
}
