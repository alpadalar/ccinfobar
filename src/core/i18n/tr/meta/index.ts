import type { WidgetCategory } from '../../../types.js';
import type { MetaFile, MetaTable, WidgetMeta } from '../../types.js';
import { catalog } from './catalog.js';
import { categories } from './categories.js';
import { charts } from './charts.js';
import { context } from './context.js';
import { cost } from './cost.js';
import { limits } from './limits.js';
import { session } from './session.js';
import { sharedOptions } from './shared.js';
import { tokens } from './tokens.js';

export { sharedOptions };

export const byCategory: Partial<Record<WidgetCategory, MetaFile>> = {
  session,
  context,
  tokens,
  cost,
  limits,
  charts,
};

function merge(): MetaTable {
  const widgets: Record<string, WidgetMeta> = {};
  const options: Record<string, string> = { ...sharedOptions };
  for (const file of Object.values(byCategory)) {
    Object.assign(widgets, file.widgets);
    Object.assign(options, file.options);
  }
  return { widgets, options, categories, catalog };
}

export const trMeta: MetaTable = merge();
