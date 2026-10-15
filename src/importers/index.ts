import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, normalizeConfig } from '../core/config.js';
import { t } from '../core/i18n/index.js';
import { claudeDir, tildify } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config } from '../core/types.js';
import { CCLINE_DEFAULT, importCcometixline } from './ccometixline.js';
import { importCcstatusline } from './ccstatusline.js';
import { importClaudePowerline, parsePowerlineArgs } from './claude-powerline.js';
import { parseToml, TomlError } from './toml.js';

export const IMPORT_SOURCES = ['ccstatusline', 'claude-powerline', 'ccometixline'] as const;

export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_ALIASES: Record<string, ImportSource> = { ccline: 'ccometixline' };

export interface ImportNote {
  kind: 'approx' | 'drop' | 'info';
  text: string;
}

export interface ImportResult {
  config: Partial<Config>;
  notes: ImportNote[];
  source: ImportSource;
  file?: string | null;
}

export const MAX_SOURCE_BYTES = 1_048_576;

export class SourceTooLargeError extends Error {}

export function resolveSource(name: string | undefined): ImportSource | null {
  if (typeof name !== 'string') return null;
  const key = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const hit = IMPORT_SOURCES.find((s) => s === key);
  return hit ?? (Object.hasOwn(IMPORT_ALIASES, key) ? IMPORT_ALIASES[key]! : null);
}

// fstat on the open fd, so a swapped file is still capped
export function readSource(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const tooLarge = () => new SourceTooLargeError(t('import.tooLarge', { file }));
    if (fs.fstatSync(fd).size > MAX_SOURCE_BYTES) throw tooLarge();
    const buf = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > MAX_SOURCE_BYTES) throw tooLarge();
    const text = buf.toString('utf8', 0, n);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

export interface DetectedTool {
  tool: ImportSource | 'claude-hud' | 'ccusage' | 'gsd' | 'unknown';
  name: string;
  importable: boolean;
  command: string;
}

const KNOWN: {
  re: RegExp;
  tool: DetectedTool['tool'];
  name: string | (() => string);
  importable: boolean;
}[] = [
  { re: /ccstatusline/i, tool: 'ccstatusline', name: 'ccstatusline', importable: true },
  { re: /claude-powerline/i, tool: 'claude-powerline', name: 'claude-powerline', importable: true },
  { re: /ccline|cometix/i, tool: 'ccometixline', name: 'CCometixLine', importable: true },
  { re: /claude-hud/i, tool: 'claude-hud', name: 'claude-hud', importable: false },
  { re: /ccusage/i, tool: 'ccusage', name: 'ccusage statusline', importable: false },
  { re: /gsd-statusline/i, tool: 'gsd', name: () => t('import.tool.gsd'), importable: false },
];

export function detectTool(command: string | undefined | null): DetectedTool | null {
  if (!command || /ccinfobar/i.test(command)) return null;
  const hit = KNOWN.find((k) => k.re.test(command));
  if (hit) {
    const name = typeof hit.name === 'string' ? hit.name : hit.name();
    return { tool: hit.tool, name, importable: hit.importable, command };
  }
  return { tool: 'unknown', name: t('import.tool.custom'), importable: false, command };
}

function expand(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(readSource(file));
  } catch (err) {
    if (err instanceof SourceTooLargeError) throw err;
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

function firstPath(command: string): string | null {
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const token = expand(m[1] ?? m[2] ?? m[3]!);
    if (/[\\/]/.test(token)) return path.isAbsolute(token) ? token : null;
  }
  return null;
}

// regular files only, never through a symlink
function isPlainFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export function ccometixlinePaths(
  command: string,
  home = os.homedir(),
): { file: string | null; note: 'command-dir' | null } {
  const homeFile = path.join(home, '.claude', 'ccline', 'config.toml');
  if (fs.existsSync(homeFile)) return { file: homeFile, note: null };
  const bin = firstPath(command);
  if (bin) {
    const dirs = [path.dirname(bin)];
    for (let d = path.dirname(bin); path.dirname(d) !== d; d = path.dirname(d)) {
      if (path.basename(d) === 'ccline' && d !== dirs[0]) dirs.push(d);
    }
    for (const d of dirs) {
      const file = path.join(d, 'config.toml');
      if (isPlainFile(file)) return { file, note: 'command-dir' };
    }
  }
  return { file: null, note: null };
}

function readToml(file: string, tool: string): unknown {
  let text: string;
  try {
    text = readSource(file);
  } catch (err) {
    if (err instanceof SourceTooLargeError) throw err;
    throw new Error(t('import.cannotReadTool', { tool, file }));
  }
  try {
    return parseToml(text);
  } catch (err) {
    if (err instanceof TomlError) {
      throw new Error(`${sanitizeText(tildify(file))}:${err.line}:${err.col} ${err.message}`);
    }
    throw err;
  }
}

function importCcline(file: string | undefined, command: string): ImportResult {
  const found = file ? { file, note: null } : ccometixlinePaths(command);
  if (!found.file) return { ...importCcometixline(CCLINE_DEFAULT, { defaulted: true }), file: null };
  const result = importCcometixline(readToml(found.file, 'CCometixLine'));
  if (found.note === 'command-dir') {
    result.notes.unshift({
      kind: 'info',
      text: t('import.note.commandDir', { tool: 'CCometixLine', file: sanitizeText(tildify(found.file)) }),
    });
  }
  return { ...result, file: found.file };
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
    if (!raw) throw new Error(t('import.cannotRead', { file }));
    return { ...importCcstatusline(raw), file };
  }
  if (source === 'ccometixline') return importCcline(opts.file, command);
  const files = opts.file ? [opts.file] : powerlinePaths(env, command);
  const file = files.find((f) => fs.existsSync(f)) ?? null;
  const raw = file ? readJson(file) : {};
  if (file && raw === null) throw new Error(t('import.cannotParse', { file }));
  const result = importClaudePowerline(raw, parsePowerlineArgs(command));
  if (!file) result.notes.unshift({ kind: 'info', text: t('import.note.defaultLayout', { tool: source }) });
  return { ...result, file };
}

export function toConfig(result: ImportResult): Config {
  return normalizeConfig({ ...defaultConfig(), ...result.config, lines: result.config.lines ?? [] });
}
