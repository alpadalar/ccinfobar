import os from 'node:os';
import { formatMonthDay } from '../core/i18n/format.js';
import { languageLocale, t } from '../core/i18n/index.js';
import type { WidgetDef } from '../core/types.js';
import { opt } from './shared.js';

const pad = (n: number) => String(n).padStart(2, '0');
const GB = 1024 ** 3;

const PLATFORMS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export const widgets: WidgetDef[] = [
  {
    type: 'clock',
    timeBased: true,
    name: 'Clock',
    category: 'system',
    description: 'Current local time',
    icon: { nerd: '󰥔', emoji: '🕒' },
    color: 'white',
    sample: '14:32',
    options: [
      { key: 'seconds', label: 'Show seconds', kind: 'boolean', default: false },
      { key: 'h12', label: '12-hour clock', kind: 'boolean', default: false },
    ],
    render(ctx, item) {
      const d = ctx.now;
      let h = d.getHours();
      let suffix = '';
      if (opt(item, 'h12', false)) {
        suffix = ` ${t(h >= 12 ? 'widget.clock.pm' : 'widget.clock.am')}`;
        h = h % 12 || 12;
      }
      const s = opt(item, 'seconds', false) ? `:${pad(d.getSeconds())}` : '';
      return `${pad(h)}:${pad(d.getMinutes())}${s}${suffix}`;
    },
  },
  {
    type: 'date',
    name: 'Date',
    category: 'system',
    description: 'Current local date',
    icon: { nerd: '󰃭', emoji: '📅' },
    color: 'white',
    sample: '2026-10-12',
    options: [
      {
        key: 'format',
        label: 'Format',
        kind: 'select',
        default: 'iso',
        choices: [
          { value: 'iso', label: '2026-10-12' },
          { value: 'short', label: 'Oct 12' },
        ],
      },
    ],
    render(ctx, item) {
      const d = ctx.now;
      if (opt<string>(item, 'format', 'iso') === 'short') {
        return formatMonthDay(d, languageLocale());
      }
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
  },
  {
    type: 'hostname',
    name: 'Hostname',
    category: 'system',
    description: 'Machine hostname',
    icon: { nerd: '󰒋', emoji: '🖥️' },
    color: 'brightBlack',
    sample: 'devbox',
    sources: ['system'],
    render: () => os.hostname().split('.')[0] || null,
  },
  {
    type: 'username',
    name: 'Username',
    category: 'system',
    description: 'Current OS user',
    icon: { nerd: '', emoji: '👤' },
    color: 'brightBlack',
    sample: 'dev',
    sources: ['system'],
    render(ctx) {
      try {
        return os.userInfo().username || null;
      } catch {
        return ctx.env.USER ?? ctx.env.USERNAME ?? null;
      }
    },
  },
  {
    type: 'memory',
    name: 'Memory',
    category: 'system',
    description: 'System memory usage',
    label: 'Mem ',
    icon: { nerd: '󰍛', emoji: '🧠' },
    color: 'green',
    sample: '11.2/31.2 GB',
    sources: ['system'],
    options: [
      {
        key: 'format',
        label: 'Format',
        kind: 'select',
        default: 'gb',
        choices: [
          { value: 'gb', label: 'used/total GB' },
          { value: 'percent', label: 'Percent' },
        ],
      },
    ],
    render(_ctx, item) {
      const total = os.totalmem();
      if (!total) return null;
      const used = total - os.freemem();
      if (opt<string>(item, 'format', 'gb') === 'percent') return `${Math.round((used / total) * 100)}%`;
      return `${(used / GB).toFixed(1)}/${(total / GB).toFixed(1)} GB`;
    },
  },
  {
    type: 'env-counts',
    name: 'Environment counts',
    category: 'system',
    description: 'CLAUDE.md, AGENTS.md, rules, MCP servers and hooks in effect, from config files',
    icon: { nerd: '⚙', emoji: '⚙', text: '⚙' },
    color: 'blue',
    sample: 'CLAUDE.md 2 · rules 3 · MCP 4 · hooks 5',
    options: [
      { key: 'showClaudeMd', label: 'Show CLAUDE.md', kind: 'boolean', default: true },
      { key: 'showAgentsMd', label: 'Show AGENTS.md', kind: 'boolean', default: true },
      { key: 'showRules', label: 'Show rules', kind: 'boolean', default: true },
      { key: 'showMcp', label: 'Show MCP servers', kind: 'boolean', default: true },
      { key: 'showHooks', label: 'Show hooks', kind: 'boolean', default: true },
      { key: 'hideZero', label: 'Hide zero counts', kind: 'boolean', default: true },
      {
        key: 'mcpHealth',
        label: 'MCP health (only when Claude Code exposes it)',
        kind: 'boolean',
        default: false,
      },
    ],
    render(ctx, item) {
      const e = ctx.data.environment?.();
      if (!e) return null;
      const hideZero = opt(item, 'hideZero', true);
      const parts: string[] = [];
      const add = (key: string, n: number, text: string) => {
        if (opt(item, key, true) && (n > 0 || !hideZero)) parts.push(text);
      };
      add('showClaudeMd', e.claudeMd, `CLAUDE.md ${e.claudeMd}`);
      if (opt(item, 'showAgentsMd', true) && e.agentsMd > 0) parts.push(`AGENTS.md ${e.agentsMd}`);
      add('showRules', e.rules, t('widget.env.rules', { count: e.rules }));
      const health = opt(item, 'mcpHealth', false) ? e.mcpHealth : undefined;
      if (health && opt(item, 'showMcp', true)) parts.push(`MCP ${health.ok}/${health.total}`);
      else add('showMcp', e.mcp, `MCP ${e.mcp}`);
      if (opt(item, 'showHooks', true)) {
        if (e.hooksDisabled) parts.push(t('widget.env.hooksOff'));
        else if (e.hooks > 0 || !hideZero) parts.push(t('widget.env.hooks', { count: e.hooks }));
      }
      if (!parts.length) return null;
      return parts.join(ctx.config.charset === 'text' ? ' | ' : ' · ');
    },
  },
  {
    type: 'load-average',
    name: 'Load average',
    category: 'system',
    description: 'System load average (not available on Windows)',
    label: 'Load ',
    icon: { nerd: '󰓅', emoji: '📈' },
    color: 'green',
    sample: '0.52 0.48 0.40',
    sources: ['system'],
    options: [{ key: 'full', label: 'Show 1/5/15 minute averages', kind: 'boolean', default: true }],
    render(_ctx, item) {
      if (process.platform === 'win32') return null;
      const l = os.loadavg();
      if (opt(item, 'full', true)) return l.map((n) => n.toFixed(2)).join(' ');
      return l[0]!.toFixed(2);
    },
  },
  {
    type: 'terminal-width',
    name: 'Terminal width',
    category: 'system',
    description: 'Detected terminal width in columns',
    label: 'Cols ',
    icon: { nerd: '󰩈', emoji: '↔️' },
    color: 'brightBlack',
    sample: '140',
    render: (ctx) => (ctx.terminalWidth ? String(ctx.terminalWidth) : null),
  },
  {
    type: 'platform',
    name: 'Platform',
    category: 'system',
    description: 'Operating system',
    icon: { nerd: '', emoji: '💻' },
    color: 'brightBlack',
    sample: 'Linux',
    sources: ['system'],
    render: () => PLATFORMS[process.platform] ?? process.platform,
  },
];
