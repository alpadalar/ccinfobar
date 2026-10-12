import { BUILTIN_THEMES } from '../core/themes.js';
import type { Config, OptionValue, ThemeStyle, WidgetItem } from '../core/types.js';
import type { ImportResult } from './index.js';

type Raw = Record<string, unknown>;

export const POWERLINE_DEFAULT_SEGMENTS: Raw = {
  directory: { enabled: true, style: 'basename' },
  git: { enabled: true },
  model: { enabled: true },
  session: { enabled: true, type: 'tokens' },
  today: { enabled: true },
  context: { enabled: true },
  agent: { enabled: true },
};

const BAR_STYLES = new Set([
  'bar',
  'ball',
  'blocks',
  'blocks-line',
  'capped',
  'dots',
  'filled',
  'geometric',
  'line',
  'squares',
]);

const STYLES: Record<string, ThemeStyle> = {
  minimal: 'blocks',
  powerline: 'powerline',
  capsule: 'capsule',
  tui: 'tui',
};

function on(seg: unknown): seg is Raw {
  return !!seg && typeof seg === 'object' && (seg as Raw).enabled !== false;
}

function hex(v: unknown): string | undefined {
  return typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined;
}

function segmentItems(name: string, seg: Raw, warnings: string[]): WidgetItem[] {
  const item = (type: string, options?: Record<string, OptionValue>): WidgetItem => ({
    id: `${name}-${type}`,
    type,
    ...(options ? { options } : {}),
  });
  const display = typeof seg.displayStyle === 'string' ? seg.displayStyle : 'text';
  const bar = BAR_STYLES.has(display);
  const barOpts = (extra: Record<string, OptionValue> = {}) =>
    bar ? { display: 'bar', style: display, ...extra } : { ...extra };
  switch (name) {
    case 'directory': {
      const style = seg.style === 'fish' ? 'short' : seg.style === 'basename' ? 'basename' : 'tilde';
      return [item('cwd', { style })];
    }
    case 'git': {
      const out = [item('git-branch')];
      if (seg.showSha) out.push(item('git-sha'));
      if (seg.showWorkingTree) out.push(item('git-status'));
      if (seg.showUpstream) out.push(item('git-ahead-behind'));
      if (seg.showStashCount) out.push(item('git-stash'));
      if (seg.showOperation) out.push(item('git-operation'));
      if (seg.showRepoName) out.push(item('git-repo'));
      return out;
    }
    case 'model':
      return [item('model')];
    case 'session':
      return seg.type === 'tokens' ? [item('tokens-total')] : [item('session-cost')];
    case 'context':
      return bar
        ? [item('context-bar', { style: display })]
        : [item('context-percentage', seg.percentageMode === 'used' ? {} : { mode: 'remaining' })];
    case 'block':
      return [
        item('five-hour-usage', barOpts(seg.showPace ? { showPace: true } : {})),
        item('five-hour-reset'),
      ];
    case 'weekly':
      return [item('weekly-usage', barOpts(seg.showPace ? { showPace: true } : {})), item('weekly-reset')];
    case 'metrics': {
      const out: WidgetItem[] = [];
      if (seg.showDuration !== false) out.push(item('session-duration'));
      if (seg.showMessageCount !== false) out.push(item('message-count'));
      if (seg.showLinesAdded !== false || seg.showLinesRemoved !== false) out.push(item('lines-changed'));
      return out;
    }
    case 'version':
      return [item('claude-version')];
    case 'agent':
      return [item('agent-name')];
    case 'thinking':
      return [item('effort', { showThinking: true })];
    case 'cacheTimer':
      return [item('cache-timer')];
    case 'outputStyle':
      return [item('output-style')];
    case 'sessionId':
      return [item('session-id', { short: true })];
    case 'env':
      return typeof seg.variable === 'string' ? [item('env', { name: seg.variable })] : [];
    default:
      warnings.push(`claude-powerline segment "${name}" has no ccinfobar equivalent and was skipped`);
      return [];
  }
}

export function parsePowerlineArgs(command: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of command.matchAll(/--(theme|style|charset|config)[=\s]+("[^"]*"|'[^']*'|\S+)/g)) {
    out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

export function importClaudePowerline(raw: unknown, args: Record<string, string> = {}): ImportResult {
  const warnings: string[] = [];
  const c = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const display = (c.display ?? {}) as Raw;
  const rawLines = Array.isArray(display.lines)
    ? (display.lines as Raw[])
    : [{ segments: POWERLINE_DEFAULT_SEGMENTS }];
  const custom = ((c.colors as Raw | undefined)?.custom ?? {}) as Record<string, Raw>;
  const lines = rawLines.map((l) => {
    const segs = (l.segments ?? {}) as Raw;
    const items: WidgetItem[] = [];
    for (const [name, seg] of Object.entries(segs)) {
      if (!on(seg)) continue;
      const colors = custom[name];
      for (const it of segmentItems(name, seg, warnings)) {
        const bg = hex(colors?.bg);
        const fg = hex(colors?.fg);
        if (bg) it.background = bg;
        if (fg) it.color = fg;
        if (colors?.bold === true) it.bold = true;
        items.push(it);
      }
    }
    return items;
  });
  const theme = String(args.theme ?? c.theme ?? 'dark');
  const style = STYLES[String(args.style ?? display.style ?? 'minimal')] ?? 'blocks';
  const config: Partial<Config> = {
    lines,
    theme: BUILTIN_THEMES.some((t) => t.id === theme) ? theme : 'dark',
    style,
  };
  if (style === 'blocks') config.separator = '';
  const charset = args.charset ?? display.charset;
  if (charset === 'text') config.charset = 'text';
  if (display.autoWrap !== false) config.autoWrap = true;
  if (typeof display.widthReserve === 'number') config.widthOffset = display.widthReserve;
  if (typeof display.padding === 'number') config.padding = display.padding;
  if (theme === 'custom') warnings.push('custom claude-powerline colors were copied onto each widget');
  return { config, warnings, source: 'claude-powerline' };
}
