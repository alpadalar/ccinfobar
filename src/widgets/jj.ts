import { t } from '../core/i18n/index.js';
import type { WidgetDef } from '../core/types.js';
import { opt } from './shared.js';

export const widgets: WidgetDef[] = [
  {
    type: 'jj-bookmarks',
    name: 'JJ bookmarks',
    category: 'git',
    description: 'Bookmarks on the nearest bookmarked ancestor of the working copy',
    icon: { nerd: '', emoji: '🔖' },
    color: 'magenta',
    sample: 'main',
    options: [
      { key: 'maxItems', aliases: ['maxBookmarks'], label: 'Bookmarks shown', kind: 'number', default: 3 },
      { key: 'separator', label: 'Separator', kind: 'text', default: ', ' },
    ],
    render(ctx, item) {
      const list = ctx.data.jj?.()?.bookmarks();
      if (!list?.length) return null;
      const max = Math.max(1, Math.floor(opt(item, 'maxItems', 3)));
      const text = list.slice(0, max).join(opt(item, 'separator', ', '));
      const more = list.length - max;
      return more > 0 ? `${text} +${more}` : text;
    },
  },
  {
    type: 'jj-workspace',
    name: 'JJ workspace',
    category: 'git',
    description: 'Current jj workspace name',
    icon: { nerd: '', emoji: '🗂️' },
    color: 'blue',
    sample: 'default',
    options: [{ key: 'hideDefault', label: 'Hide the default workspace', kind: 'boolean', default: false }],
    render(ctx, item) {
      const name = ctx.data.jj?.()?.workspace();
      if (!name) return null;
      return opt(item, 'hideDefault', false) && name === 'default' ? null : name;
    },
  },
  {
    type: 'jj-revision',
    name: 'JJ change',
    category: 'git',
    description: 'Short change ID of the working copy',
    icon: { nerd: '', emoji: '#️⃣' },
    color: 'green',
    sample: 'kkmpptxz',
    render: (ctx) => ctx.data.jj?.()?.change()?.id || null,
  },
  {
    type: 'jj-description',
    name: 'JJ description',
    category: 'git',
    description: 'First line of the working-copy description',
    icon: { nerd: '', emoji: '💬' },
    color: 'white',
    sample: 'Wire GSD widgets into renderer',
    render(ctx) {
      const c = ctx.data.jj?.()?.change();
      if (!c) return null;
      return c.description || t('widget.jjDescription.none');
    },
  },
  {
    type: 'jj-changes',
    name: 'JJ changes',
    category: 'git',
    description: 'Inserted and deleted lines in the working-copy change',
    icon: { nerd: '󰦒', emoji: '✏️' },
    color: 'yellow',
    sample: '+42 -10',
    options: [
      {
        key: 'snapshot',
        label: 'Snapshot working copy',
        kind: 'boolean',
        default: false,
        help: 'Off reads the last snapshot and never writes to the repo',
      },
    ],
    render(ctx, item) {
      const d = ctx.data.jj?.()?.diff(opt(item, 'snapshot', false));
      return d ? `+${d.insertions} -${d.deletions}` : null;
    },
  },
];
