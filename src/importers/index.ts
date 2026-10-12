import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, normalizeConfig } from '../core/config.js';
import { claudeDir } from '../core/paths.js';
import type { Config } from '../core/types.js';
import { importCcstatusline } from './ccstatusline.js';
import { importClaudePowerline, parsePowerlineArgs } from './claude-powerline.js';

export type ImportSource = 'ccstatusline' | 'claude-powerline';

export interface ImportResult {
  config: Partial<Config>;
  warnings: string[];
  source: ImportSource;
  file?: string | null;
}

export interface DetectedTool {
  tool: ImportSource | 'ccometixline' | 'claude-hud' | 'ccusage' | 'gsd' | 'unknown';
  name: string;
  importable: boolean;
  command: string;
}

const KNOWN: { re: RegExp; tool: DetectedTool['tool']; name: string; importable: boolean }[] = [
  { re: /ccstatusline/i, tool: 'ccstatusline', name: 'ccstatusline', importable: true },
  { re: /claude-powerline/i, tool: 'claude-powerline', name: 'claude-powerline', importable: true },
  { re: /ccline|cometix/i, tool: 'ccometixline', name: 'CCometixLine', importable: false },
  { re: /claude-hud/i, tool: 'claude-hud', name: 'claude-hud', importable: false },
  { re: /ccusage/i, tool: 'ccusage', name: 'ccusage statusline', importable: false },
  { re: /gsd-statusline/i, tool: 'gsd', name: 'GSD status line', importable: false },
];

export function detectTool(command: string | undefined | null): DetectedTool | null {
  if (!command || /ccinfobar/i.test(command)) return null;
  const hit = KNOWN.find((k) => k.re.test(command));
  if (hit) return { tool: hit.tool, name: hit.name, importable: hit.importable, command };
  return { tool: 'unknown', name: 'a custom status line', importable: false, command };
}

function expand(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function ccstatuslinePath(env: NodeJS.ProcessEnv = process.env, command = ''): string {
  const flag = /--config[=\s]+("[^"]*"|'[^']*'|\S+)/.exec(command)?.[1]?.replace(/^["']|["']$/g, '');
  if (flag) return expand(flag);
  const base = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'ccstatusline', 'settings.json');
}

export function powerlinePaths(
  env: NodeJS.ProcessEnv = process.env,
  command = '',
  cwd = process.cwd(),
): string[] {
  const args = parsePowerlineArgs(command);
  if (args.config) return [expand(args.config)];
  if (env.CLAUDE_POWERLINE_CONFIG) return [expand(env.CLAUDE_POWERLINE_CONFIG)];
  return [
    path.join(cwd, '.claude-powerline.json'),
    path.join(claudeDir(env), 'claude-powerline.json'),
    path.join(os.homedir(), '.config', 'claude-powerline', 'config.json'),
  ];
}

export function importFrom(
  source: ImportSource,
  opts: { file?: string; command?: string; env?: NodeJS.ProcessEnv } = {},
): ImportResult {
  const env = opts.env ?? process.env;
  const command = opts.command ?? '';
  if (source === 'ccstatusline') {
    const file = opts.file ?? ccstatuslinePath(env, command);
    const raw = readJson(file);
    if (!raw) throw new Error(`Cannot read ccstatusline settings at ${file}`);
    return { ...importCcstatusline(raw), file };
  }
  const files = opts.file ? [opts.file] : powerlinePaths(env, command);
  const file = files.find((f) => fs.existsSync(f)) ?? null;
  const raw = file ? readJson(file) : {};
  if (file && raw === null) throw new Error(`Cannot parse claude-powerline config at ${file}`);
  const result = importClaudePowerline(raw, parsePowerlineArgs(command));
  if (!file) result.warnings.unshift('no claude-powerline config file found, imported its default layout');
  return { ...result, file };
}

export function toConfig(result: ImportResult): Config {
  return normalizeConfig({ ...defaultConfig(), ...result.config, lines: result.config.lines ?? [] });
}
