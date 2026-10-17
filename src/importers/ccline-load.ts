import '../core/i18n/lazy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import { firstPathToken } from './args.js';
import { CCLINE_DEFAULT, importCcometixline, parseCclineTheme } from './ccometixline.js';
import { CCLINE_THEMES, type CclineTheme } from './ccometixline-themes.js';
import type { ImportNote, ImportResult, ImportSource } from './index.js';
import { isFile, isPlainFile, readToml, safeThemeName, shownFile } from './io.js';
import type { ImportCtx } from './registry.js';

export interface CclineFamily {
  tool: string;
  source: ImportSource;
  // folder under ~/.claude
  dir: string;
}

export const CCOMETIXLINE: CclineFamily = { tool: 'CCometixLine', source: 'ccometixline', dir: 'ccline' };

export function ccometixlinePaths(
  command: string,
  home = os.homedir(),
  dir = 'ccline',
): { file: string | null; note: 'command-dir' | null } {
  const homeFile = path.join(home, '.claude', dir, 'config.toml');
  if (fs.existsSync(homeFile)) return { file: homeFile, note: null };
  const bin = firstPathToken(command, home);
  if (bin) {
    const dirs = [path.dirname(bin)];
    for (let d = path.dirname(bin); path.dirname(d) !== d; d = path.dirname(d)) {
      if (path.basename(d) === dir && d !== dirs[0]) dirs.push(d);
    }
    for (const d of dirs) {
      const file = path.join(d, 'config.toml');
      if (isPlainFile(file)) return { file, note: 'command-dir' };
    }
  }
  return { file: null, note: null };
}

function mapToml(raw: unknown, fam: CclineFamily, defaulted = false): ImportResult {
  return importCcometixline(raw, { defaulted, tool: fam.tool, source: fam.source });
}

function importTheme(name: string, home: string, fam: CclineFamily): ImportResult | ImportNote {
  const tool = fam.tool;
  const shown = sanitizeText(name);
  if (!safeThemeName(name))
    return { kind: 'info', text: t('import.note.themeUnsafe', { tool, name: shown }) };
  const file = path.join(home, '.claude', fam.dir, 'themes', `${name}.toml`);
  if (isFile(file)) {
    const result = mapToml(readToml(file, tool), fam);
    const text = t('import.note.themeFile', { tool, name: shown, file: shownFile(file, home) });
    result.notes.unshift({ kind: 'info', text });
    return { ...result, file };
  }
  const builtin = Object.hasOwn(CCLINE_THEMES, name);
  const result = mapToml(CCLINE_THEMES[(builtin ? name : 'default') as CclineTheme], fam);
  const id = builtin ? 'import.note.themeBuiltin' : 'import.note.themeUnknown';
  result.notes.unshift({ kind: 'info', text: t(id, { tool, name: shown }) });
  return { ...result, file: null };
}

// CCometixLine and its forks share config, themes and -t
export function importCclineFamily(
  file: string | undefined,
  ctx: Pick<ImportCtx, 'command' | 'home'>,
  fam: CclineFamily,
): ImportResult {
  const { command, home } = ctx;
  const theme = file ? null : parseCclineTheme(command);
  const themed = theme === null ? null : importTheme(theme, home, fam);
  if (themed && 'config' in themed) return themed;
  const found = file ? { file, note: null } : ccometixlinePaths(command, home, fam.dir);
  const result = found.file
    ? mapToml(readToml(found.file, fam.tool), fam)
    : mapToml(CCLINE_DEFAULT, fam, true);
  if (found.note === 'command-dir' && found.file) {
    result.notes.unshift({
      kind: 'info',
      text: t('import.note.commandDir', { tool: fam.tool, file: shownFile(found.file, home) }),
    });
  }
  if (themed) result.notes.unshift(themed);
  return { ...result, file: found.file };
}
