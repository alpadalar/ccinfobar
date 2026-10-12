import type { WidgetDef } from '../core/types.js';
import { opt } from './shared.js';

export const widgets: WidgetDef[] = [
  {
    type: 'text',
    name: 'Text',
    category: 'layout',
    description: 'Static custom text',
    color: 'white',
    options: [{ key: 'text', label: 'Text', kind: 'text', default: 'text' }],
    render: (_ctx, item) => opt(item, 'text', ''),
  },
  {
    type: 'separator',
    name: 'Separator',
    category: 'layout',
    description: 'Manual separator; use with an empty global separator',
    color: 'brightBlack',
    options: [{ key: 'char', label: 'Character', kind: 'text', default: '|' }],
    render: (_ctx, item) => opt(item, 'char', '|'),
  },
  {
    type: 'flex',
    name: 'Flex space',
    category: 'layout',
    description: 'Pushes the following widgets to the right edge',
    color: 'default',
    render: () => ' ',
  },
];
