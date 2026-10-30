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

export function aliasesFor(type: string, key: string): readonly OptionAlias[] {
  if (!Object.hasOwn(OPTION_ALIASES, type)) return [];
  const own = OPTION_ALIASES[type]!;
  return Object.hasOwn(own, key) ? own[key]! : [];
}

export function aliasValue(type: string, key: string, options: Record<string, unknown> | undefined): unknown {
  if (!options) return undefined;
  for (const a of aliasesFor(type, key)) {
    const v = options[a.key];
    if (v === undefined) continue;
    if (!a.invert) return v;
    return !(typeof v === 'boolean' ? v : v === 'true');
  }
  return undefined;
}

export function canonicalOptions<T extends Record<string, unknown>>(
  type: string,
  options: T | undefined,
): T | undefined {
  if (!options || !Object.hasOwn(OPTION_ALIASES, type)) return options;
  let out: Record<string, unknown> | undefined;
  for (const [canon, list] of Object.entries(OPTION_ALIASES[type]!)) {
    if (!list.some((a) => Object.hasOwn(options, a.key))) continue;
    out ??= { ...options };
    if (out[canon] === undefined) {
      const v = aliasValue(type, canon, options);
      if (v !== undefined) out[canon] = v;
    }
    for (const a of list) delete out[a.key];
  }
  return (out as T | undefined) ?? options;
}
