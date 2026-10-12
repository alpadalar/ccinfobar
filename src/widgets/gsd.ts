import type { OptionSpec, RenderContext, WidgetDef, WidgetItem, WidgetOutput } from '../core/types.js';
import type { GsdInfo } from '../data/gsd.js';
import { barFor, barOptions, opt } from './shared.js';

const STATUS_COLORS: Record<string, string> = {
  discussing: 'cyan',
  planning: 'blue',
  'ready-to-plan': 'blue',
  'ready-to-execute': 'cyan',
  executing: 'yellow',
  verifying: 'magenta',
  'phase-complete': 'green',
  complete: 'green',
};

const ACTIVE_STATUSES = new Set(['discussing', 'planning', 'executing', 'verifying']);

function clip(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function milestoneLabel(info: GsdInfo, showName = true): string | null {
  const parts = [info.milestone, showName ? info.milestoneName : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function nextCommand(info: GsdInfo): { action: string; phases: string } | null {
  const n = info.phase?.number ?? info.activePhase ?? '';
  if (info.nextAction) {
    const action = info.nextAction.replace(/^\/?gsd[-:]/, '').replace(/^\//, '');
    return { action, phases: info.nextPhases.length > 0 ? info.nextPhases.join(',') : n };
  }
  switch (info.status) {
    case 'discussing':
      return { action: 'discuss-phase', phases: n };
    case 'ready-to-plan':
    case 'planning':
      return { action: 'plan-phase', phases: n };
    case 'ready-to-execute':
    case 'executing':
      return { action: 'execute-phase', phases: n };
    case 'verifying':
      return { action: 'verify-work', phases: n };
    case 'phase-complete':
      if (info.phasesTotal > 0 && info.phasesCompleted >= info.phasesTotal) {
        return { action: 'complete-milestone', phases: '' };
      }
      return { action: 'verify-work', phases: n };
    case 'complete':
      return { action: 'new-milestone', phases: '' };
    default:
      return null;
  }
}

function withGsd(
  render: (info: GsdInfo, item: WidgetItem, ctx: RenderContext) => WidgetOutput | string | null,
): WidgetDef['render'] {
  return (ctx, item) => {
    const info = ctx.data.gsd();
    return info ? render(info, item, ctx) : null;
  };
}

const maxLengthOption = (def: number): OptionSpec => ({
  key: 'maxLength',
  label: 'Max length',
  kind: 'number',
  default: def,
});

export const widgets: WidgetDef[] = [
  {
    type: 'gsd-milestone',
    name: 'GSD milestone',
    category: 'gsd',
    description: 'Current GSD milestone version and name',
    icon: { nerd: '', emoji: '🏁' },
    color: 'magenta',
    sample: 'v1.2 Billing',
    options: [{ key: 'showName', label: 'Show milestone name', kind: 'boolean', default: true }],
    render: withGsd((info, item) => milestoneLabel(info, opt(item, 'showName', true))),
  },
  {
    type: 'gsd-milestone-progress',
    name: 'GSD milestone progress',
    category: 'gsd',
    description: 'Milestone completion bar (plans and phases done on disk)',
    icon: { nerd: '', emoji: '📊' },
    color: 'green',
    sample: '█████░░░░░ 50%',
    options: [
      ...barOptions,
      { key: 'showCounts', label: 'Show phase counts', kind: 'boolean', default: false },
    ],
    render: withGsd((info, item, ctx) => {
      if (info.percent === null) return null;
      const parts = [barFor(ctx, item, info.percent)];
      if (opt(item, 'showPercent', true)) parts.push(`${info.percent}%`);
      if (opt(item, 'showCounts', false) && info.phasesTotal > 0) {
        parts.push(`${info.phasesCompleted}/${info.phasesTotal} phases`);
      }
      return parts.join(' ');
    }),
  },
  {
    type: 'gsd-phase',
    name: 'GSD phase',
    category: 'gsd',
    description: 'Current GSD phase number and name',
    label: 'Phase ',
    icon: { nerd: '', emoji: '📍' },
    color: 'cyan',
    sample: '4/6 Invoice export',
    options: [
      { key: 'showName', label: 'Show phase name', kind: 'boolean', default: true },
      { key: 'showTotal', label: 'Show total phases', kind: 'boolean', default: true },
      { key: 'maxNameLength', label: 'Max name length', kind: 'number', default: 24 },
    ],
    render: withGsd((info, item) => {
      const phase = info.phase;
      if (!phase) return null;
      let text = phase.number;
      if (opt(item, 'showTotal', true) && info.phasesTotal > 0) {
        const idx = info.phaseIndex;
        const n = Number(phase.number);
        if (idx && (n > info.phasesTotal || !Number.isInteger(n) || n !== idx))
          text += ` (${idx}/${info.phasesTotal})`;
        else text += `/${info.phasesTotal}`;
      }
      if (opt(item, 'showName', true) && phase.name) {
        text += ` ${clip(phase.name, opt(item, 'maxNameLength', 24))}`;
      }
      return text;
    }),
  },
  {
    type: 'gsd-status',
    name: 'GSD status',
    category: 'gsd',
    description: 'Normalized GSD workflow status, colored by stage',
    icon: { nerd: '', emoji: '⚙️' },
    color: 'yellow',
    sample: 'executing',
    render: withGsd((info) => {
      if (!info.status) return null;
      return { text: info.status.replace(/-/g, ' '), color: STATUS_COLORS[info.status] };
    }),
  },
  {
    type: 'gsd-plans',
    name: 'GSD plans',
    category: 'gsd',
    description: 'Completed plans in the current phase',
    label: 'plans ',
    icon: { nerd: '', emoji: '📋' },
    color: 'blue',
    sample: '3/5',
    options: [{ key: 'showEmpty', label: 'Show when phase has no plans', kind: 'boolean', default: false }],
    render: withGsd((info, item) => {
      const phase = info.phase;
      if (!phase) return null;
      if (phase.plans === 0) return opt(item, 'showEmpty', false) ? 'none' : null;
      return `${Math.min(phase.summaries, phase.plans)}/${phase.plans}`;
    }),
  },
  {
    type: 'gsd-plan-progress',
    name: 'GSD plan progress',
    category: 'gsd',
    description: 'Plan completion bar for the current phase',
    icon: { nerd: '', emoji: '📊' },
    color: 'blue',
    sample: '██████░░░░ 60%',
    options: barOptions,
    render: withGsd((info, item, ctx) => {
      const phase = info.phase;
      if (!phase || phase.plans === 0) return null;
      const pct = Math.round((Math.min(phase.summaries, phase.plans) / phase.plans) * 100);
      const b = barFor(ctx, item, pct);
      return opt(item, 'showPercent', true) ? `${b} ${pct}%` : b;
    }),
  },
  {
    type: 'gsd-next',
    name: 'GSD next step',
    category: 'gsd',
    description: 'Suggested next GSD command',
    label: 'next: ',
    icon: { nerd: '', emoji: '➡️' },
    color: 'cyan',
    sample: '/gsd-execute-phase 4',
    options: [
      {
        key: 'slashPrefix',
        label: 'Command prefix',
        kind: 'text',
        default: '/gsd-',
        help: 'Use /gsd: for older GSD versions',
      },
    ],
    render: withGsd((info, item) => {
      const next = nextCommand(info);
      if (!next) return null;
      return `${opt(item, 'slashPrefix', '/gsd-')}${next.action}${next.phases ? ` ${next.phases}` : ''}`;
    }),
  },
  {
    type: 'gsd-workstream',
    name: 'GSD workstream',
    category: 'gsd',
    description: 'Active GSD workstream name',
    label: 'ws ',
    icon: { nerd: '', emoji: '🌿' },
    color: 'green',
    sample: 'billing',
    render: withGsd((info) => info.workstream),
  },
  {
    type: 'gsd-blockers',
    name: 'GSD blockers & concerns',
    category: 'gsd',
    description:
      'Open items under Blockers/Concerns in STATE.md (resolved and struck-through items are skipped)',
    color: 'red',
    sample: '⚠ 1 concern',
    options: [
      { key: 'showFirst', label: 'Show first item text', kind: 'boolean', default: false },
      maxLengthOption(40),
    ],
    render: withGsd((info, item) => {
      const n = info.blockers.length;
      if (n === 0) return null;
      const base = `⚠ ${n} concern${n === 1 ? '' : 's'}`;
      if (!opt(item, 'showFirst', false)) return base;
      return `${base}: ${clip(info.blockers[0]!, opt(item, 'maxLength', 40))}`;
    }),
  },
  {
    type: 'gsd-todos',
    name: 'GSD todos',
    category: 'gsd',
    description: 'Number of pending GSD todos',
    icon: { nerd: '', emoji: '📝' },
    color: 'yellow',
    sample: '2 todos',
    render: withGsd((info) => {
      const n = info.pendingTodos;
      return n > 0 ? `${n} todo${n === 1 ? '' : 's'}` : null;
    }),
  },
  {
    type: 'gsd-requirements',
    name: 'GSD requirements',
    category: 'gsd',
    description: 'Requirements completed out of total',
    label: 'req ',
    icon: { nerd: '', emoji: '✅' },
    color: 'green',
    sample: '14/22',
    render: withGsd((info) =>
      info.requirementsTotal > 0 ? `${info.requirementsDone}/${info.requirementsTotal}` : null,
    ),
  },
  {
    type: 'gsd-last-command',
    name: 'GSD last command',
    category: 'gsd',
    description: 'Last slash command run in the session',
    icon: { nerd: '', emoji: '⌨️' },
    color: 'magenta',
    sample: '/gsd-execute-phase',
    options: [{ key: 'onlyGsd', label: 'Only GSD commands', kind: 'boolean', default: true }],
    render(ctx, item) {
      if (!ctx.data.gsd()) return null;
      const t = ctx.data.transcript();
      const raw = opt(item, 'onlyGsd', true) ? t?.lastGsdCommand : t?.lastCommand;
      const cmd = raw?.trim().split(/\s+/)[0]?.replace(/^\//, '');
      if (!cmd) return null;
      return `/${cmd}`;
    },
  },
  {
    type: 'gsd-update',
    name: 'GSD update',
    category: 'gsd',
    description: 'Shown when a GSD update is available or hooks are stale',
    color: 'yellow',
    sample: '⬆ GSD 1.41.0',
    render: withGsd((info) => {
      const u = info.update;
      if (!u) return null;
      const parts: string[] = [];
      if (u.available) parts.push(`⬆ GSD${u.latest ? ` ${u.latest}` : ''}`);
      if (u.staleHooks) parts.push('⚠ stale hooks');
      return parts.length > 0 ? parts.join(' ') : null;
    }),
  },
  {
    type: 'gsd-task',
    name: 'GSD current task',
    category: 'gsd',
    description: 'Task currently in progress in the session',
    icon: { nerd: '', emoji: '🔧' },
    color: 'white',
    sample: 'Wiring GSD widgets',
    options: [maxLengthOption(40)],
    render(ctx, item) {
      if (!ctx.data.gsd()) return null;
      const task = ctx.data.transcript()?.currentTask;
      return task ? clip(task, opt(item, 'maxLength', 40)) : null;
    },
  },
  {
    type: 'gsd-summary',
    name: 'GSD summary',
    category: 'gsd',
    description: 'Compact milestone, progress and phase status segment',
    icon: { nerd: '', emoji: '🧭' },
    color: 'cyan',
    sample: 'v1.2 Billing [█████░░░░░] 50% · Phase 4 executing',
    options: barOptions,
    render: withGsd((info, item, ctx) => {
      const head: string[] = [];
      const ms = milestoneLabel(info);
      if (ms) head.push(ms);
      if (info.percent !== null) {
        const b = barFor(ctx, item, info.percent);
        head.push(`[${b}]${opt(item, 'showPercent', true) ? ` ${info.percent}%` : ''}`);
      }
      let tail: string | null = null;
      const n = info.phase?.number;
      if (info.status === 'complete') tail = 'milestone complete';
      else if (info.status && ACTIVE_STATUSES.has(info.status) && n) tail = `Phase ${n} ${info.status}`;
      else {
        const next = nextCommand(info);
        if (next) tail = `next ${next.action}${next.phases ? ` ${next.phases}` : ''}`;
        else if (n) tail = `Phase ${n}`;
      }
      const parts = [head.join(' '), tail].filter((p): p is string => !!p);
      return parts.length > 0 ? parts.join(' · ') : null;
    }),
  },
];
