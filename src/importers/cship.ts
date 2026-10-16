import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { starshipStyle } from './colors.js';
import type { ImportNote, ImportResult } from './index.js';

const TOOL = 'cship';

type Raw = Record<string, unknown>;

export type CshipToken =
  | { kind: 'text'; text: string }
  | { kind: 'span'; text: string; style: string }
  | { kind: 'var'; name: string };

// mirrors cship's parse_line
export function parseCshipLine(line: string): CshipToken[] {
  const out: CshipToken[] = [];
  let pos = 0;
  while (pos < line.length) {
    const rest = line.slice(pos);
    if (rest[0] === '[') {
      const close = rest.indexOf('](', 1);
      const paren = close < 0 ? -1 : rest.indexOf(')', close + 2);
      if (paren < 0) {
        out.push({ kind: 'text', text: '[' });
        pos += 1;
      } else {
        out.push({ kind: 'span', text: rest.slice(1, close), style: rest.slice(close + 2, paren) });
        pos += paren + 1;
      }
      continue;
    }
    const next = rest.search(/[$[]/);
    if (next < 0) {
      out.push({ kind: 'text', text: rest });
      break;
    }
    if (next > 0) {
      out.push({ kind: 'text', text: rest.slice(0, next) });
      pos += next;
      continue;
    }
    const name = /^[^\s[$]*/.exec(rest.slice(1))![0];
    if (name) out.push({ kind: 'var', name });
    pos += 1 + name.length;
  }
  return out;
}

const unquote = (s: string) => s.replace(/"([^"]*)"|'([^']*)'/g, '$1$2');

export function parseCshipConfigFlag(command: string): string | null {
  const args = [...command.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g)].map((m) => unquote(m[0]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--config' && i + 1 < args.length) return args[i + 1]! || null;
    if (a.startsWith('--config=')) return a.slice(9) || null;
  }
  return null;
}

type Use = [string, Record<string, OptionValue>?];

interface Module {
  table: string;
  sub?: string;
  uses: Use[];
  approx?: boolean;
}

const mod = (table: string, uses: Use[], sub?: string, approx?: boolean): Module => ({
  table,
  uses,
  ...(sub ? { sub } : {}),
  ...(approx ? { approx } : {}),
});

const FULL = { style: 'full' };

export const CSHIP_MODULES: Record<string, Module | null> = {
  'cship.model': mod('model', [['model']]),
  'cship.model.display_name': mod('model', [['model']]),
  'cship.model.id': mod('model', [['model', { showId: true }]]),
  'cship.cost': mod('cost', [['session-cost']]),
  'cship.cost.total_cost_usd': mod('cost', [['session-cost']], 'total_cost_usd'),
  'cship.cost.total_duration_ms': mod('cost', [['session-duration']], 'total_duration_ms'),
  'cship.cost.total_duration': mod('cost', [['session-duration']], 'total_duration_ms'),
  'cship.cost.total_api_duration_ms': mod('cost', [['api-duration']], 'total_api_duration_ms'),
  'cship.cost.total_api_duration': mod('cost', [['api-duration']], 'total_api_duration_ms'),
  'cship.cost.total_lines_added': mod('cost', [['lines-changed']], 'total_lines_added', true),
  'cship.cost.total_lines_removed': mod('cost', [['lines-changed']], 'total_lines_removed', true),
  'cship.context_bar': mod('context_bar', [['context-bar']]),
  'cship.context_window': mod('context_window', [['context-percentage']]),
  'cship.context_window.used_percentage': mod('context_window', [['context-percentage']], 'used_percentage'),
  'cship.context_window.remaining_percentage': mod(
    'context_window',
    [['context-percentage']],
    'remaining_percentage',
    true,
  ),
  'cship.context_window.size': mod('context_window', [['context-window-size']], 'size'),
  'cship.context_window.total_input_tokens': mod('context_window', [['tokens-input']], 'total_input_tokens'),
  'cship.context_window.total_output_tokens': mod(
    'context_window',
    [['tokens-output']],
    'total_output_tokens',
  ),
  'cship.context_window.used_tokens': mod('context_window', [['context-length']], 'used_tokens'),
  'cship.context_window.current_usage.input_tokens': mod(
    'context_window',
    [['tokens-input']],
    'current_usage_input_tokens',
    true,
  ),
  'cship.context_window.current_usage.output_tokens': mod(
    'context_window',
    [['tokens-output']],
    'current_usage_output_tokens',
    true,
  ),
  'cship.context_window.current_usage.cache_creation_input_tokens': mod(
    'context_window',
    [['tokens-cached']],
    'current_usage_cache_creation_input_tokens',
    true,
  ),
  'cship.context_window.current_usage.cache_read_input_tokens': mod(
    'context_window',
    [['tokens-cached']],
    'current_usage_cache_read_input_tokens',
    true,
  ),
  'cship.context_window.exceeds_200k': null,
  'cship.usage_limits': mod('usage_limits', [['five-hour-usage'], ['weekly-usage']]),
  'cship.usage_limits.five_hour': mod('usage_limits', [['five-hour-usage']]),
  'cship.usage_limits.session': mod('usage_limits', [['five-hour-usage']]),
  'cship.usage_limits.seven_day': mod('usage_limits', [['weekly-usage']]),
  'cship.usage_limits.weekly': mod('usage_limits', [['weekly-usage']]),
  'cship.usage_limits.opus': mod('usage_limits', [['weekly-model-usage', { model: 'Opus' }]]),
  'cship.usage_limits.sonnet': mod('usage_limits', [['weekly-model-usage', { model: 'Sonnet' }]]),
  'cship.usage_limits.per_model': mod('usage_limits', [['weekly-model-usage']], undefined, true),
  'cship.usage_limits.extra_usage': mod('usage_limits', [['spend-limit']]),
  'cship.usage_limits.cowork': null,
  'cship.usage_limits.oauth_apps': null,
  'cship.vim': mod('vim', [['vim-mode']]),
  'cship.vim.mode': mod('vim', [['vim-mode']]),
  'cship.agent': mod('agent', [['agent-name']]),
  'cship.agent.name': mod('agent', [['agent-name']]),
  'cship.effort': mod('effort', [['effort']]),
  'cship.effort.level': mod('effort', [['effort']]),
  'cship.cwd': mod('session', [['cwd', FULL]]),
  'cship.session_id': mod('session', [['session-id']]),
  'cship.version': mod('session', [['claude-version']]),
  'cship.output_style': mod('session', [['output-style']]),
  'cship.workspace.current_dir': mod('workspace', [['cwd', FULL]]),
  'cship.workspace.project_dir': mod('workspace', [['project-dir', FULL]]),
  'cship.transcript_path': null,
  'cship.peak_usage': null,
  'cship.account': null,
};

export const STARSHIP_MODULES: Record<string, Use> = {
  git_branch: ['git-branch'],
  git_status: ['git-status'],
  git_commit: ['git-sha'],
  git_state: ['git-operation'],
  git_metrics: ['git-changes'],
  directory: ['cwd', { style: 'segments', segments: 3 }],
  hostname: ['hostname'],
  username: ['username'],
  time: ['clock', { seconds: true }],
  memory_usage: ['memory'],
};

// widgets with the thresholdColors option
export const THRESHOLD_TARGETS: readonly string[] = [
  'context-bar',
  'context-percentage',
  'five-hour-usage',
  'weekly-usage',
  'weekly-model-usage',
];

export const TARGETS: readonly string[] = [
  ...new Set([
    ...Object.values(CSHIP_MODULES).flatMap((m) => (m ? m.uses.map((u) => u[0]) : [])),
    ...Object.values(STARSHIP_MODULES).map((u) => u[0]),
    'flex',
    'text',
  ]),
];

const DEFAULT_FORMATS = new Set(['[$symbol$value]($style)', '$symbol$value']);
const HANDLED = new Set([
  'style',
  'symbol',
  'disabled',
  'label',
  'ttl',
  'warn_threshold',
  'warn_style',
  'critical_threshold',
  'critical_style',
  'invert_threshold',
]);

const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

type Piece = { item: WidgetItem } | { gap: string; soft?: boolean };

interface State {
  notes: ImportNote[];
  n: number;
  spans: number;
}

function styled(it: WidgetItem, style: unknown, st: State, name: string, keepColor = true): void {
  if (typeof style !== 'string') return;
  const s = starshipStyle(style);
  if (s.color && keepColor) it.color = s.color;
  if (s.background) it.background = s.background;
  if (s.bold) it.bold = true;
  if (s.italic) it.italic = true;
  if (s.dim) it.dim = true;
  if (s.unknown.length) {
    const tokens = s.unknown.map(sanitizeText).join(', ');
    st.notes.push({ kind: 'approx', text: t('import.note.unknownStyle', { tool: TOOL, name, tokens }) });
  }
}

const nextId = (st: State) => `cship-${++st.n}`;

function moduleItems(name: string, m: Module, cfg: Raw, st: State): WidgetItem[] {
  const parent = obj(cfg[m.table]);
  const sub = m.sub ? obj(parent[m.sub]) : {};
  if (parent.disabled === true || sub.disabled === true) return [];
  const conf: Raw = { ...parent, ...sub };
  const shown = sanitizeText(name);
  const widget = m.uses.map((u) => u[0]).join(', ');
  if (m.approx) {
    st.notes.push({
      kind: 'approx',
      text: t('import.note.moduleApprox', { tool: TOOL, name: shown, widget }),
    });
  }
  const thresholds = isNum(conf.warn_threshold) || isNum(conf.critical_threshold);
  const colored = m.uses.some((u) => THRESHOLD_TARGETS.includes(u[0]));
  if (thresholds) {
    const id = colored ? 'import.note.thresholdColors' : 'import.note.noThreshold';
    st.notes.push({ kind: 'approx', text: t(id, { tool: TOOL, name: shown, widget }) });
  }
  const ignored = Object.keys(conf).filter((k) => {
    const v = conf[k];
    if (HANDLED.has(k) || (v && typeof v === 'object' && !Array.isArray(v))) return false;
    if (k === 'format') return typeof v !== 'string' || !DEFAULT_FORMATS.has(v.replace(/\s+/g, ''));
    return !(k === 'width' && m.table === 'context_bar' && isNum(v));
  });
  if (ignored.length) {
    const options = ignored.map(sanitizeText).join(', ');
    st.notes.push({
      kind: 'approx',
      text: t('import.note.moduleOptions', { tool: TOOL, name: shown, options }),
    });
  }
  return m.uses.map(([type, base]) => {
    const options: Record<string, OptionValue> = { ...base };
    if (THRESHOLD_TARGETS.includes(type)) options.thresholdColors = thresholds;
    if (type === 'context-bar' && isNum(conf.width)) options.width = Math.max(1, Math.round(conf.width));
    const it: WidgetItem = { id: nextId(st), type };
    if (Object.keys(options).length) it.options = options;
    if (m.table !== 'usage_limits') it.label = typeof conf.symbol === 'string' ? conf.symbol : '';
    styled(it, conf.style, st, shown, !(thresholds && colored));
    return it;
  });
}

function varPieces(name: string, cfg: Raw, st: State): Piece[] {
  const shown = sanitizeText(name);
  if (name === 'fill') {
    const fill = obj(cfg.fill);
    if (fill.disabled === true) return [];
    const symbol = typeof fill.symbol === 'string' ? fill.symbol : '.';
    if (symbol !== ' ') {
      st.notes.push({
        kind: 'approx',
        text: t('import.note.fillChar', { tool: TOOL, symbol: sanitizeText(symbol) }),
      });
    }
    return [{ item: { id: nextId(st), type: 'flex' } }];
  }
  if (name === 'starship_prompt') {
    if (obj(cfg.starship_prompt).disabled !== true) {
      st.notes.push({ kind: 'drop', text: t('import.note.starshipPrompt', { tool: TOOL }) });
    }
    return [];
  }
  if (name.startsWith('cship.')) {
    const m = Object.hasOwn(CSHIP_MODULES, name) ? CSHIP_MODULES[name] : null;
    if (!m) {
      st.notes.push({ kind: 'drop', text: t('import.note.noModule', { tool: TOOL, name: shown }) });
      return [];
    }
    return moduleItems(name, m, cfg, st).flatMap((item, i): Piece[] =>
      i ? [{ gap: ' ', soft: true }, { item }] : [{ item }],
    );
  }
  const use = Object.hasOwn(STARSHIP_MODULES, name) ? STARSHIP_MODULES[name] : undefined;
  if (!use) {
    st.notes.push({ kind: 'drop', text: t('import.note.starshipModule', { tool: TOOL, name: shown }) });
    return [];
  }
  const [type, options] = use;
  return [{ item: { id: nextId(st), type, ...(options ? { options: { ...options } } : {}) } }];
}

function textPieces(text: string, st: State, style?: string): Piece[] {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  const [, lead, core, trail] = m as unknown as [string, string, string, string];
  const out: Piece[] = [];
  if (lead) out.push({ gap: lead });
  if (core) {
    const it: WidgetItem = { id: nextId(st), type: 'text', options: { text: core } };
    if (style !== undefined) styled(it, style, st, sanitizeText(`[${core}]`));
    out.push({ item: it });
  }
  if (trail && core) out.push({ gap: trail });
  return out;
}

function linePieces(line: string, cfg: Raw, st: State): Piece[] {
  const out: Piece[] = [];
  for (const tok of parseCshipLine(line)) {
    if (tok.kind === 'var') out.push(...varPieces(tok.name, cfg, st));
    else if (tok.kind === 'text') out.push(...textPieces(tok.text, st));
    else if (!tok.text.trim()) {
      st.spans++;
      if (tok.text) out.push({ gap: tok.text });
    } else {
      if (tok.text.includes('$')) {
        st.notes.push({
          kind: 'approx',
          text: t('import.note.spanLiteral', { tool: TOOL, text: sanitizeText(tok.text) }),
        });
      }
      out.push(...textPieces(tok.text, st, tok.style));
    }
  }
  return out;
}

const showGap = (g: string) =>
  !g.trim() && g.length > 2 ? t('import.spaces', { count: g.length }) : `"${sanitizeText(g)}"`;

export function importCship(cfg: Record<string, unknown>): ImportResult {
  const st: State = { notes: [], n: 0, spans: 0 };
  const sources =
    typeof cfg.format === 'string'
      ? cfg.format.split('$line_break')
      : Array.isArray(cfg.lines)
        ? cfg.lines.filter((l): l is string => typeof l === 'string')
        : [];
  const gaps = new Map<string, number>();
  const lines: WidgetItem[][] = [];
  for (const source of sources) {
    const items: WidgetItem[] = [];
    let gap: string | null = null;
    let soft = false;
    for (const p of linePieces(source, cfg, st)) {
      if ('gap' in p) {
        gap = (gap ?? '') + p.gap;
        soft = !!p.soft;
        continue;
      }
      const prev = items.at(-1);
      if (prev && prev.type !== 'flex' && p.item.type !== 'flex') {
        if (gap === null) prev.merge = true;
        else if (!soft) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
      }
      items.push(p.item);
      gap = null;
      soft = false;
    }
    if (items.some((i) => i.type !== 'flex')) lines.push(items);
  }
  if (st.spans) {
    st.notes.push({ kind: 'approx', text: t('import.note.emptySpans', { tool: TOOL, count: st.spans }) });
  }
  let separator = ' ';
  let best = 0;
  for (const [g, n] of gaps) {
    if (n > best) [separator, best] = [g, n];
  }
  const others = [...gaps.keys()].filter((g) => g !== separator);
  if (others.length) {
    const gapsText = others.map(showGap).join(', ');
    st.notes.push({
      kind: 'approx',
      text: t('import.note.gapsReplaced', { tool: TOOL, gaps: gapsText, separator: showGap(separator) }),
    });
  }
  const config: Partial<Config> = { lines, separator };
  const seen = new Set<string>();
  const notes = st.notes.filter((n) => !seen.has(`${n.kind}:${n.text}`) && !!seen.add(`${n.kind}:${n.text}`));
  return { config, notes, source: 'cship' };
}
