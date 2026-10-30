import '../core/i18n/lazy.js';
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, normalizeConfig } from '../core/config.js';
import { t } from '../core/i18n/index.js';
import { canonicalOptions } from '../core/option-aliases.js';
import { claudeDir, claudeSettingsPath } from '../core/paths.js';
import type { Config } from '../core/types.js';
import { binName, commandArgs, flagValue, isBin, isScript, scriptName, tokenRe, toolArgs } from './args.js';
import { commandScript } from './cc-statusline.js';
import { CCOMETIXLINE, importCclineFamily } from './ccline-load.js';
import { isCcline } from './ccometixline.js';
import { importCcstatusline } from './ccstatusline.js';
import { importClaudeHud, mergeHud, normalizeHud, parseExtraCmd } from './claude-hud.js';
import { importClaudePowerline, isPowerline, parsePowerlineArgs } from './claude-powerline.js';
import { importCship, isCship, parseCshipConfigFlag } from './cship.js';
import {
  expand,
  homeOf,
  isFile,
  isPlainFile,
  readJson,
  readSource,
  readToml,
  SourceTooLargeError,
  shownFile,
  tableOf,
} from './io.js';
import {
  type ImporterDef,
  importerList,
  LEGACY_INFO,
  loadFromRegistry,
  makeCtx,
  otherCommandNote,
  REGISTRY,
  registryDef,
} from './registry.js';

export { ccometixlinePaths } from './ccline-load.js';
export { MAX_SOURCE_BYTES, readSource, SourceTooLargeError } from './io.js';

export const IMPORT_SOURCES = [
  'ccstatusline',
  'claude-powerline',
  'ccometixline',
  'cship',
  'claude-hud',
  'best-claude-hud',
  'byebyecode',
  'claudebar',
  'statusline-pro',
  'claude-code-statusline',
  'starship-claude',
  'pyccsl',
  'coralline',
  'claude-statusbar',
  'nycu-cc-statusline',
  'claude-ultimate-hud',
  'ccpet',
  'cc-statusline',
  'claudeline',
  'claude-usage-monitor',
  'glauberlima-statusline',
  'token-tracker',
] as const;

export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_ALIASES: Record<string, ImportSource> = Object.fromEntries(
  importerList().flatMap((i) => (i.aliases ?? []).map((a) => [a, i.source] as const)),
);

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

export function resolveSource(name: string | undefined): ImportSource | null {
  if (typeof name !== 'string') return null;
  const key = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const hit = IMPORT_SOURCES.find((s) => s === key);
  return hit ?? (Object.hasOwn(IMPORT_ALIASES, key) ? IMPORT_ALIASES[key]! : null);
}

export interface DetectedTool {
  tool: ImportSource | 'ccusage' | 'gsd' | 'other' | 'unknown';
  name: string;
  importable: boolean;
  command: string;
}

const isCcstatusline = isBin('ccstatusline', 'ccstatusline-zh');

const runsTool = (isTool: (token: string) => boolean) => (command: string) =>
  toolArgs(commandArgs(command), isTool) !== null;

const HUD = 'claude-hud';
// the plugin command runs node on a path with a claude-hud segment
const runsHud = runsTool((tok) => tok.split(/[\\/]/).includes(HUD));

const runsCcinfobar = runsTool(
  (tok) => ['ccinfobar', 'ccinfobar.js'].includes(binName(tok)) || scriptName(tok) === 'ccinfobar',
);

interface Known {
  re?: RegExp;
  runs?: (command: string) => boolean;
  tool: DetectedTool['tool'];
  name: string | (() => string);
  importable: boolean;
}

const LEGACY_KNOWN: readonly Known[] = [
  {
    runs: runsTool(isBin('ccstatusline-zh')),
    tool: 'ccstatusline',
    name: 'ccstatusline-zh',
    importable: true,
  },
  { runs: runsTool(isCcstatusline), tool: 'ccstatusline', name: 'ccstatusline', importable: true },
  { runs: runsTool(isPowerline), tool: 'claude-powerline', name: 'claude-powerline', importable: true },
  { runs: runsTool(isCcline), tool: 'ccometixline', name: 'CCometixLine', importable: true },
  { runs: runsTool(isCship), tool: 'cship', name: 'cship', importable: true },
  { runs: runsHud, tool: 'claude-hud', name: 'claude-hud', importable: true },
];

// reviewed tools with nothing to import, matched by their documented install paths
const OTHER_KNOWN: readonly Known[] = [
  { re: /arcade-statusline/i, tool: 'other', name: 'arcade-statusline', importable: false },
  { re: /awesome-statusline/i, tool: 'other', name: 'awesome-statusline', importable: false },
  {
    re: /yet-another-statusline|[\\/]claude[\\/]statusline_command\.py/i,
    tool: 'other',
    name: 'yet-another-statusline',
    importable: false,
  },
  {
    re: /[\\/]\.claude[\\/]statusline[\\/]statusline\.ps1/i,
    tool: 'other',
    name: 'ClaudeCodeStatusLine',
    importable: false,
  },
];

const TAIL_KNOWN: readonly Known[] = [
  { runs: runsTool(isBin('ccusage')), tool: 'ccusage', name: 'ccusage statusline', importable: false },
  {
    runs: runsTool(isScript('gsd-statusline')),
    tool: 'gsd',
    name: () => t('import.tool.gsd'),
    importable: false,
  },
];

// first match wins, so the most specific names go first
function knownList(defs: readonly ImporterDef[]): Known[] {
  const own = defs.flatMap((d): Known[] => {
    const names = d.names?.length ? tokenRe(...d.names) : null;
    const base = { tool: d.source, name: d.name, importable: true };
    return [
      ...(d.detect ?? []).map((re) => ({ re, ...base })),
      ...(names ? [{ runs: runsTool((tok) => names.test(tok)), ...base }] : []),
    ];
  });
  return [...own, ...LEGACY_KNOWN, ...OTHER_KNOWN, ...TAIL_KNOWN];
}

export function detectTool(
  command: string | undefined | null,
  defs: readonly ImporterDef[] = REGISTRY,
): DetectedTool | null {
  if (!command || runsCcinfobar(command)) return null;
  const hit = knownList(defs).find((k) => (k.runs ? k.runs(command) : k.re?.test(command)));
  if (hit) {
    const name = typeof hit.name === 'string' ? hit.name : hit.name();
    return { tool: hit.tool, name, importable: hit.importable, command };
  }
  return { tool: 'unknown', name: t('import.tool.custom'), importable: false, command };
}

const SNIFF_BYTES = 512;

// reviewed scripts with nothing to import, by their contents
const OTHER_SNIFF: readonly { marker: RegExp; name: string }[] = [
  { marker: /daniel3303\/ClaudeCodeStatusLine/, name: 'ClaudeCodeStatusLine' },
];

function readHead(file: string, bytes = SNIFF_BYTES): string | null {
  let fd: number | null = null;
  try {
    // no symlink and no blocking open where the platform has the flags
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(file, flags);
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// reads a few bytes of the named file, never runs it
export function sniffTool(
  command: string,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; defs?: readonly ImporterDef[] } = {},
): DetectedTool | null {
  const ctx = makeCtx({ command, env: opts.env, cwd: opts.cwd });
  for (const def of opts.defs ?? REGISTRY) {
    if (!def.sniff) continue;
    let file: string | null;
    try {
      file = def.sniff.file(ctx);
    } catch {
      continue;
    }
    if (!file || !isPlainFile(file)) continue;
    const head = readHead(file, def.sniff.bytes);
    if (head !== null && def.sniff.marker.test(head)) {
      return { tool: def.source, name: def.name, importable: true, command };
    }
  }
  const script = commandScript(ctx);
  const head = script && isPlainFile(script) ? readHead(script) : null;
  const other = head === null ? undefined : OTHER_SNIFF.find((o) => o.marker.test(head));
  return other ? { tool: 'other', name: other.name, importable: false, command } : null;
}

export function ccstatuslinePath(env: NodeJS.ProcessEnv = process.env, command = ''): string {
  const flag = flagValue(toolArgs(commandArgs(command), isCcstatusline) ?? [], ['--config']);
  const home = homeOf(env);
  if (flag) return expand(flag, home);
  const base = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(base, 'ccstatusline', 'settings.json');
}

export function powerlinePaths(
  env: NodeJS.ProcessEnv = process.env,
  command = '',
  cwd = process.cwd(),
): string[] {
  const args = parsePowerlineArgs(command);
  const home = homeOf(env);
  if (args.config) return [expand(args.config, home)];
  if (env.CLAUDE_POWERLINE_CONFIG) return [expand(env.CLAUDE_POWERLINE_CONFIG, home)];
  return [
    path.join(cwd, '.claude-powerline.json'),
    path.join(claudeDir(env), 'claude-powerline.json'),
    path.join(home, '.config', 'claude-powerline', 'config.json'),
  ];
}

export interface CshipFound {
  file: string;
  table: 'wrapper-or-root' | 'cship-only';
  note: 'starship-config' | null;
}

const cshipTable = (file: string): CshipFound['table'] =>
  path.basename(file) === 'cship.toml' ? 'wrapper-or-root' : 'cship-only';

function isInside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// cship's load_with_source, plus $STARSHIP_CONFIG last
export function cshipDiscover(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): CshipFound | null {
  const flag = parseCshipConfigFlag(opts.command);
  if (flag) {
    const file = path.resolve(opts.cwd, expand(flag, homeOf(opts.env)));
    return { file, table: cshipTable(file), note: null };
  }
  const home = [opts.env.CLAUDE_HOME, opts.env.HOME, opts.env.USERPROFILE].find((h) => h);
  const cwd = path.resolve(opts.cwd);
  // D-25: a cwd under home stops at home, so nothing above it is read
  const top = home && isInside(cwd, path.resolve(home)) ? path.resolve(home) : null;
  for (let d = cwd; ; d = path.dirname(d)) {
    const own = path.join(d, 'cship.toml');
    if (isFile(own)) return { file: own, table: 'wrapper-or-root', note: null };
    const starship = path.join(d, 'starship.toml');
    if (isFile(starship)) return { file: starship, table: 'cship-only', note: null };
    if (path.dirname(d) === d || (top !== null && path.relative(d, top) === '')) break;
  }
  if (home) {
    const own = path.join(home, '.config', 'cship.toml');
    if (isFile(own)) return { file: own, table: 'wrapper-or-root', note: null };
    const starship = path.join(home, '.config', 'starship.toml');
    if (isFile(starship)) return { file: starship, table: 'cship-only', note: null };
  }
  const env = opts.env.STARSHIP_CONFIG ? expand(opts.env.STARSHIP_CONFIG, homeOf(opts.env)) : '';
  if (env && path.isAbsolute(env) && isFile(env)) {
    return { file: env, table: 'cship-only', note: 'starship-config' };
  }
  return null;
}

function importCshipFrom(found: CshipFound | null, home: string): ImportResult {
  if (!found) throw new Error(t('import.cshipNotFound'));
  const doc = tableOf(readToml(found.file, 'cship', home)) ?? {};
  const wrapped = Object.hasOwn(doc, 'cship');
  const cfg = found.table === 'cship-only' || wrapped ? (tableOf(doc.cship) ?? {}) : doc;
  const hasLines = Array.isArray(cfg.lines) && cfg.lines.some((l) => typeof l === 'string');
  if (typeof cfg.format !== 'string' && !hasLines) {
    throw new Error(t('import.cshipNoLines', { file: shownFile(found.file, home) }));
  }
  const result = importCship(cfg);
  if (found.note === 'starship-config') {
    const file = shownFile(found.file, home);
    result.notes.unshift({ kind: 'info', text: t('import.note.starshipConfig', { tool: 'cship', file }) });
  }
  return { ...result, file: found.file };
}

// claude-hud's getClaudeConfigDir
export function hudPaths(env: NodeJS.ProcessEnv = process.env): {
  dir: string;
  config: string;
  override: string;
} {
  const home = homeOf(env);
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  const tilde = raw === '~' ? home : raw && /^~[\\/]/.test(raw) ? path.join(home, raw.slice(2)) : raw;
  const dir = tilde ? path.resolve(tilde) : path.join(home, '.claude');
  return {
    dir,
    config: path.join(dir, 'plugins', 'claude-hud', 'config.json'),
    override: path.join(dir, 'claude-hud.json'),
  };
}

const truthy = (v: unknown) =>
  typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

function hudExtraAllowed(env: NodeJS.ProcessEnv): boolean {
  if (truthy(env.CLAUDE_HUD_ALLOW_EXTRA_CMD)) return true;
  try {
    const settings = readJson(claudeSettingsPath(env));
    const block = tableOf(tableOf(settings)?.env);
    return !!block && truthy(block.CLAUDE_HUD_ALLOW_EXTRA_CMD);
  } catch {
    return false;
  }
}

function readHudFile(file: string, required: boolean, home: string): { value: unknown } | null {
  if (!required && !isFile(file)) return null;
  const shown = shownFile(file, home);
  let text: string;
  try {
    text = readSource(file);
  } catch (err) {
    if (err instanceof SourceTooLargeError) throw err;
    throw new Error(t('import.cannotReadTool', { tool: HUD, file: shown }));
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    throw new Error(t('import.cannotParseTool', { tool: HUD, file: shown }));
  }
}

function importHud(file: string | undefined, command: string, env: NodeJS.ProcessEnv): ImportResult {
  const paths = hudPaths(env);
  const mainFile = file ?? paths.config;
  const home = homeOf(env);
  const main = readHudFile(mainFile, !!file, home);
  const over = readHudFile(paths.override, false, home);
  const notes: ImportNote[] = [];
  const objectOf = (read: { value: unknown } | null, f: string): unknown => {
    if (!read) return {};
    if (tableOf(read.value)) return read.value;
    notes.push({ kind: 'info', text: t('import.note.hudIgnored', { file: shownFile(f, home) }) });
    return {};
  };
  const merged = mergeHud(objectOf(main, mainFile), objectOf(over, paths.override));
  const extraCmd = runsHud(command) ? parseExtraCmd(command) : null;
  const result = importClaudeHud(normalizeHud(merged), {
    extraCmd,
    extraAllowed: extraCmd !== null && hudExtraAllowed(env),
    defaulted: !main && !over,
  });
  result.notes.unshift(...notes);
  return { ...result, file: main ? mainFile : over ? paths.override : null };
}

type LegacySource = 'ccstatusline' | 'claude-powerline' | 'ccometixline' | 'cship' | 'claude-hud';

const LEGACY_RUNS: Record<LegacySource, (command: string) => boolean> = {
  ccstatusline: runsTool(isCcstatusline),
  'claude-powerline': runsTool(isPowerline),
  ccometixline: runsTool(isCcline),
  cship: runsTool(isCship),
  'claude-hud': runsHud,
};

const isLegacy = (source: ImportSource): source is LegacySource => Object.hasOwn(LEGACY_RUNS, source);

export function importFrom(
  source: ImportSource,
  opts: { file?: string; command?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): ImportResult {
  const def = registryDef(source);
  if (def) return loadFromRegistry(def, opts);
  // never fall through to another tool
  if (!isLegacy(source)) throw new Error(String(source));
  const result = importLegacy(source, opts);
  const command = opts.command ?? '';
  const name = LEGACY_INFO.find((i) => i.source === source)?.name ?? source;
  const note = otherCommandNote(command, LEGACY_RUNS[source](command), name);
  if (note) result.notes.unshift(note);
  return result;
}

function importLegacy(
  source: LegacySource,
  opts: { file?: string; command?: string; env?: NodeJS.ProcessEnv; cwd?: string },
): ImportResult {
  const env = opts.env ?? process.env;
  const command = opts.command ?? '';
  switch (source) {
    case 'cship': {
      const cwd = opts.cwd ?? process.cwd();
      const found = opts.file
        ? { file: opts.file, table: cshipTable(opts.file), note: null }
        : cshipDiscover({ command, cwd, env });
      return importCshipFrom(found, homeOf(env));
    }
    case 'ccstatusline': {
      const file = opts.file ?? ccstatuslinePath(env, command);
      const raw = readJson(file);
      if (!raw) throw new Error(t('import.cannotRead', { file: shownFile(file, homeOf(env)) }));
      return { ...importCcstatusline(raw), file };
    }
    case 'ccometixline':
      return importCclineFamily(opts.file, { command, home: homeOf(env) }, CCOMETIXLINE);
    case 'claude-hud':
      return importHud(opts.file, command, env);
    case 'claude-powerline': {
      const files = opts.file ? [opts.file] : powerlinePaths(env, command, opts.cwd ?? process.cwd());
      const file = files.find(isFile) ?? null;
      const raw = file ? readJson(file) : {};
      if (file && raw === null) {
        throw new Error(t('import.cannotParse', { file: shownFile(file, homeOf(env)) }));
      }
      const result = importClaudePowerline(raw, parsePowerlineArgs(command));
      if (!file)
        result.notes.unshift({ kind: 'info', text: t('import.note.defaultLayout', { tool: source }) });
      return { ...result, file };
    }
    default: {
      const unreachable: never = source;
      throw new Error(String(unreachable));
    }
  }
}

export function toConfig(result: ImportResult): Config {
  const lines = (result.config.lines ?? []).map((line) =>
    line.map((item) => {
      const options = canonicalOptions(item.type, item.options);
      return options === item.options ? item : { ...item, options };
    }),
  );
  return normalizeConfig({ ...defaultConfig(), ...result.config, lines });
}
