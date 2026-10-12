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

const w = (id: string, type: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({ id, type, ...extra });

export function cockpitConfig(): Config {
  return {
    ...defaultConfig(),
    theme: 'classic',
    separator: ' | ',
    widthOffset: 40,
    lines: [
      [
        w('cwd', 'cwd', { color: 'blue', raw: true, options: { style: 'tilde' } }),
        w('git-branch', 'git-branch', { color: 'cyan', raw: true }),
        w('git-changes', 'git-changes', { color: 'brightBlack', raw: true }),
      ],
      [
        w('gsd-milestone', 'gsd-milestone', { color: 'magenta' }),
        w('gsd-milestone-progress', 'gsd-milestone-progress', { color: 'green' }),
        w('gsd-phase', 'gsd-phase', { color: 'cyan' }),
        w('gsd-status', 'gsd-status'),
        w('gsd-plans', 'gsd-plans', { color: 'blue' }),
        w('gsd-next', 'gsd-next', { color: 'brightBlack' }),
      ],
      [
        w('model', 'model', { color: 'yellow', raw: true }),
        w('effort', 'effort', { color: 'magenta', raw: true }),
        w('elapsed', 'session-duration', { color: 'white', label: 'Elapsed: ' }),
        w('skills', 'skills', { color: 'brightBlack' }),
      ],
      [
        w('context-bar', 'context-bar', { color: 'cyan' }),
        w('cache-hit', 'cache-hit-rate', { color: 'green' }),
        w('tokens-total', 'tokens-total', { color: 'brightBlack' }),
        w('output-speed', 'output-speed', { color: 'brightBlack' }),
      ],
      [
        w('session-usage', 'five-hour-usage', { color: 'green', label: '5h Limit: ' }),
        w('block-reset', 'five-hour-reset', { color: 'brightBlack' }),
        w('weekly-usage', 'weekly-usage', { color: 'yellow', label: 'Weekly Limit: ' }),
        w('weekly-reset', 'weekly-reset', { color: 'brightBlack' }),
      ],
    ],
  };
}

export const PRESETS: Preset[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Model, git and context, a GSD line and usage limits',
    build: defaultConfig,
  },
  {
    id: 'cockpit',
    name: 'Cockpit',
    description:
      'Five-line developer dashboard: path and git, GSD, model and time, context and tokens, usage limits',
    build: cockpitConfig,
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
      theme: 'tokyo-night',
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
