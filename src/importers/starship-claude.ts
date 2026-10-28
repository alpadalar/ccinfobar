import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { flagValue, isBin } from './args.js';
import { TARGETS as CSHIP_TARGETS, type EnvModule, importCship } from './cship.js';
import type { ImportResult } from './index.js';
import { expand, readToml, shownFile, tableOf } from './io.js';
import type { ImportCtx, ImporterDef } from './registry.js';

const TOOL = 'starship-claude';

const FULL = { style: 'full' };
const env = (uses: EnvModule['uses'], approx = false): EnvModule => (approx ? { uses, approx } : { uses });

// exports of plugin/bin/starship-claude
export const ENV_VARS: Record<string, EnvModule> = {
  CLAUDE_MODEL: env([['model']]),
  CLAUDE_MODEL_NERD: env([['model']]),
  CLAUDE_MODEL_DISPLAY_NAME: env([['model']]),
  CLAUDE_MODEL_ID: env([['model', { showId: true }]]),
  CLAUDE_CONTEXT: env([['context-percentage']]),
  CLAUDE_PERCENT_RAW: env([['context-percentage']]),
  CLAUDE_CURRENT_TOKENS: env([['context-length']]),
  CLAUDE_CONTEXT_SIZE: env([['context-window-size']]),
  CLAUDE_COST: env([['session-cost']]),
  CLAUDE_COST_RAW: env([['session-cost']]),
  CLAUDE_RATE_5H: env([['five-hour-usage'], ['five-hour-reset']]),
  CLAUDE_RATE_5H_RAW: env([['five-hour-usage']]),
  CLAUDE_RATE_5H_RESETS: env([['five-hour-reset']], true),
  CLAUDE_RATE_7D: env([['weekly-usage'], ['weekly-reset']]),
  CLAUDE_RATE_7D_RAW: env([['weekly-usage']]),
  CLAUDE_RATE_7D_RESETS: env([['weekly-reset']], true),
  CLAUDE_VERSION: env([['claude-version']]),
  CLAUDE_OUTPUT_STYLE: env([['output-style']]),
  CLAUDE_SESSION_ID: env([['session-id']]),
  CLAUDE_SUMMARY: env([['session-name']], true),
  CLAUDE_LINES_ADDED: env([['lines-changed']], true),
  CLAUDE_LINES_REMOVED: env([['lines-changed']], true),
  CLAUDE_TOTAL_DURATION_MS: env([['session-duration']]),
  CLAUDE_API_DURATION_MS: env([['api-duration']]),
  CLAUDE_TOTAL_INPUT_TOKENS: env([['tokens-input']]),
  CLAUDE_TOTAL_OUTPUT_TOKENS: env([['tokens-output']]),
  CLAUDE_INPUT_TOKENS: env([['tokens-input']], true),
  CLAUDE_OUTPUT_TOKENS: env([['tokens-output']], true),
  CLAUDE_CACHE_READ: env([['tokens-cached']], true),
  CLAUDE_CACHE_CREATION: env([['tokens-cached']], true),
  CLAUDE_CWD: env([['cwd', FULL]]),
  CLAUDE_WORKSPACE_CURRENT_DIR: env([['cwd', FULL]]),
  CLAUDE_WORKSPACE_PROJECT_DIR: env([['project-dir', FULL]]),
};

export const TARGETS: readonly string[] = [
  ...new Set([...CSHIP_TARGETS, ...Object.values(ENV_VARS).flatMap((m) => m.uses.map((u) => u[0]))]),
];

function envVar(name: string, table: Record<string, unknown> | null): EnvModule | null {
  const v = typeof table?.variable === 'string' ? table.variable : name;
  return Object.hasOwn(ENV_VARS, v) ? ENV_VARS[v]! : null;
}

function paletteOf(root: Record<string, unknown>): Record<string, string> | undefined {
  const all = tableOf(root.palettes);
  const name = root.palette;
  const raw = typeof name === 'string' && all && Object.hasOwn(all, name) ? tableOf(all[name]) : null;
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return out;
}

export function importStarshipClaude(root: Record<string, unknown>): ImportResult {
  const powerline = typeof root.format === 'string' && root.format.includes('');
  const result = importCship(root, {
    source: 'starship-claude',
    tool: TOOL,
    palette: paletteOf(root),
    braces: true,
    envVar,
    moduleStyles: true,
    dropGlyphs: powerline,
  });
  if (powerline) result.config.style = 'powerline';
  return result;
}

const defaultFile = (ctx: ImportCtx) => path.join(ctx.home, '.claude', 'starship.toml');

function named(ctx: ImportCtx): string | null {
  const flag = flagValue(ctx.argv, ['--config']);
  return flag ? path.resolve(ctx.cwd, expand(flag, ctx.home)) : null;
}

const discover = (ctx: ImportCtx): string => named(ctx) ?? defaultFile(ctx);

export const starshipClaudeImporter: ImporterDef = {
  source: 'starship-claude',
  name: TOOL,
  repo: 'martinemde/starship-claude',
  shown: '~/.claude/starship.toml',
  hasDefault: false,
  names: ['starship-claude'],
  tool: isBin('starship-claude'),
  named,
  discover,
  load: (file, ctx) => {
    const f = file ?? defaultFile(ctx);
    const root = tableOf(readToml(f, TOOL, ctx.home)) ?? {};
    if (typeof root.format !== 'string') {
      throw new Error(t('import.noFormat', { tool: TOOL, file: shownFile(f, ctx.home) }));
    }
    return { ...importStarshipClaude(root), file: f };
  },
};
