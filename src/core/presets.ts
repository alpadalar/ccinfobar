import { defaultConfig } from './config.js';
import type { Config, WidgetItem } from './types.js';

function line(...types: (string | WidgetItem)[]): WidgetItem[] {
  return types.map((t, i) => (typeof t === 'string' ? { id: `${t}-${i + 1}`, type: t } : t));
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  build(): Config;
}

export const PRESETS: Preset[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Model, git and context, a GSD line and usage limits',
    build: defaultConfig,
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'One compact line',
    build: () => ({
      ...defaultConfig(),
      lines: [line('model', 'cwd', 'git-branch', 'context-percentage', 'gsd-phase', 'gsd-plans')],
    }),
  },
  {
    id: 'gsd',
    name: 'GSD focus',
    description: 'Everything GSD tracks, plus context',
    build: () => ({
      ...defaultConfig(),
      lines: [
        line('model', 'cwd', 'git-branch', 'context-bar'),
        line(
          'gsd-milestone',
          'gsd-milestone-progress',
          'gsd-phase',
          'gsd-status',
          'gsd-plans',
          'gsd-plan-progress',
        ),
        line('gsd-next', 'gsd-blockers', 'gsd-requirements', 'gsd-last-command', 'gsd-update'),
      ],
    }),
  },
  {
    id: 'powerline',
    name: 'Powerline',
    description: 'Powerline arrows with the Tokyo Night theme (needs a Nerd Font)',
    build: () => ({
      ...defaultConfig(),
      powerline: { enabled: true, separator: '', startCap: '', endCap: '', theme: 'tokyo-night' },
      lines: [
        line('model', 'cwd', 'git-branch', 'context-percentage'),
        line('gsd-milestone', 'gsd-phase', 'gsd-plans', 'session-cost', 'five-hour-usage'),
      ],
    }),
  },
  {
    id: 'full',
    name: 'Everything',
    description: 'Four dense lines for wide terminals',
    build: () => ({
      ...defaultConfig(),
      lines: [
        line(
          'model',
          'effort',
          'output-style',
          'session-name',
          'cwd',
          'git-branch',
          'git-changes',
          'git-ahead-behind',
          'pr',
        ),
        line(
          'context-bar',
          'context-length',
          'tokens-total',
          'cache-hit-rate',
          'cache-timer',
          'output-speed',
        ),
        line('gsd-milestone', 'gsd-milestone-progress', 'gsd-phase', 'gsd-plans', 'gsd-next', 'gsd-blockers'),
        line(
          'session-cost',
          'cost-rate',
          'session-duration',
          'five-hour-usage',
          'five-hour-reset',
          'weekly-usage',
          'weekly-reset',
        ),
      ],
    }),
  },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
