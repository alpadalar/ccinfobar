import path from 'node:path';
import { isBin } from './args.js';
import { type CclineFamily, importCclineFamily } from './ccline-load.js';
import { parseCclineTheme } from './ccometixline.js';
import type { ImporterDef } from './registry.js';

// a -t theme wins over config.toml, so discovery leaves it to load
const family = (fam: CclineFamily): Pick<ImporterDef, 'discover' | 'load'> => ({
  discover: (ctx) =>
    parseCclineTheme(ctx.command, fam.bin) === null
      ? path.join(ctx.home, '.claude', fam.dir, 'config.toml')
      : null,
  load: (file, ctx) => importCclineFamily(file ?? undefined, ctx, fam),
});

export const bestClaudeHudImporter: ImporterDef = {
  source: 'best-claude-hud',
  name: 'best-claude-hud',
  repo: 'GaoSSR/best-claude-hud',
  shown: '~/.claude/best-claude-hud/config.toml',
  hasDefault: true,
  detect: [/best-claude-hud/i],
  tool: isBin('best-claude-hud'),
  ...family({
    tool: 'best-claude-hud',
    source: 'best-claude-hud',
    dir: 'best-claude-hud',
    bin: isBin('best-claude-hud'),
  }),
};

export const byebyecodeImporter: ImporterDef = {
  source: 'byebyecode',
  name: 'byebyecode',
  repo: 'byebye-code/byebyecode',
  shown: '~/.claude/byebyecode/config.toml',
  hasDefault: true,
  detect: [/byebyecode/i],
  tool: isBin('byebyecode'),
  ...family({
    tool: 'byebyecode',
    source: 'byebyecode',
    dir: 'byebyecode',
    lineBreak: true,
    bin: isBin('byebyecode'),
  }),
};
