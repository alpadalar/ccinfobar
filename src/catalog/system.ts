import { forGsd, PRESETS, type Preset } from '../core/presets.js';
import { BUILTIN_THEMES } from '../core/themes.js';
import type { Config } from '../core/types.js';
import { type EntryContent, type EntryKind, LAYOUT_KEYS, pick } from './model.js';

export interface SystemBundle {
  id: string;
  name: string;
  description: string;
  preset: string;
  theme: string;
  scenario?: string;
  appearance?: Partial<Config>;
}

export const SYSTEM_BUNDLES: SystemBundle[] = [
  {
    id: 'catppuccin-cockpit',
    name: 'Mocha cockpit',
    description: 'The Cockpit layout in Catppuccin Mocha powerline colors',
    preset: 'cockpit',
    theme: 'catppuccin-mocha',
  },
  {
    id: 'nord-minimal',
    name: 'Nord minimal',
    description: 'One compact line in cool Nord powerline colors',
    preset: 'minimal',
    theme: 'nord',
  },
  {
    id: 'dracula-powerline',
    name: 'Dracula arrows',
    description: 'The Powerline layout in Dracula colors (needs a Nerd Font)',
    preset: 'powerline',
    theme: 'dracula',
  },
  {
    id: 'gruvbox-git',
    name: 'Gruvbox git',
    description: 'The Git focus layout in warm Gruvbox powerline colors',
    preset: 'git',
    theme: 'gruvbox',
  },
  {
    id: 'tokyo-night-limits',
    name: 'Tokyo limits',
    description: 'Usage limits with pace and projection in Tokyo Night colors',
    preset: 'limits',
    theme: 'tokyo-night',
    scenario: 'near-5h-limit',
  },
  {
    id: 'mono-compact',
    name: 'Mono compact',
    description: 'One dense line without colors or powerline glyphs, for plain terminals and pasting',
    preset: 'compact',
    theme: 'mono',
    appearance: { style: 'text' },
  },
  {
    id: 'everforest-workspace',
    name: 'Everforest repos',
    description: 'Every repo in a folder of projects in soft Everforest colors',
    preset: 'workspace',
    theme: 'everforest',
    scenario: 'workspace-folder',
  },
  {
    id: 'kanagawa-agents',
    name: 'Kanagawa agents',
    description: 'Turn timer, tools, subagents and tasks in Kanagawa colors',
    preset: 'agents',
    theme: 'kanagawa',
    scenario: 'many-subagents',
  },
  {
    id: 'rose-pine-two-line',
    name: 'Rosé Pine 2-line',
    description: 'A balanced two-line layout in Rosé Pine colors',
    preset: 'two-line',
    theme: 'rose-pine',
  },
  {
    id: 'one-dark-cost',
    name: 'One Dark cost',
    description: 'Session, daily and weekly cost with a budget bar in One Dark capsules',
    preset: 'cost',
    theme: 'one-dark',
    scenario: 'over-budget',
  },
  {
    id: 'solarized-gsd',
    name: 'Solarized GSD',
    description: 'Everything GSD tracks in Solarized colors',
    preset: 'gsd',
    theme: 'solarized',
    scenario: 'gsd-project',
  },
  {
    id: 'panel-dashboard',
    name: 'Panel dashboard',
    description: 'The boxed dashboard with usage cells, a context bar and a token graph',
    preset: 'dashboard',
    theme: 'panel',
    appearance: { style: 'tui' },
  },
  {
    id: 'paper-default',
    name: 'Paper default',
    description: 'The default layout in light Paper blocks, for light terminals',
    preset: 'default',
    theme: 'paper',
  },
  {
    id: 'neon-charts',
    name: 'Neon charts',
    description: 'Sparklines for context, tokens, speed, spend and usage in vivid Neon colors',
    preset: 'charts',
    theme: 'neon',
  },
  {
    id: 'amber-session',
    name: 'Amber session',
    description: 'Session stats in a retro amber terminal look',
    preset: 'session',
    theme: 'amber',
  },
];

export interface SystemEntry {
  source: 'system';
  ref: string;
  kind: EntryKind;
  id: string;
  name: string;
  description: string;
  author: 'ccinfobar';
  version: 1;
  content: EntryContent;
  scenario?: string;
}

function entry(
  kind: EntryKind,
  r: { id: string; name: string; description: string },
  content: EntryContent,
  scenario?: string,
): SystemEntry {
  const e: SystemEntry = {
    source: 'system',
    ref: `${kind}/${r.id}`,
    kind,
    id: r.id,
    name: r.name,
    description: r.description,
    author: 'ccinfobar',
    version: 1,
    content,
  };
  if (scenario) e.scenario = scenario;
  return e;
}

export function systemEntries(opts: { gsd: boolean }): SystemEntry[] {
  const presets = PRESETS.filter((p) => opts.gsd || p.id !== 'gsd');
  const layout = (p: Preset) => pick(forGsd(p.build(), opts.gsd), LAYOUT_KEYS);
  const out: SystemEntry[] = [];
  for (const b of SYSTEM_BUNDLES) {
    const p = presets.find((x) => x.id === b.preset);
    if (!p) continue;
    const appearance = { theme: b.theme, ...structuredClone(b.appearance) };
    out.push(entry('bundle', b, { layout: layout(p), appearance }, b.scenario));
  }
  for (const p of presets) out.push(entry('preset', p, { layout: layout(p) }));
  for (const t of BUILTIN_THEMES) out.push(entry('theme', t, { appearance: { theme: t.id } }));
  return out;
}

export function findSystem(ref: string, opts: { gsd: boolean }): SystemEntry | null {
  return systemEntries(opts).find((e) => e.ref === ref) ?? null;
}
