import { externalTargets } from '../core/http-report.js';
import { type MessageId, t } from '../core/i18n/index.js';
import { deepSanitize, safeConfigUrl, sanitizeText } from '../core/sanitize.js';
import type { Config, WidgetItem } from '../core/types.js';
import { charWidth, truncate, visibleWidth } from '../core/width.js';
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

export const MAX_TARGET_CHARS = 2000;

// characters a terminal shows as nothing or as a plain space
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u115f\u1160\u3164\uffa0\u2800]|\u034f|[\u180b-\u180f]|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/gu;

const codePoint = (c: string) =>
  `\u27e8U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}\u27e9`;

export function visibleTarget(s: string): string {
  return s.replace(INVISIBLE, codePoint).replace(/ {3,}/g, (m) => t('import.spaces', { count: m.length }));
}

export function wrapLine(text: string, width: number, indent: string): string[] {
  const max = Math.max(visibleWidth(indent) + 4, width);
  const out: string[] = [];
  let line = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (w + cw > max && line.trim()) {
      out.push(line);
      line = indent;
      w = visibleWidth(indent);
    }
    line += ch;
    w += cw;
  }
  out.push(line);
  return out;
}

export const shortTarget = (s: string, max = 60): string => truncate(visibleTarget(sanitizeText(s)), max);

const KINDS: Record<ImportTarget['kind'], MessageId> = {
  command: 'import.kind.command',
  http: 'import.kind.http',
  link: 'import.kind.link',
};

export const kindText = (kind: ImportTarget['kind']): string => t(KINDS[kind]);

export function sanitizeImport(result: ImportResult): ImportResult {
  const config = deepSanitize(result.config);
  const notes = result.notes.map((n) => ({ ...n, text: sanitizeText(n.text) }));
  // a multi-line command runs differently once its line breaks are spaces
  const before = new Map(importTargets(result.config).map((x) => [`${x.line}:${x.index}`, x.target]));
  for (const x of importTargets(config)) {
    const raw = before.get(`${x.line}:${x.index}`);
    if (raw === undefined || raw === x.target) continue;
    notes.push({
      kind: 'approx',
      text: t('import.note.targetChanged', { kind: kindText(x.kind), target: shortTarget(x.target) }),
    });
  }
  const unsafe: ImportTarget[] = [];
  for (const x of importTargets(config)) {
    if (x.kind !== 'link' || safeConfigUrl(x.target)) continue;
    unsafe.push(x);
    notes.push({ kind: 'drop', text: t('import.note.unsafeLink', { url: shortTarget(x.target) }) });
  }
  return { ...result, config: unsafe.length ? dropTargets(config, unsafe) : config, notes };
}
