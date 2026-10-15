import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../data/store.js';
import { defaultConfig, normalizeConfig } from './config.js';
import { uniqueId } from './edit.js';
import { t } from './i18n/index.js';
import { configDir } from './paths.js';
import type { Config, WidgetItem } from './types.js';

function line(...types: (string | WidgetItem)[]): WidgetItem[] {
  return types.map((t, i) => (typeof t === 'string' ? { id: `${t}-${i + 1}`, type: t } : t));
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  build(): Config;
  source?: 'builtin' | 'user';
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

// boxed overview like yet-another-statusline
export function dashboardConfig(): Config {
  return {
    ...defaultConfig(),
    theme: 'panel',
    style: 'tui',
    tui: {
      box: 'rounded',
      borderColor: 'context',
      columnGap: ' │ ',
      padding: 1,
      maxWidth: 140,
      title: { left: '{sid.value}', right: '{model}{effort}' },
    },
    lines: [
      [
        w('sid', 'session-id', { dim: true, options: { short: true } }),
        w('model', 'model', { label: ' ', color: 'black', background: 'yellow', bold: true }),
        w('effort', 'effort', { label: ' ', color: 'black', background: 'yellow', hideEmpty: true }),
      ],
      [
        w('cwd', 'cwd', { raw: true, merge: true, options: { style: 'tilde' } }),
        w('git-branch', 'git-branch', { raw: true, merge: true }),
        w('git-changes', 'git-changes', { raw: true }),
        w('ctx', 'context-percentage', {}),
        w('h5', 'five-hour-usage', { options: { showPace: true } }),
        w('d7', 'weekly-usage', {}),
        w('cache', 'cache-timer', {}),
      ],
      [w('bar', 'context-bar', { options: { fill: true, width: 10 } })],
      [
        w('tokens-input', 'tokens-input', { merge: true }),
        w('tokens-output', 'tokens-output', {}),
        w('cost', 'session-cost', {}),
        w('rate', 'token-rate-graph', { options: { fill: true } }),
      ],
      [w('skills', 'skills', { hideEmpty: true, options: { mode: 'list' } })],
      [w('todo', 'todo-list', { hideEmpty: true })],
      [w('agents', 'agents', { hideEmpty: true })],
    ],
  };
}

export const PRESETS: Preset[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Model, git and context, usage limits, and a GSD line when GSD is installed',
    build: defaultConfig,
  },
  {
    id: 'cockpit',
    name: 'Cockpit',
    description: 'Developer dashboard: path and git, GSD, model and time, context and tokens, usage limits',
    build: cockpitConfig,
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    description:
      'A boxed overview: model in the corner, usage cells, a full-width context bar, token graph, tasks and subagents',
    build: dashboardConfig,
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
    description: 'Dense lines for wide terminals',
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

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function presetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'presets');
}

function readUserPreset(file: string, id: string): Preset | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const config = normalizeConfig(raw.config);
    return {
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      description: typeof raw.description === 'string' ? raw.description : '',
      build: () => structuredClone(config),
      source: 'user',
    };
  } catch {
    return null;
  }
}

export function listPresets(dir = presetsDir()): Preset[] {
  const out = new Map<string, Preset>(PRESETS.map((p) => [p.id, { ...p, source: 'builtin' }]));
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {}
  for (const f of files.sort()) {
    const id = f.slice(0, -5);
    const p = ID_RE.test(id) ? readUserPreset(path.join(dir, f), id) : null;
    if (p) out.set(id, p);
  }
  return [...out.values()];
}

export function getPreset(id: string, dir = presetsDir()): Preset | undefined {
  return listPresets(dir).find((p) => p.id === id);
}

export function saveUserPreset(
  input: { id: string; name?: string; description?: string; config: unknown },
  dir = presetsDir(),
): string {
  if (!ID_RE.test(input.id)) throw new Error(t('err.server.presetIdRule'));
  const { $schema: _s, ...config } = normalizeConfig(input.config);
  const file = path.join(dir, `${input.id}.json`);
  const data = { name: input.name || input.id, description: input.description ?? '', config };
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { class: 'settings' });
  return file;
}

export function deleteUserPreset(id: string, dir = presetsDir()): boolean {
  if (!ID_RE.test(id)) return false;
  try {
    fs.unlinkSync(path.join(dir, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

const isGsd = (i: WidgetItem) => i.type.startsWith('gsd-');

export function hasGsd(config: Config): boolean {
  return config.lines.some((l) => l.some(isGsd));
}

export function withoutGsd(config: Config): Config {
  const lines = config.lines
    .filter((l) => !(l.length && l.every(isGsd)))
    .map((l) => l.filter((i) => !isGsd(i)));
  return { ...config, lines };
}

// layout for people without GSD
export function forGsd(config: Config, installed: boolean): Config {
  if (installed || !hasGsd(config)) return config;
  return { ...withoutGsd(config), gsdAutoLine: true };
}

export function starterConfig(gsd: boolean): Config {
  return forGsd(defaultConfig(), gsd);
}

export function gsdLine(): WidgetItem[] {
  return defaultConfig().lines.find((l) => l.length && l.every(isGsd)) ?? [];
}

// once GSD shows up, add its line second
export function applyGsdAutoLine(config: Config, installed: boolean): Config | null {
  if (!config.gsdAutoLine || !installed) return null;
  const { gsdAutoLine: _done, ...rest } = config;
  if (hasGsd(rest)) return rest;
  let next: Config = rest;
  const items = gsdLine().map((i) => {
    const id = uniqueId(next, i.type);
    const item = { ...i, id };
    next = { ...next, lines: [...next.lines, [item]] };
    return item;
  });
  const lines = [...rest.lines];
  const at = Math.min(1, lines.length);
  lines.splice(at, 0, items);
  if (!rest.lineAlign) return { ...rest, lines };
  const lineAlign = [...rest.lineAlign];
  if (lineAlign.length > at) lineAlign.splice(at, 0, null);
  return { ...rest, lines, lineAlign };
}
