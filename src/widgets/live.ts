import type { WidgetDef } from '../core/types.js';
import { activeTools, groupName, mergeCounts } from '../data/live.js';
import { opt } from './shared.js';

export const widgets: WidgetDef[] = [
  {
    type: 'tool-activity',
    name: 'Tool activity',
    category: 'agents',
    description: 'The running tool and recent tool counts, from the transcript',
    label: '',
    icon: { nerd: '', emoji: '\u{1f6e0}️', text: '▸' },
    color: 'cyan',
    sample: 'Bash npm test · Read 4, Edit 2, Bash 1',
    options: [
      {
        key: 'mode',
        label: 'Show',
        kind: 'select',
        default: 'both',
        choices: [
          { value: 'both', label: 'Running tool and counts' },
          { value: 'running', label: 'Running tool' },
          { value: 'counts', label: 'Tool counts' },
        ],
      },
      {
        key: 'scope',
        label: 'Count tools of',
        kind: 'select',
        default: 'turn',
        choices: [
          { value: 'turn', label: 'This turn' },
          { value: 'session', label: 'This session' },
        ],
      },
      { key: 'maxTools', label: 'Max tools', kind: 'number', default: 4 },
      { key: 'groupMcp', label: 'Group MCP tools by server', kind: 'boolean', default: true },
      { key: 'showArgs', label: 'Show the running tool argument', kind: 'boolean', default: true },
    ],
    render(ctx, item) {
      const t = ctx.data.transcript();
      if (!t) return null;
      const mode = opt<string>(item, 'mode', 'both');
      const group = opt(item, 'groupMcp', true);
      const parts: string[] = [];
      if (mode !== 'counts') {
        const running = activeTools(t, ctx.now.getTime());
        const first = running[0];
        if (first) {
          const arg = opt(item, 'showArgs', true) && first.arg ? ` ${first.arg}` : '';
          parts.push(
            `${groupName(first.name, group)}${arg}${running.length > 1 ? ` +${running.length - 1}` : ''}`,
          );
        }
      }
      if (mode !== 'running') {
        const scope =
          opt<string>(item, 'scope', 'turn') === 'session' ? t.sessionToolCounts : t.turnToolCounts;
        const all = mergeCounts(scope ?? [], group);
        const max = Math.max(1, Math.floor(Number(opt(item, 'maxTools', 4))) || 1);
        const shown = all.slice(0, max).map(([name, n]) => `${name} ${n}`);
        if (shown.length) parts.push(shown.join(', ') + (all.length > max ? ` +${all.length - max}` : ''));
      }
      if (!parts.length) return null;
      return parts.join(ctx.config.charset === 'text' ? ' | ' : ' · ');
    },
  },
];
