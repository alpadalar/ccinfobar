import type { WidgetCategory } from '../../../types.js';
import type { MetaFile, MetaTable, WidgetMeta } from '../../types.js';
import { catalog } from './catalog.js';
import { categories } from './categories.js';
import { sharedOptions } from './shared.js';

export { sharedOptions };

export const byCategory: Partial<Record<WidgetCategory, MetaFile>> = {};

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
