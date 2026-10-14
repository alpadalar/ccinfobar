import { t as tr } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { RenderContext, WidgetDef } from '../core/types.js';
import { activeTools, groupName, lastWait, mergeCounts, trustedTurn } from '../data/live.js';
import { opt, span } from './shared.js';

const turnOf = (ctx: RenderContext) =>
  trustedTurn(ctx.data.hooks?.() ?? null, ctx.data.transcript(), ctx.payload.prompt_id, ctx.now.getTime());

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
        const turn = turnOf(ctx);
        const stopAt = turn?.source === 'hooks' ? turn.end : null;
        const running = activeTools(t, ctx.now.getTime(), stopAt);
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
  {
    type: 'turn-timer',
    name: 'Turn timer',
    category: 'session',
    description:
      'How long the current turn has run, or the last one took; exact with hooks, from the transcript otherwise',
    label: 'Turn ',
    icon: { nerd: '\u{f051b}', emoji: '\u23f1\ufe0f', text: '\u23f1' },
    color: 'cyan',
    sample: '2m14s',
    options: [
      {
        key: 'afterStop',
        label: 'After the turn ends',
        kind: 'select',
        default: 'last',
        choices: [
          { value: 'last', label: 'Show last duration' },
          { value: 'hide', label: 'Hide' },
        ],
      },
    ],
    // includes permission waits
    render(ctx, item) {
      const turn = turnOf(ctx);
      if (!turn) return null;
      if (turn.end === null) return span(Math.max(0, ctx.now.getTime() - turn.start));
      if (opt<string>(item, 'afterStop', 'last') === 'hide' || turn.durationMs === null) return null;
      return tr('widget.turn.last', { time: span(turn.durationMs) });
    },
  },
  {
    type: 'permission-wait',
    name: 'Permission wait',
    category: 'session',
    description:
      'How long the last permission prompt in this turn waited (needs hooks; Claude Code hides the status line while the dialog is open)',
    label: 'Wait ',
    icon: { nerd: '\u{f03e4}', emoji: '\u23f8\ufe0f', text: '\u23f8' },
    color: 'yellow',
    sample: 'Bash 42s',
    options: [
      { key: 'showTool', label: 'Show the tool name', kind: 'boolean', default: true },
      { key: 'maxAgeMin', label: 'Ignore waits longer than (minutes)', kind: 'number', default: 30 },
    ],
    // starts at the Notification, about 6 s after the dialog opened
    render(ctx, item) {
      const h = ctx.data.hooks?.() ?? null;
      if (!h) return null;
      const t = ctx.data.transcript();
      const now = ctx.now.getTime();
      const turn = trustedTurn(h, t, ctx.payload.prompt_id, now);
      const max = Math.max(1, Number(opt(item, 'maxAgeMin', 30)) || 30) * 60_000;
      const w = lastWait(h, t, turn?.start ?? null, now, max);
      if (!w) return null;
      const tool = opt(item, 'showTool', true) && w.tool ? sanitizeText(w.tool).trim() : '';
      return { text: tool ? `${tool} ${span(w.ms)}` : span(w.ms), color: 'yellow' };
    },
  },
];
