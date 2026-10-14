import fs from 'node:fs';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import { stripAnsi, visibleWidth } from '../core/ansi.js';
import { type LoadResult, saveConfig } from '../core/config.js';
import { t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { tildify } from '../core/paths.js';
import { forGsd, listPresets } from '../core/presets.js';
import { type PreviewSource, renderPreview, scenarioFlag, scenarioListLines } from '../core/preview.js';
import { sanitizeText } from '../core/sanitize.js';
import { listThemes, resolveTheme, saveUserTheme, themesDir, themeToInput } from '../core/themes.js';
import { gsdInstalled } from '../data/gsd.js';
import { fetchUsage } from '../data/usage.js';
import { type ImportSource, importFrom, toConfig } from '../importers/index.js';
import { ALL_WIDGETS, CATEGORIES } from '../widgets/index.js';
import { currentStatusLine } from './install.js';
import { type CliIo, cliIo } from './io.js';

const DEMO_LINE = ['model', 'cwd', 'git-branch', 'context-bar', 'gsd-phase', 'gsd-plans', 'session-cost'].map(
  (type) => ({
    id: type,
    type,
  }),
);

export function currentCommandSafe(): string {
  try {
    return currentStatusLine()?.command ?? '';
  } catch {
    return '';
  }
}

export function backupConfig(cfgFile: string): string | null {
  if (!fs.existsSync(cfgFile)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${cfgFile}.${stamp}.bak`;
  fs.copyFileSync(cfgFile, backup);
  try {
    fs.chmodSync(backup, 0o600);
  } catch {}
  return backup;
}

export function runImport(
  source: ImportSource,
  opts: { file?: string | undefined; command: string },
  cfgFile: string,
): boolean {
  try {
    const result = importFrom(
      source,
      opts.file ? { file: opts.file, command: opts.command } : { command: opts.command },
    );
    const backup = backupConfig(cfgFile);
    saveConfig(toConfig(result), cfgFile, { overwriteBroken: true });
    const count = (result.config.lines ?? []).reduce((n, l) => n + l.length, 0);
    console.log(
      `✓ Imported ${count} widgets from ${source}${result.file ? ` (${tildify(result.file)})` : ''}`,
    );
    if (backup) console.log(`  Previous ccinfobar config: ${tildify(backup)}`);
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    return true;
  } catch (err) {
    console.error(`✗ Import failed: ${(err as Error).message}`);
    return false;
  }
}

export function runImportCommand(args: Args, cfgFile: string): void {
  const source = args.positional[0];
  if (source !== 'ccstatusline' && source !== 'claude-powerline') {
    console.error('Usage: ccinfobar import <ccstatusline|claude-powerline> [--file <path>] [--force]');
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(cfgFile) && !args.flags.force) {
    console.error(`${tildify(cfgFile)} already exists. Use --force to replace it (a backup is kept).`);
    process.exitCode = 1;
    return;
  }
  const file = typeof args.flags.file === 'string' ? path.resolve(args.flags.file) : undefined;
  runImport(source, { file, command: currentCommandSafe() }, cfgFile);
}

export function runInit(args: Args, cfgFile: string): void {
  const id = args.positional[0] ?? 'default';
  const preset = listPresets().find((p) => p.id === id);
  if (!preset) {
    console.error(
      `Unknown preset "${id}". Available: ${listPresets()
        .map((p) => p.id)
        .join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(cfgFile) && !args.flags.force) {
    console.error(`${tildify(cfgFile)} already exists. Use --force to overwrite.`);
    process.exitCode = 1;
    return;
  }
  const keepGsd = id === 'gsd' || preset.source === 'user';
  const backup = backupConfig(cfgFile);
  saveConfig(keepGsd ? preset.build() : forGsd(preset.build(), gsdInstalled()), cfgFile, {
    overwriteBroken: true,
  });
  console.log(`✓ Wrote "${preset.name}" preset to ${tildify(cfgFile)}`);
  if (backup) console.log(`  Previous config: ${tildify(backup)}`);
}

export function runPreview(args: Args, cfgFile: string, io: CliIo = cliIo()): void {
  const flag = scenarioFlag(args.flags.scenario);
  if (flag.kind === 'list') {
    for (const line of scenarioListLines()) io.log(line);
    return;
  }
  if (flag.kind === 'unknown') {
    io.error(t('preview.unknownScenario', { name: sanitizeText(flag.name) }));
    for (const line of scenarioListLines().slice(1)) io.error(line);
    process.exitCode = 1;
    return;
  }
  if (flag.kind === 'scenario' && args.flags.last) {
    io.error(t('preview.scenarioWithLast'));
    process.exitCode = 1;
    return;
  }
  const width =
    typeof args.flags.width === 'string' ? Number(args.flags.width) : (process.stdout.columns ?? 120);
  const source: PreviewSource =
    flag.kind === 'scenario' ? { scenario: flag.id } : args.flags.last ? 'last' : 'sample';
  const env = process.env;
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0';
  const plain = (!io.tty && !forced) || !!env.NO_COLOR || env.FORCE_COLOR === '0';
  for (const line of renderPreview(loadForUse(cfgFile).config, source, width)) {
    io.log(plain ? stripAnsi(line) : line);
  }
}

const clean = (v: unknown): string => sanitizeText(String(v ?? ''));

export function runThemes(args: Args, cfgFile: string): void {
  const width =
    typeof args.flags.width === 'string' ? Number(args.flags.width) : (process.stdout.columns ?? 120);
  const current = loadForUse(cfgFile).config;
  if (args.flags.list === true) {
    for (const t of listThemes()) {
      console.log(`${clean(t.id)}  ${clean(t.name)}${t.id === current.theme ? '  (current)' : ''}`);
    }
    return;
  }
  for (const t of listThemes()) {
    const mark = t.id === current.theme ? ' (current)' : '';
    const origin = t.source === 'user' ? ' · yours' : '';
    console.log(
      `\n\x1b[1m${clean(t.name)}\x1b[0m  ${clean(t.id)}${mark}  \x1b[2m${clean(t.style)}${origin} · ${clean(t.description)}\x1b[0m`,
    );
    const demo = {
      ...current,
      theme: t.id,
      style: undefined,
      separator: undefined,
      separatorColor: undefined,
      padding: undefined,
      glyphs: undefined,
      lines: [DEMO_LINE],
    };
    for (const line of renderPreview(demo, 'sample', width)) console.log(`  ${line}`);
  }
  console.log(`\nSwitch with \`ccinfobar theme <id>\`. Your themes live in ${tildify(themesDir())}`);
}

export function reportIssue(loaded: LoadResult): boolean {
  if (!loaded.issue) return false;
  const { line, column, message } = loaded.issue;
  console.error(t('config.issue', { file: tildify(loaded.path), line, column, message }));
  process.exitCode = 1;
  return true;
}

export function runTheme(args: Args, cfgFile: string): void {
  const loaded = loadForUse(cfgFile);
  if (reportIssue(loaded)) return;
  if (args.positional[0] === 'new' || args.positional[0] === 'create') {
    const id = args.positional[1];
    if (!id) {
      console.error('Usage: ccinfobar theme new <id> [--from <theme>]');
      process.exitCode = 1;
      return;
    }
    const from = typeof args.flags.from === 'string' ? args.flags.from : loaded.config.theme;
    const base = resolveTheme(from);
    const file = saveUserTheme(themeToInput(base, id, base.id === id ? undefined : base.id));
    console.log(`✓ Created ${tildify(file)} from "${base.name}"`);
    console.log(`  Edit it, then run \`ccinfobar theme ${id}\`.`);
    return;
  }
  const id = args.positional[0];
  if (!id) {
    const t = resolveTheme(loaded.config.theme);
    console.log(`${t.name} (${t.id}), style ${loaded.config.style ?? t.style}`);
    console.log('Run `ccinfobar themes` to see all themes.');
    return;
  }
  const known = listThemes().find((t) => t.id === id);
  if (!known) {
    console.error(`Unknown theme "${id}". Run \`ccinfobar themes\` to list them.`);
    process.exitCode = 1;
    return;
  }
  const next = { ...loaded.config, theme: id };
  for (const k of ['style', 'separator', 'separatorColor', 'padding', 'glyphs'] as const) delete next[k];
  saveConfig(next, cfgFile);
  console.log(`✓ Theme set to ${known.name}`);
  const width = process.stdout.columns ?? 120;
  for (const line of renderPreview(next, 'sample', width)) console.log(line);
}

export function runWidgets(_args: Args, _cfgFile: string): void {
  for (const cat of CATEGORIES) {
    const list = ALL_WIDGETS.filter((w) => !w.hidden && w.category === cat.id);
    if (!list.length) continue;
    console.log(`\n${cat.name}`);
    const pad = Math.max(...list.map((w) => visibleWidth(w.type)));
    for (const w of list) console.log(`  ${w.type.padEnd(pad)}  ${w.description}`);
  }
}

export async function runUsage(args: Args, _cfgFile: string): Promise<void> {
  const cache = await fetchUsage();
  if (args.flags.background) return;
  if (cache.error) console.log(`✗ ${clean(cache.error)}`);
  const r = cache.rate_limits;
  if (!r) {
    process.exitCode = 1;
    return;
  }
  const at = (w?: { resets_at?: number | string | null }) =>
    w?.resets_at ? `, resets ${new Date(w.resets_at).toLocaleString()}` : '';
  if (r.five_hour) console.log(`  5-hour: ${r.five_hour.used_percentage ?? '?'}%${at(r.five_hour)}`);
  if (r.seven_day) console.log(`  weekly: ${r.seven_day.used_percentage ?? '?'}%${at(r.seven_day)}`);
  for (const m of r.seven_day_models ?? []) {
    console.log(`  weekly ${clean(m.model)}: ${m.used_percentage ?? '?'}%${at(m)}`);
  }
  if (r.spend_limit)
    console.log(`  extra usage: $${r.spend_limit.used_usd} of $${r.spend_limit.limit_usd ?? '?'}`);
}
