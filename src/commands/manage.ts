import fs from 'node:fs';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import { applyLanguage } from '../cli/lang.js';
import { stripAnsi, visibleWidth } from '../core/ansi.js';
import { defaultConfig, GLYPH_MODES, type LoadResult, saveConfig } from '../core/config.js';
import { keepLanguage } from '../core/edit.js';
import { resolveGlyphMode } from '../core/glyphs.js';
import { formatDateTime } from '../core/i18n/format.js';
import { languageLocale, t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { tildify } from '../core/paths.js';
import { forGsd, listPresets } from '../core/presets.js';
import { type PreviewSource, renderPreview, scenarioFlag, scenarioListLines } from '../core/preview.js';
import { finalizeLine } from '../core/renderer.js';
import { sanitizeText } from '../core/sanitize.js';
import { listThemes, resolveTheme, saveUserTheme, themesDir, themeToInput } from '../core/themes.js';
import type { Config } from '../core/types.js';
import { padVisible } from '../core/width.js';
import { gsdInstalled } from '../data/gsd.js';
import { executeJob, type Job, jobOff } from '../data/jobs/runner.js';
import { fetchUsage, type UsageCache, usageKey } from '../data/usage.js';
import { type ImportSource, importFrom, toConfig } from '../importers/index.js';
import { ALL_WIDGETS, CATEGORIES } from '../widgets/index.js';
import { currentStatusLine } from './install.js';
import { type CliIo, cliIo } from './io.js';
import { usageErrorText } from './usage-error.js';

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

const clean = (v: unknown): string => sanitizeText(String(v ?? ''));

// the config being replaced, so its language carries over
function currentConfig(cfgFile: string): Config {
  const loaded = loadForUse(cfgFile);
  return loaded.issue || loaded.error ? defaultConfig() : loaded.config;
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
    const current = currentConfig(cfgFile);
    const backup = backupConfig(cfgFile);
    saveConfig(keepLanguage(toConfig(result), current), cfgFile, { overwriteBroken: true });
    const count = (result.config.lines ?? []).reduce((n, l) => n + l.length, 0);
    console.log(
      result.file
        ? t('cmd.import.doneFile', { count, source, file: tildify(result.file) })
        : t('cmd.import.done', { count, source }),
    );
    if (backup) console.log(t('cmd.import.previous', { file: tildify(backup) }));
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    return true;
  } catch (err) {
    console.error(t('cmd.import.failed', { error: (err as Error).message }));
    return false;
  }
}

export function runImportCommand(args: Args, cfgFile: string): void {
  const source = args.positional[0];
  if (source !== 'ccstatusline' && source !== 'claude-powerline') {
    console.error(t('cmd.import.usage'));
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(cfgFile) && !args.flags.force) {
    console.error(t('cmd.import.exists', { file: tildify(cfgFile) }));
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
    const ids = listPresets()
      .map((p) => p.id)
      .join(', ');
    console.error(t('cmd.init.unknownPreset', { id: clean(id), ids }));
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(cfgFile) && !args.flags.force) {
    console.error(t('cmd.init.exists', { file: tildify(cfgFile) }));
    process.exitCode = 1;
    return;
  }
  const keepGsd = id === 'gsd' || preset.source === 'user';
  const current = currentConfig(cfgFile);
  const backup = backupConfig(cfgFile);
  const built = keepGsd ? preset.build() : forGsd(preset.build(), gsdInstalled());
  saveConfig(keepLanguage(built, current), cfgFile, { overwriteBroken: true });
  console.log(t('cmd.init.done', { name: clean(preset.name), file: tildify(cfgFile) }));
  if (backup) console.log(t('cmd.init.previous', { file: tildify(backup) }));
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
  const gm = args.flags['glyph-mode'];
  const glyphMode = GLYPH_MODES.find((m) => m === gm);
  if (gm !== undefined && gm !== false && !glyphMode) {
    io.error(t('preview.badGlyphMode', { mode: sanitizeText(typeof gm === 'string' ? gm : '') }));
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
  const loaded = loadForUse(cfgFile);
  if (!loaded.issue) applyLanguage(loaded.config);
  const config = glyphMode ? { ...loaded.config, glyphMode } : loaded.config;
  const pasteSafe = resolveGlyphMode(config, env) === 'paste-safe';
  for (const raw of renderPreview(config, source, width)) {
    const line = pasteSafe ? finalizeLine(raw, { pasteSafe }) : raw;
    io.log(plain ? stripAnsi(line) : line);
  }
}

export function runThemes(args: Args, cfgFile: string): void {
  const width =
    typeof args.flags.width === 'string' ? Number(args.flags.width) : (process.stdout.columns ?? 120);
  const loaded = loadForUse(cfgFile);
  if (!loaded.issue) applyLanguage(loaded.config);
  const current = loaded.config;
  if (args.flags.list === true) {
    for (const th of listThemes()) {
      const mark = th.id === current.theme ? `  ${t('cmd.themes.current')}` : '';
      console.log(`${clean(th.id)}  ${clean(th.name)}${mark}`);
    }
    return;
  }
  for (const th of listThemes()) {
    const mark = th.id === current.theme ? ` ${t('cmd.themes.current')}` : '';
    const origin = th.source === 'user' ? ` · ${t('cmd.themes.yours')}` : '';
    console.log(
      `\n\x1b[1m${clean(th.name)}\x1b[0m  ${clean(th.id)}${mark}  \x1b[2m${clean(th.style)}${origin} · ${clean(th.description)}\x1b[0m`,
    );
    const demo = {
      ...current,
      theme: th.id,
      style: undefined,
      separator: undefined,
      separatorColor: undefined,
      padding: undefined,
      glyphs: undefined,
      lines: [DEMO_LINE],
    };
    for (const line of renderPreview(demo, 'sample', width)) console.log(`  ${line}`);
  }
  console.log(t('cmd.themes.footer', { dir: tildify(themesDir()) }));
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
  applyLanguage(loaded.config);
  if (args.positional[0] === 'new' || args.positional[0] === 'create') {
    const id = args.positional[1];
    if (!id) {
      console.error(t('cmd.theme.usage'));
      process.exitCode = 1;
      return;
    }
    const from = typeof args.flags.from === 'string' ? args.flags.from : loaded.config.theme;
    const base = resolveTheme(from);
    const file = saveUserTheme(themeToInput(base, id, base.id === id ? undefined : base.id));
    console.log(t('cmd.theme.created', { file: tildify(file), name: clean(base.name) }));
    console.log(t('cmd.theme.editHint', { id: clean(id) }));
    return;
  }
  const id = args.positional[0];
  if (!id) {
    const th = resolveTheme(loaded.config.theme);
    console.log(
      t('cmd.theme.current', {
        name: clean(th.name),
        id: clean(th.id),
        style: clean(loaded.config.style ?? th.style),
      }),
    );
    console.log(t('cmd.theme.listHint'));
    return;
  }
  const known = listThemes().find((th) => th.id === id);
  if (!known) {
    console.error(t('cmd.theme.unknown', { id: clean(id) }));
    process.exitCode = 1;
    return;
  }
  const next = { ...loaded.config, theme: id };
  for (const k of ['style', 'separator', 'separatorColor', 'padding', 'glyphs'] as const) delete next[k];
  saveConfig(next, cfgFile);
  console.log(t('cmd.theme.set', { name: clean(known.name) }));
  const width = process.stdout.columns ?? 120;
  for (const line of renderPreview(next, 'sample', width)) console.log(line);
}

export function runWidgets(_args: Args, _cfgFile: string): void {
  for (const cat of CATEGORIES) {
    const list = ALL_WIDGETS.filter((w) => !w.hidden && w.category === cat.id);
    if (!list.length) continue;
    console.log(`\n${cat.name}`);
    const pad = Math.max(...list.map((w) => visibleWidth(w.type)));
    for (const w of list) console.log(`  ${padVisible(w.type, pad)}  ${w.description}`);
  }
}

export async function runUsage(args: Args, cfgFile: string, jobs: Job<unknown>[]): Promise<void> {
  const loaded = loadForUse(cfgFile);
  if (!loaded.issue) applyLanguage(loaded.config);
  if (args.flags.background) {
    const key = usageKey();
    const job = jobs.find((j) => j.keyRe.test(key));
    if (!job || jobOff(job.network)) return;
    await executeJob(
      job,
      { key },
      {
        env: process.env,
        config: loaded.config,
        cwd: process.cwd(),
        prev: job.readPrev?.(key, process.env) ?? null,
        fetch,
        now: Date.now(),
      },
    );
    return;
  }
  if (!usageLines(await fetchUsage(), (l) => console.log(l))) process.exitCode = 1;
}

type Window = { used_percentage?: number | null; resets_at?: number | string | null };

// false when there are no limits to show
export function usageLines(cache: UsageCache, log: (line: string) => void): boolean {
  if (cache.error) log(`✗ ${usageErrorText(cache.error)}`);
  const r = cache.rate_limits;
  if (!r) return false;
  const row = (name: string, w: Window) => {
    const pct = w.used_percentage ?? '?';
    log(
      w.resets_at
        ? t('cmd.usage.windowResets', {
            name,
            pct,
            when: formatDateTime(new Date(w.resets_at), languageLocale()),
          })
        : t('cmd.usage.window', { name, pct }),
    );
  };
  if (r.five_hour) row(t('cmd.usage.fiveHour'), r.five_hour);
  if (r.seven_day) row(t('cmd.usage.weekly'), r.seven_day);
  for (const m of r.seven_day_models ?? []) row(t('cmd.usage.weeklyModel', { model: clean(m.model) }), m);
  if (r.spend_limit)
    log(
      t('cmd.usage.extra', {
        used: `$${r.spend_limit.used_usd}`,
        limit: `$${r.spend_limit.limit_usd ?? '?'}`,
      }),
    );
  return true;
}
