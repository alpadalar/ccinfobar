import path from 'node:path';
import { type CclineFamily, importCclineFamily } from './ccline-load.js';
import { parseCclineTheme } from './ccometixline.js';
import type { ImporterDef } from './registry.js';

// a -t theme wins over config.toml, so discovery leaves it to load
const family = (fam: CclineFamily): Pick<ImporterDef, 'discover' | 'load'> => ({
  discover: (ctx) =>
    parseCclineTheme(ctx.command) === null ? path.join(ctx.home, '.claude', fam.dir, 'config.toml') : null,
  load: (file, ctx) => importCclineFamily(file ?? undefined, ctx, fam),
});

export const bestClaudeHudImporter: ImporterDef = {
  source: 'best-claude-hud',
  name: 'best-claude-hud',
  repo: 'GaoSSR/best-claude-hud',
  shown: '~/.claude/best-claude-hud/config.toml',
  hasDefault: true,
  detect: [/best-claude-hud/i],
  ...family({ tool: 'best-claude-hud', source: 'best-claude-hud', dir: 'best-claude-hud' }),
};
