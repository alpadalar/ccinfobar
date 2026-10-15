import { visibleWidth } from '../core/ansi.js';
import { t as tr } from '../core/i18n/index.js';
import type { RenderContext, WidgetDef } from '../core/types.js';
import type { AgentInfo } from '../data/agents.js';
import { formatTokens, opt, span } from './shared.js';

const text = (ctx: RenderContext) => ctx.config.charset === 'text';

export function shortModel(model: string | null): string {
  if (!model) return '';
  const m = /claude-(?:\d[\d.-]*-)?([a-z]+)/i.exec(model);
  return (m?.[1] ?? model).toLowerCase();
}

function mark(ctx: RenderContext, status: string): string {
  if (text(ctx)) return status === 'completed' ? '[x]' : status === 'in_progress' ? '[>]' : '[ ]';
  return status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '·';
}

function padTo(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - visibleWidth(s)));
}

function agentRows(ctx: RenderContext, agents: AgentInfo[], showTool: boolean, extra: number): string {
  const total = ctx.data.transcript()?.totalTokens ?? 0;
  const sum = total + agents.reduce((n, a) => n + a.total, 0);
  const sep = text(ctx) ? ' | ' : ' · ';
  const rows = agents.map((a) => {
    const ms = a.start !== null && a.last !== null ? Math.max(0, a.last - a.start) : 0;
    const rate = ms > 0 ? `${Math.round(a.fresh / (ms / 60_000)).toLocaleString('en-US')} t/m` : '';
    const share = sum > 0 ? `${((a.total / sum) * 100).toFixed(1)}%` : '';
    const right = [
      rate,
      share,
      formatTokens(a.total),
      `${text(ctx) ? '^' : '↑'}${formatTokens(a.output)}`,
      ms ? span(ms) : '',
      shortModel(a.model),
    ]
      .filter(Boolean)
      .join(sep);
    const icon = a.running ? (text(ctx) ? '>' : '▸') : text(ctx) ? '+' : '✓';
    const left = `${icon} ${a.type}${a.description ? `${sep}${a.description}` : ''}`;
    return { left, right, tool: showTool && a.tool ? `  ${text(ctx) ? '`-' : '└'} ${a.tool}` : null };
  });
  const lw = Math.max(...rows.map((r) => visibleWidth(r.left)));
  const rw = Math.max(...rows.map((r) => visibleWidth(r.right)));
  const gap = 2 + Math.max(0, extra);
  const out: string[] = [];
  for (const r of rows) {
    out.push(padTo(r.left, lw + gap) + ' '.repeat(rw - visibleWidth(r.right)) + r.right);
    if (r.tool) out.push(r.tool);
  }
  return out.join('\n');
}

export const widgets: WidgetDef[] = [
  {
    type: 'todo-list',
    name: 'Task list',
    category: 'agents',
    description: "Claude's to-do list for the session: done, current and upcoming steps",
    label: 'Tasks ',
    icon: { nerd: '󰄲', emoji: '✅' },
    color: 'cyan',
    sample: '2/5 ▸ Wiring GSD widgets…',
    options: [
      {
        key: 'display',
        label: 'Display',
        kind: 'select',
        default: 'list',
        choices: [
          { value: 'list', label: 'Full list' },
          { value: 'current', label: 'Count and current step' },
        ],
      },
      { key: 'maxItems', label: 'Max items', kind: 'number', default: 8 },
      { key: 'hideDone', label: 'Hide finished steps', kind: 'boolean', default: false },
    ],
    render(ctx, item) {
      const todos = ctx.data.transcript()?.todos ?? [];
      if (!todos.length) return null;
      const done = todos.filter((t) => t.status === 'completed').length;
      const active = todos.find((t) => t.status === 'in_progress');
      const head = `${done}/${todos.length}`;
      if (opt<string>(item, 'display', 'list') === 'current' || done === todos.length) {
        return active ? `${head} ${mark(ctx, 'in_progress')} ${active.activeForm ?? active.content}` : head;
      }
      let list = todos.map((t, i) => ({ t, i }));
      if (opt(item, 'hideDone', false)) list = list.filter((x) => x.t.status !== 'completed');
      const max = Math.max(1, opt(item, 'maxItems', 8));
      const at = Math.max(
        0,
        list.findIndex((x) => x.t.status === 'in_progress'),
      );
      const start = Math.max(0, Math.min(at - 1, list.length - max));
      const shown = list.slice(start, start + max);
      const lines = shown.map(
        ({ t, i }) =>
          `  ${mark(ctx, t.status)} ${i + 1}. ${t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}`,
      );
      if (start > 0) lines.unshift(`  ${tr('widget.agents.earlier', { count: start })}`);
      if (start + max < list.length)
        lines.push(`  ${tr('widget.agents.more', { count: list.length - start - max })}`);
      return [head, ...lines].join('\n');
    },
  },
  {
    type: 'agents',
    name: 'Subagents',
    category: 'agents',
    description:
      'Subagents of the current turn as a table: what they do, their last tool, speed, tokens, time and model',
    label: '',
    icon: { nerd: '󰚩', emoji: '🤖' },
    color: 'magenta',
    sample: '▸ explore · Search codebase   2,411 t/m · 3.2k · sonnet',
    fill: true,
    options: [
      { key: 'showTool', label: 'Show last tool', kind: 'boolean', default: true },
      { key: 'runningOnly', label: 'Only running agents', kind: 'boolean', default: false },
      { key: 'maxAgents', label: 'Max agents', kind: 'number', default: 5 },
    ],
    render(ctx, item) {
      let agents = ctx.data.agents();
      if (opt(item, 'runningOnly', false)) agents = agents.filter((a) => a.running);
      agents = agents.slice(0, Math.max(1, opt(item, 'maxAgents', 5)));
      if (!agents.length) return null;
      return agentRows(ctx, agents, opt(item, 'showTool', true), ctx.extra ?? 0);
    },
  },
  {
    type: 'agent-count',
    name: 'Subagent count',
    category: 'agents',
    description: 'How many subagents are running and how many finished this turn',
    label: 'Agents ',
    icon: { nerd: '󰚩', emoji: '🤖' },
    color: 'magenta',
    sample: '2 running · 1 done',
    render(ctx) {
      const agents = ctx.data.agents();
      if (!agents.length) return null;
      const running = agents.filter((a) => a.running).length;
      const done = agents.length - running;
      return [
        running ? tr('widget.agents.running', { count: running }) : '',
        done ? tr('widget.agents.done', { count: done }) : '',
      ]
        .filter(Boolean)
        .join(' · ');
    },
  },
];
