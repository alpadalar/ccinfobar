import type { WidgetCategory, WidgetDef } from '../core/types.js';
import { widgets as agents } from './agents.js';
import { widgets as charts } from './charts.js';
import { widgets as context } from './context.js';
import { widgets as cost } from './cost.js';
import { widgets as custom } from './custom.js';
import { widgets as git } from './git.js';
import { widgets as gsd } from './gsd.js';
import { widgets as layout } from './layout.js';
import { widgets as limits } from './limits.js';
import { widgets as live } from './live.js';
import { widgets as session } from './session.js';
import { widgets as status } from './status.js';
import { widgets as system } from './system.js';
import { widgets as tokens } from './tokens.js';
import { widgets as workspace } from './workspace.js';

export const CATEGORIES: { id: WidgetCategory; name: string }[] = [
  { id: 'session', name: 'Session & model' },
  { id: 'context', name: 'Context window' },
  { id: 'tokens', name: 'Tokens & cache' },
  { id: 'cost', name: 'Cost & time' },
  { id: 'limits', name: 'Usage limits' },
  { id: 'charts', name: 'Charts' },
  { id: 'agents', name: 'Agents & tasks' },
  { id: 'gsd', name: 'GSD' },
  { id: 'git', name: 'Git' },
  { id: 'workspace', name: 'Workspace' },
  { id: 'system', name: 'System' },
  { id: 'custom', name: 'Custom' },
  { id: 'layout', name: 'Layout' },
];

export const ALL_WIDGETS: WidgetDef[] = [
  ...session,
  ...context,
  ...tokens,
  ...cost,
  ...limits,
  ...charts,
  ...agents,
  ...live,
  ...gsd,
  ...git,
  ...workspace,
  ...system,
  ...status,
  ...custom,
  ...layout,
];

const registry = new Map(ALL_WIDGETS.map((w) => [w.type, w]));

export function getWidget(type: string): WidgetDef | undefined {
  return registry.get(type);
}
