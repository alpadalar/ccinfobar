import type { WidgetDef } from '../core/types.js';
import { opt } from './shared.js';

export const widgets: WidgetDef[] = [
  {
    type: 'model',
    name: 'Model',
    category: 'session',
    description: 'Current model display name',
    icon: { nerd: '󰚚', emoji: '🤖' },
    color: 'cyan',
    sample: 'Opus 5.5',
    options: [{ key: 'showId', label: 'Show model id', kind: 'boolean', default: false }],
    render(ctx, item) {
      const m = ctx.payload.model;
      if (!m) return null;
      if (item.options?.showId) return m.id ?? m.display_name;
      return m.display_name ?? m.id;
    },
  },
  {
    type: 'effort',
    name: 'Effort',
    category: 'session',
    description: 'Reasoning effort level',
    label: 'Effort ',
    icon: { nerd: '󰓅', emoji: '🧠' },
    color: 'magenta',
    sample: 'high',
    options: [
      { key: 'showThinking', label: 'Append +think when thinking is on', kind: 'boolean', default: false },
    ],
    render(ctx, item) {
      const level = ctx.payload.effort?.level;
      if (!level) return null;
      return opt(item, 'showThinking', false) && ctx.payload.thinking?.enabled ? `${level}+think` : level;
    },
  },
  {
    type: 'thinking',
    name: 'Thinking',
    category: 'session',
    description: 'Whether extended thinking is enabled',
    label: 'Think ',
    icon: { nerd: '󰛨', emoji: '💭' },
    color: 'magenta',
    sample: 'on',
    options: [{ key: 'hideOff', label: 'Hide when off', kind: 'boolean', default: false }],
    render(ctx, item) {
      const t = ctx.payload.thinking?.enabled;
      if (t === undefined) return null;
      if (!t && opt(item, 'hideOff', false)) return null;
      return t ? 'on' : 'off';
    },
  },
  {
    type: 'fast-mode',
    name: 'Fast mode',
    category: 'session',
    description: 'Shown when fast mode is active',
    icon: { nerd: '󱐋', emoji: '⚡' },
    color: 'yellow',
    sample: 'fast',
    options: [{ key: 'showOff', label: 'Show when off', kind: 'boolean', default: false }],
    render(ctx, item) {
      const f = ctx.payload.fast_mode;
      if (f) return 'fast';
      return f === false && opt(item, 'showOff', false) ? 'normal' : null;
    },
  },
  {
    type: 'output-style',
    name: 'Output style',
    category: 'session',
    description: 'Active output style',
    label: 'Style ',
    icon: { nerd: '󰏫', emoji: '🎨' },
    color: 'blue',
    sample: 'Explanatory',
    options: [{ key: 'showDefault', label: 'Show default style', kind: 'boolean', default: false }],
    render(ctx, item) {
      const name = ctx.payload.output_style?.name;
      if (!name) return null;
      if (name.toLowerCase() === 'default' && !opt(item, 'showDefault', false)) return null;
      return name;
    },
  },
  {
    type: 'session-name',
    name: 'Session name',
    category: 'session',
    description: 'Session title from /rename or the transcript',
    icon: { nerd: '󰈙', emoji: '📝' },
    color: 'white',
    sample: 'statusline refactor',
    render(ctx) {
      const name = ctx.payload.session_name || ctx.data.transcript()?.sessionName;
      return name || null;
    },
  },
  {
    type: 'session-id',
    name: 'Session ID',
    category: 'session',
    description: 'Session identifier',
    label: 'Session ',
    icon: { nerd: '󰻾', emoji: '🆔' },
    color: 'brightBlack',
    sample: '3f2a9c1e',
    options: [{ key: 'short', label: 'Short (8 chars)', kind: 'boolean', default: false }],
    render(ctx, item) {
      const id = ctx.payload.session_id;
      if (!id) return null;
      return opt(item, 'short', false) ? id.slice(0, 8) : id;
    },
  },
  {
    type: 'claude-version',
    name: 'Claude version',
    category: 'session',
    description: 'Claude Code version',
    icon: { nerd: '󰏗', emoji: '📦' },
    color: 'brightBlack',
    sample: 'v2.1.300',
    render(ctx) {
      const v = ctx.payload.version;
      return v ? `v${v.replace(/^v/, '')}` : null;
    },
  },
  {
    type: 'vim-mode',
    name: 'Vim mode',
    category: 'session',
    description: 'Current vim mode when vim editing is on',
    icon: { nerd: '', emoji: '⌨️' },
    color: 'green',
    sample: 'INSERT',
    render: (ctx) => ctx.payload.vim?.mode || null,
  },
  {
    type: 'agent-name',
    name: 'Agent name',
    category: 'session',
    description: 'Active agent name (claude --agent)',
    icon: { nerd: '󰚩', emoji: '🕵️' },
    color: 'yellow',
    sample: 'reviewer',
    render: (ctx) => ctx.payload.agent?.name || null,
  },
];
