import '../core/i18n/lazy.js';
import { t } from '../core/i18n/index.js';
import { commandArgs } from './args.js';
import { bestClaudeHudImporter, byebyecodeImporter } from './ccline-family.js';
import { claudeCodeStatuslineImporter } from './claude-code-statusline.js';
import { claudebarImporter } from './claudebar.js';
import { corallineImporter } from './coralline.js';
import type { ImportResult, ImportSource } from './index.js';
import { homeOf, isFile, shownFile } from './io.js';
import { pyccslImporter } from './pyccsl.js';
import { starshipClaudeImporter } from './starship-claude.js';
import { statuslineProImporter } from './statusline-pro.js';

export interface ImportCtx {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
}

export interface ImporterInfo {
  source: ImportSource;
  name: string;
  repo: string;
  aliases?: readonly string[];
  // default file for help, null = read from the status line command
  shown: string | null;
}

export interface ImporterDef extends ImporterInfo {
  detect?: readonly RegExp[];
  // file header check for commands that do not name the tool
  sniff?: { file(ctx: ImportCtx): string | null; marker: RegExp };
  hasDefault: boolean;
  discover(ctx: ImportCtx): string | null;
  load(file: string | null, ctx: ImportCtx): ImportResult;
}

export const LEGACY_INFO: readonly ImporterInfo[] = [
  {
    source: 'ccstatusline',
    name: 'ccstatusline',
    repo: 'sirmalloc/ccstatusline',
    aliases: ['ccstatusline-zh'],
    shown: '~/.config/ccstatusline/settings.json',
  },
  {
    source: 'claude-powerline',
    name: 'claude-powerline',
    repo: 'Owloops/claude-powerline',
    shown: '~/.claude/claude-powerline.json',
  },
  {
    source: 'ccometixline',
    name: 'CCometixLine',
    repo: 'Haleclipse/CCometixLine',
    aliases: ['ccline'],
    shown: '~/.claude/ccline/config.toml',
  },
  { source: 'cship', name: 'cship', repo: 'stephenleo/cship', shown: 'cship.toml, starship.toml' },
  {
    source: 'claude-hud',
    name: 'claude-hud',
    repo: 'jarrodwatts/claude-hud',
    shown: '~/.claude/plugins/claude-hud/config.json',
  },
];

// later plans append one row per tool, in IMPORT_SOURCES order
export const REGISTRY: readonly ImporterDef[] = [
  bestClaudeHudImporter,
  byebyecodeImporter,
  claudebarImporter,
  statuslineProImporter,
  claudeCodeStatuslineImporter,
  starshipClaudeImporter,
  pyccslImporter,
  corallineImporter,
];

export function registryDef(source: ImportSource): ImporterDef | null {
  return REGISTRY.find((d) => d.source === source) ?? null;
}

export function importerList(): ImporterInfo[] {
  return [...LEGACY_INFO, ...REGISTRY];
}

export function makeCtx(opts: { command?: string; env?: NodeJS.ProcessEnv; cwd?: string }): ImportCtx {
  const command = opts.command ?? '';
  const env = opts.env ?? process.env;
  return { command, args: commandArgs(command), env, cwd: opts.cwd ?? process.cwd(), home: homeOf(env) };
}

export function loadFromRegistry(
  def: ImporterDef,
  opts: { file?: string; command?: string; env?: NodeJS.ProcessEnv; cwd?: string },
): ImportResult {
  const ctx = makeCtx(opts);
  if (opts.file) return def.load(opts.file, ctx);
  const found = def.discover(ctx);
  if (found && isFile(found)) return def.load(found, ctx);
  if (def.hasDefault) return def.load(null, ctx);
  const file = found ? shownFile(found, ctx.home) : (def.shown ?? t('import.shownCommand'));
  throw new Error(t('import.notFound', { tool: def.name, file }));
}
