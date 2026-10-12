import type { WidgetDef } from '../core/types.js';

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
];
