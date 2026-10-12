import { BUILTIN_THEMES } from '../core/themes.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import type { ImportResult } from './index.js';

type Raw = Record<string, unknown>;

const SAME = new Set([
  'model',
  'output-style',
  'session-name',
  'vim-mode',
  'skills',
  'context-length',
  'context-percentage',
  'context-bar',
  'tokens-input',
  'tokens-output',
  'tokens-cached',
  'tokens-total',
  'cache-hit-rate',
  'cache-timer',
  'output-speed',
  'session-cost',
  'weekly-usage',
  'weekly-sonnet-usage',
  'weekly-opus-usage',
  'git-branch',
  'git-sha',
  'git-changes',
  'git-staged',
  'git-unstaged',
  'git-untracked',
  'git-conflicts',
  'git-ahead-behind',
  'git-status',
  'git-worktree',
  'terminal-width',
  'link',
]);

const RENAMED: Record<string, { type: string; options?: Record<string, OptionValue> }> = {
  'thinking-effort': { type: 'effort' },
  'claude-session-id': { type: 'session-id' },
  version: { type: 'claude-version' },
  'context-percentage-usable': { type: 'context-percentage', options: { usable: true } },
  'context-window': { type: 'context-window-size' },
  'compaction-counter': { type: 'compactions' },
  'cache-read': { type: 'tokens-cached' },
  'session-cost-rate': { type: 'cost-rate' },
  'session-clock': { type: 'session-duration' },
  'session-usage': { type: 'five-hour-usage' },
  'reset-timer': { type: 'five-hour-reset' },
  'weekly-reset-timer': { type: 'weekly-reset' },
  'fable-weekly-usage': { type: 'weekly-model-usage', options: { model: 'Fable' } },
  'extra-usage-used': { type: 'spend-limit' },
  'git-clean-status': { type: 'git-status' },
  'git-insertions': { type: 'git-changes' },
  'git-deletions': { type: 'git-changes' },
  'git-origin-owner-repo': { type: 'git-repo' },
  'git-origin-repo': { type: 'git-repo', options: { nameOnly: true } },
  'git-review': { type: 'pr' },
  'git-root-dir': { type: 'project-dir' },
  'worktree-name': { type: 'git-worktree' },
  'current-working-dir': { type: 'cwd' },
  'free-memory': { type: 'memory' },
  'flex-separator': { type: 'flex' },
};

export function convertColor(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  let c = v.trim();
  if (/^bg[A-Z]/.test(c)) c = c[2]!.toLowerCase() + c.slice(3);
  if (c.startsWith('hex:')) return `#${c.slice(4)}`;
  if (/^ansi256:\d+$/.test(c) || /^#[0-9a-f]{3,6}$/i.test(c)) return c;
  if (/^(black|red|green|yellow|blue|magenta|cyan|white|gray|grey|bright[A-Z]\w+)$/.test(c)) return c;
  return undefined;
}

function convertItem(raw: Raw, warnings: string[]): WidgetItem | null {
  const type = String(raw.type ?? '');
  const id = String(raw.id ?? type);
  let item: WidgetItem;
  if (SAME.has(type)) item = { id, type };
  else if (RENAMED[type]) {
    const r = RENAMED[type]!;
    item = { id, type: r.type, ...(r.options ? { options: { ...r.options } } : {}) };
  } else if (type === 'custom-text' || type === 'custom-symbol') {
    const text = String(raw.customText ?? raw.customSymbol ?? '');
    if (!text) return null;
    item = { id, type: 'text', options: { text } };
  } else if (type === 'custom-command') {
    if (typeof raw.commandPath !== 'string' || !raw.commandPath) return null;
    item = { id, type: 'command', options: { command: raw.commandPath } };
    if (typeof raw.timeout === 'number') item.options!.timeout = raw.timeout;
    if (raw.preserveColors === true) item.options!.preserveColors = true;
  } else if (type === 'separator') {
    item = {
      id,
      type: 'separator',
      options: { char: typeof raw.character === 'string' ? raw.character : '|' },
    };
  } else {
    warnings.push(`ccstatusline widget "${type}" has no ccinfobar equivalent and was skipped`);
    return null;
  }
  const meta = (raw.metadata ?? {}) as Record<string, string>;
  if (type === 'skills' && meta.mode) item.options = { ...item.options, mode: meta.mode };
  const color = convertColor(raw.color);
  if (color) item.color = color;
  const bg = convertColor(raw.backgroundColor);
  if (bg) item.background = bg;
  if (raw.bold === true) item.bold = true;
  if (raw.dim === true || raw.dim === 'parens') item.dim = true;
  if (raw.rawValue === true) item.raw = true;
  if (raw.merge === true || raw.merge === 'no-padding') item.merge = true;
  return item;
}

export function importCcstatusline(raw: unknown): ImportResult {
  const warnings: string[] = [];
  const s = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const lines = Array.isArray(s.lines) ? (s.lines as unknown[]) : [];
  const config: Partial<Config> = {
    lines: lines.map((line) =>
      (Array.isArray(line) ? (line as Raw[]) : [])
        .map((it) => convertItem(it, warnings))
        .filter((it): it is WidgetItem => it !== null),
    ),
    separator: ' ',
  };
  const hasSeparatorWidgets = config.lines!.some((l) => l.some((i) => i.type === 'separator'));
  if (!hasSeparatorWidgets && typeof s.defaultSeparator === 'string')
    config.separator = ` ${s.defaultSeparator} `;
  if (s.globalBold === true) for (const l of config.lines!) for (const i of l) i.bold ??= true;
  if (s.flexMode === 'full-minus-40') config.widthOffset = 40;
  if (typeof s.colorLevel === 'number' && s.colorLevel >= 0 && s.colorLevel <= 3) {
    config.colorLevel = s.colorLevel as 0 | 1 | 2 | 3;
  }
  const pl = (s.powerline ?? {}) as Raw;
  if (pl.enabled === true) {
    config.style = 'powerline';
    config.separator = undefined;
    config.lines = config.lines!.map((l) => l.filter((i) => i.type !== 'separator'));
    const sep = Array.isArray(pl.separators) ? pl.separators[0] : undefined;
    const start = Array.isArray(pl.startCaps) ? pl.startCaps[0] : undefined;
    const end = Array.isArray(pl.endCaps) ? pl.endCaps[0] : undefined;
    config.glyphs = {
      ...(typeof sep === 'string' ? { separator: sep } : {}),
      ...(typeof start === 'string' ? { startCap: start } : {}),
      endCap: typeof end === 'string' ? end : '',
    };
    const theme = typeof pl.theme === 'string' ? pl.theme : '';
    config.theme = BUILTIN_THEMES.some((t) => t.id === theme) ? theme : 'powerline';
  }
  return { config, warnings, source: 'ccstatusline' };
}
