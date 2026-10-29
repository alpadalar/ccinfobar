export interface OptionAlias {
  key: string;
  invert?: true;
}

const SHOW_DISPLAY: readonly OptionAlias[] = [{ key: 'display' }];
const SHOW_MODE: readonly OptionAlias[] = [{ key: 'mode' }];

export const OPTION_ALIASES: Record<string, Record<string, readonly OptionAlias[]>> = {
  'jj-bookmarks': { maxItems: [{ key: 'maxBookmarks' }] },
  'workspace-repos': { maxItems: [{ key: 'maxRepos' }] },
  agents: { maxItems: [{ key: 'maxAgents' }] },
  'tool-activity': { maxItems: [{ key: 'maxTools' }], show: SHOW_MODE },
  skills: { maxItems: [{ key: 'limit' }], show: SHOW_MODE },
  'cache-miss-cause': { maxItems: [{ key: 'maxCauses' }] },
  'gsd-phase': { maxLength: [{ key: 'maxNameLength' }] },
  budget: { show: SHOW_DISPLAY },
  'five-hour-usage': { show: SHOW_DISPLAY },
  'weekly-usage': { show: SHOW_DISPLAY },
  'weekly-model-usage': { show: SHOW_DISPLAY },
  'weekly-opus-usage': { show: SHOW_DISPLAY },
  'weekly-sonnet-usage': { show: SHOW_DISPLAY },
  'todo-list': { show: SHOW_DISPLAY },
  'activity-strip': { show: SHOW_MODE },
  'context-percentage': { show: SHOW_MODE },
  performance: { style: SHOW_DISPLAY },
  'jj-workspace': { hideZero: [{ key: 'hideDefault' }] },
  compactions: { hideZero: [{ key: 'showZero', invert: true }] },
  'gsd-plans': { hideZero: [{ key: 'showEmpty', invert: true }] },
  'output-style': { hideZero: [{ key: 'showDefault', invert: true }] },
  'fast-mode': { hideOff: [{ key: 'showOff', invert: true }] },
  sandbox: { hideOff: [{ key: 'showOff', invert: true }] },
};

export function aliasValue(type: string, key: string, options: Record<string, unknown> | undefined): unknown {
  if (!options) return undefined;
  const list = Object.hasOwn(OPTION_ALIASES, type) ? OPTION_ALIASES[type]![key] : undefined;
  if (!list) return undefined;
  for (const a of list) {
    const v = options[a.key];
    if (v === undefined) continue;
    if (!a.invert) return v;
    return !(typeof v === 'boolean' ? v : v === 'true');
  }
  return undefined;
}
