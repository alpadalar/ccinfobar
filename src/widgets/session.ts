import { t } from '../core/i18n/index.js';
import { resolveProfile } from '../core/profiles.js';
import { sanitizeText } from '../core/sanitize.js';
import type { RenderContext, WidgetDef, WidgetItem } from '../core/types.js';
import { detectProvider, type ProviderKind } from '../data/provider.js';
import { opt } from './shared.js';

const PROVIDER_LABEL = {
  bedrock: 'widget.provider.bedrock',
  vertex: 'widget.provider.vertex',
  foundry: 'widget.provider.foundry',
  mantle: 'widget.provider.mantle',
  anthropicAws: 'widget.provider.anthropicAws',
  apiKey: 'widget.provider.apiKey',
  firstParty: 'widget.provider.firstParty',
} as const satisfies Record<Exclude<ProviderKind, 'gateway'>, string>;

function providerText(ctx: RenderContext, item: WidgetItem): string | null {
  const p = detectProvider(ctx.env);
  if (p.kind === 'firstParty' && !opt(item, 'showFirstParty', false)) return null;
  if (p.kind !== 'gateway') return t(PROVIDER_LABEL[p.kind]);
  const host = sanitizeText(p.host ?? '').trim();
  if (!host) return null;
  const vendor = resolveProfile(ctx.payload.model, p, ctx.config)?.vendor;
  return vendor ? t('widget.provider.via', { label: vendor, host }) : host;
}

export const widgets: WidgetDef[] = [
  {
    type: 'model',
    name: 'Model',
    category: 'session',
    description: 'Current model display name',
    icon: { nerd: '󰚚', emoji: '🤖' },
    color: 'cyan',
    sample: 'Opus 5.5',
    options: [
      { key: 'showId', label: 'Show model id', kind: 'boolean', default: false },
      {
        key: 'profileLabel',
        label: 'Use profile model name',
        kind: 'boolean',
        default: false,
        help: 'Shows a model profile name (GLM-5.3) instead of a raw gateway model id',
      },
    ],
    render(ctx, item) {
      const m = ctx.payload.model;
      if (!m) return null;
      if (opt(item, 'profileLabel', false)) {
        const label = resolveProfile(m, detectProvider(ctx.env), ctx.config)?.label;
        if (label) return label;
      }
      if (opt(item, 'showId', false)) return m.id ?? m.display_name;
      return m.display_name ?? m.id;
    },
  },
  {
    type: 'provider',
    name: 'Provider',
    category: 'session',
    description: 'API provider: Bedrock, Vertex, an API key or a gateway host',
    icon: { nerd: '󰒍', emoji: '🔌' },
    color: 'blue',
    sample: 'Bedrock',
    sources: ['env:provider', 'payload:model'],
    options: [
      {
        key: 'showFirstParty',
        label: 'Show for first-party sessions',
        kind: 'boolean',
        default: false,
        help: 'Off: hidden for Claude subscription sessions',
      },
    ],
    render: providerText,
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
      return opt(item, 'showThinking', false) && ctx.payload.thinking?.enabled
        ? t('widget.session.think', { level })
        : level;
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
      const on = ctx.payload.thinking?.enabled;
      if (on === undefined) return null;
      if (!on && opt(item, 'hideOff', false)) return null;
      return t(on ? 'widget.thinking.on' : 'widget.thinking.off');
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
      if (f) return t('widget.fast.on');
      return f === false && opt(item, 'showOff', false) ? t('widget.fast.off') : null;
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
  {
    type: 'skills',
    name: 'Skills',
    category: 'session',
    description: 'Skills used in this session: the latest, how many, or a list',
    label: 'Skill ',
    icon: { nerd: '󰘦', emoji: '🧩' },
    color: 'brightBlack',
    sample: 'gsd-execute-phase',
    options: [
      {
        key: 'mode',
        label: 'Show',
        kind: 'select',
        default: 'current',
        choices: [
          { value: 'current', label: 'Latest skill' },
          { value: 'count', label: 'Count' },
          { value: 'list', label: 'List' },
        ],
      },
      { key: 'limit', label: 'List limit', kind: 'number', default: 3 },
    ],
    render(ctx, item) {
      const skills = ctx.data.transcript()?.skills ?? [];
      if (!skills.length) return null;
      const mode = opt<string>(item, 'mode', 'current');
      if (mode === 'count') return `${skills.length}`;
      if (mode === 'list') {
        const limit = Math.max(1, opt(item, 'limit', 3));
        const recent = skills.slice(-limit).reverse();
        const more = skills.length - recent.length;
        return more > 0 ? `${recent.join(', ')} +${more}` : recent.join(', ');
      }
      return skills[skills.length - 1]!;
    },
  },
];
