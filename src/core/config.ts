import fs from 'node:fs';
import path from 'node:path';
import { configPath } from './paths.js';
import type { Config, PowerlineConfig, WidgetItem } from './types.js';

export const SCHEMA_URL =
  'https://raw.githubusercontent.com/alpadalar/ccinfobar/main/schema/config.schema.json';

let counter = 0;
export function newId(type = 'w'): string {
  counter = (counter + 1) % 1296;
  return `${type}-${Date.now().toString(36).slice(-4)}${counter.toString(36).padStart(2, '0')}`;
}

function item(type: string, extra: Partial<WidgetItem> = {}): WidgetItem {
  return { id: `${type}-1`, type, ...extra };
}

export const DEFAULT_POWERLINE: PowerlineConfig = {
  enabled: false,
  separator: '',
  startCap: '',
  endCap: '',
  theme: 'default',
};

export function defaultConfig(): Config {
  return {
    $schema: SCHEMA_URL,
    version: 1,
    lines: [
      [
        item('model'),
        item('effort'),
        item('cwd'),
        item('git-branch'),
        item('git-changes'),
        item('context-bar'),
      ],
      [
        item('gsd-milestone'),
        item('gsd-milestone-progress'),
        item('gsd-phase'),
        item('gsd-plans'),
        item('gsd-next'),
      ],
      [item('session-cost'), item('five-hour-usage'), item('five-hour-reset'), item('weekly-usage')],
    ],
    separator: ' │ ',
    separatorColor: 'brightBlack',
    padding: 1,
    colorLevel: 'auto',
    icons: 'text',
    maxWidth: 'auto',
    widthOffset: 4,
    powerline: { ...DEFAULT_POWERLINE },
    savePayload: true,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeItem(raw: unknown, index: number): WidgetItem | null {
  if (!isObject(raw) || typeof raw.type !== 'string' || !raw.type) return null;
  const out: WidgetItem = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${raw.type}-${index}`,
    type: raw.type,
  };
  for (const key of ['color', 'background', 'label'] as const) {
    if (typeof raw[key] === 'string') out[key] = raw[key] as string;
  }
  for (const key of ['bold', 'dim', 'italic', 'raw', 'merge'] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
  }
  if (isObject(raw.options)) {
    const opts: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw.options)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') opts[k] = v;
    }
    out.options = opts;
  }
  return out;
}

export function normalizeConfig(raw: unknown): Config {
  const base = defaultConfig();
  if (!isObject(raw)) return base;
  const cfg: Config = { ...base };
  if (Array.isArray(raw.lines)) {
    const seen = new Set<string>();
    cfg.lines = raw.lines.filter(Array.isArray).map((line) =>
      (line as unknown[])
        .map((it, i) => normalizeItem(it, i))
        .filter((it): it is WidgetItem => it !== null)
        .map((it) => {
          let id = it.id;
          let n = 2;
          while (seen.has(id)) id = `${it.id}-${n++}`;
          seen.add(id);
          return { ...it, id };
        }),
    );
  }
  if (typeof raw.separator === 'string') cfg.separator = raw.separator;
  if (typeof raw.separatorColor === 'string') cfg.separatorColor = raw.separatorColor;
  if (typeof raw.padding === 'number' && raw.padding >= 0) cfg.padding = Math.min(4, Math.floor(raw.padding));
  if (raw.colorLevel === 'auto' || [0, 1, 2, 3].includes(raw.colorLevel as number)) {
    cfg.colorLevel = raw.colorLevel as Config['colorLevel'];
  }
  if (['nerd', 'emoji', 'text', 'none'].includes(raw.icons as string))
    cfg.icons = raw.icons as Config['icons'];
  if (raw.maxWidth === 'auto' || (typeof raw.maxWidth === 'number' && raw.maxWidth > 0)) {
    cfg.maxWidth = raw.maxWidth as Config['maxWidth'];
  }
  if (typeof raw.widthOffset === 'number') cfg.widthOffset = Math.max(0, Math.floor(raw.widthOffset));
  if (typeof raw.savePayload === 'boolean') cfg.savePayload = raw.savePayload;
  if (isObject(raw.powerline)) {
    const p = raw.powerline;
    cfg.powerline = {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : base.powerline.enabled,
      separator: typeof p.separator === 'string' ? p.separator : base.powerline.separator,
      startCap: typeof p.startCap === 'string' ? p.startCap : base.powerline.startCap,
      endCap: typeof p.endCap === 'string' ? p.endCap : base.powerline.endCap,
      theme: typeof p.theme === 'string' ? p.theme : base.powerline.theme,
    };
  }
  return cfg;
}

export interface LoadResult {
  config: Config;
  path: string;
  exists: boolean;
  error?: string;
}

export function loadConfig(file = configPath()): LoadResult {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { config: normalizeConfig(JSON.parse(text)), path: file, exists: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { config: defaultConfig(), path: file, exists: false };
    return { config: defaultConfig(), path: file, exists: true, error: e.message };
  }
}

export function saveConfig(config: Config, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { $schema: SCHEMA_URL, ...normalizeConfig(config) };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
