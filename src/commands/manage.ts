import '../core/i18n/lazy.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import { applyLanguage } from '../cli/lang.js';
import { stripAnsi, visibleWidth } from '../core/ansi.js';
import { defaultConfig, GLYPH_MODES, type LoadResult, saveConfig } from '../core/config.js';
import { keepLanguage } from '../core/edit.js';
import { resolveGlyphMode } from '../core/glyphs.js';
import { presetText, themeDescription } from '../core/i18n/catalog-text.js';
import { formatDateTime } from '../core/i18n/format.js';
import { languageLocale, type MessageId, t } from '../core/i18n/index.js';
import { categoryText, widgetText } from '../core/i18n/widget-text.js';
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
import { selfCommand } from '../data/update-state.js';
import { fetchUsage, type UsageCache, usageKey } from '../data/usage.js';
import {
  dropTargets,
  type ImportTarget,
  importTargets,
  kindText,
  MAX_TARGET_CHARS,
  sanitizeImport,
  shortTarget,
  visibleTarget,
  wrapLine,
} from '../importers/confirm.js';
import {
  IMPORT_SOURCES,
  type ImportNote,
  type ImportResult,
  type ImportSource,
  importFrom,
  resolveSource,
  toConfig,
} from '../importers/index.js';
import { ALL_WIDGETS, CATEGORIES } from '../widgets/index.js';
import { currentStatusLine } from './install.js';
import { type CliIo, cliIo, type PromptIo, plainOutput, promptIo } from './io.js';
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

export interface ImportFlags {
  allowCommands: boolean;
  yes: boolean;
  dryRun: boolean;
}

const TARGET_INDENT = '      ';

const NO_FLAGS: ImportFlags = { allowCommands: false, yes: false, dryRun: false };

const POSIX_SAFE = /^[\w@%+=:,./][\w@%+=:,./~-]*$/;
// cmd and PowerShell expand these inside double quotes
const WIN_BAD = /["%!`$]/;

// null when the path cannot be pasted safely; on Windows always quoted, for Git Bash and PowerShell
export function shellArg(s: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!s || sanitizeText(s) !== s) return null;
  if (platform === 'win32') return WIN_BAD.test(s) ? null : `"${s}"`;
  return POSIX_SAFE.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export interface Rerun {
  command: string;
  addFile: boolean;
  addCommand: boolean;
}

export interface RerunOpts {
  file?: string | null;
  // the status line command the import read
  command?: string;
  dryRun?: boolean;
  // how to call ccinfobar, when it may not be on PATH
  program?: string;
}

export function rerunCommand(
  source: ImportSource,
  o: RerunOpts,
  platform: NodeJS.Platform = process.platform,
): Rerun {
  // a real import has written the config by then; a dry run needs no --force
  const parts = [o.program ?? 'ccinfobar', 'import', source, '--allow-commands'];
  if (!o.dryRun) parts.push('--force');
  const arg = o.file ? shellArg(o.file, platform) : null;
  if (arg) parts.push('--file', arg);
  // install replaces it before the hint is used
  const command = o.command && !/ccinfobar/i.test(o.command) ? o.command : '';
  const cmd = command ? shellArg(command, platform) : null;
  if (cmd) parts.push('--command', cmd);
  if (o.dryRun) parts.push('--dry-run');
  return { command: sanitizeText(parts.join(' ')), addFile: !!o.file && !arg, addCommand: !!command && !cmd };
}

function rerunId(r: Rerun): MessageId {
  if (r.addFile) return r.addCommand ? 'import.rerunAddBoth' : 'import.rerunAddFile';
  return r.addCommand ? 'import.rerunAddCommand' : 'import.rerun';
}

// D-29: commands and URLs stay only with consent, shown in full
async function confirmTargets(
  result: ImportResult,
  flags: ImportFlags,
  io: PromptIo,
  rerun: Rerun,
): Promise<ImportResult> {
  const targets = importTargets(result.config);
  if (!targets.length) return result;
  const width = Math.max(20, (io.columns ?? 80) - 1);
  const size = (x: ImportTarget) => [...x.target].length;
  const long = (x: ImportTarget) => size(x) > MAX_TARGET_CHARS;
  io.log(t('import.targetsHeader'));
  for (const x of targets) {
    if (long(x) && !flags.allowCommands) {
      io.log(t('import.targetLong', { kind: kindText(x.kind), count: size(x) }));
      continue;
    }
    const line = t('import.target', { kind: kindText(x.kind), target: visibleTarget(x.target) });
    for (const part of wrapLine(line, width, TARGET_INDENT)) io.log(part);
  }
  if (flags.allowCommands) return result;
  const short = targets.filter((x) => !long(x));
  const keep =
    short.length > 0 &&
    !flags.yes &&
    io.tty &&
    (await io.ask(t('import.keepPrompt', { count: short.length }), false));
  const drop = keep ? targets.filter(long) : targets;
  if (!drop.length) return result;
  io.log(t('import.targetsDropped', { count: drop.length }));
  io.log(t(rerunId(rerun), { command: rerun.command }));
  const dropped: ImportNote[] = drop.map((x) => ({
    kind: 'drop',
    text: long(x)
      ? t('import.note.targetTooLong', { kind: kindText(x.kind), count: size(x) })
      : t('import.note.targetDropped', { kind: kindText(x.kind), target: shortTarget(x.target) }),
  }));
  return { ...result, config: dropTargets(result.config, drop), notes: [...result.notes, ...dropped] };
}

const SECTIONS: Array<[ImportNote['kind'], MessageId]> = [
  ['approx', 'import.approxHeader'],
  ['drop', 'import.dropHeader'],
  ['info', 'import.infoHeader'],
];

function importReport(io: PromptIo, result: ImportResult, backup: string | null): void {
  const count = (result.config.lines ?? []).reduce((n, l) => n + l.length, 0);
  const source = result.source;
  io.log(
    result.file
      ? t('cmd.import.doneFile', { count, source, file: sanitizeText(tildify(result.file)) })
      : t('cmd.import.done', { count, source }),
  );
  if (backup) io.log(t('cmd.import.previous', { file: tildify(backup) }));
  for (const [kind, id] of SECTIONS) {
    const notes = result.notes.filter((n) => n.kind === kind);
    if (!notes.length) continue;
    io.log(`  ${t(id)}`);
    for (const n of notes) io.log(`    - ${n.text}`);
  }
}

// a dry run never runs imported commands
function dryRunPreview(config: Config, io: PromptIo): string[] {
  const def = ALL_WIDGETS.find((w) => w.type === 'command');
  const text = def ? widgetText(def, 'sample') : '';
  const lines = config.lines.map((items) =>
    items.map((item) => (item.type === 'command' ? { ...item, type: 'text', options: { text } } : item)),
  );
  const plain = plainOutput(io.tty);
  return renderPreview({ ...config, lines }, 'sample', io.columns ?? 100).map((l) =>
    plain ? stripAnsi(l) : l,
  );
}

export async function runImport(
  source: ImportSource,
  opts: { file?: string | undefined; command: string; flags?: ImportFlags; program?: string },
  cfgFile: string,
  io: PromptIo = promptIo(),
): Promise<boolean> {
  const flags = opts.flags ?? NO_FLAGS;
  try {
    const raw = sanitizeImport(
      importFrom(source, opts.file ? { file: opts.file, command: opts.command } : { command: opts.command }),
    );
    const rerun = rerunCommand(source, {
      file: opts.file ?? raw.file,
      command: opts.command,
      dryRun: flags.dryRun,
      program: opts.program ?? selfCommand(),
    });
    const result = await confirmTargets(raw, flags, io, rerun);
    if (flags.dryRun) {
      importReport(io, result, null);
      io.log(t('import.dryRunHeader'));
      for (const line of dryRunPreview(toConfig(result), io)) io.log(line);
      io.log(t('import.dryRunDone'));
      return true;
    }
    const current = currentConfig(cfgFile);
    const backup = backupConfig(cfgFile);
    saveConfig(keepLanguage(toConfig(result), current), cfgFile, { overwriteBroken: true });
    importReport(io, result, backup);
    return true;
  } catch (err) {
    io.error(t('cmd.import.failed', { error: sanitizeText((err as Error).message) }));
    return false;
  }
}

export async function runImportCommand(
  args: Args,
  cfgFile: string,
  io: PromptIo = promptIo(),
): Promise<void> {
  const source = resolveSource(args.positional[0]);
  if (!source) {
    io.error(t('cmd.import.usage', { sources: IMPORT_SOURCES.join('|') }));
    process.exitCode = 1;
    return;
  }
  const flags: ImportFlags = {
    allowCommands: args.flags['allow-commands'] === true,
    yes: args.flags.yes === true,
    dryRun: args.flags['dry-run'] === true,
  };
  if (!flags.dryRun && fs.existsSync(cfgFile) && !args.flags.force) {
    io.error(t('cmd.import.exists', { file: tildify(cfgFile) }));
    process.exitCode = 1;
    return;
  }
  const file = typeof args.flags.file === 'string' ? path.resolve(args.flags.file) : undefined;
  const command = typeof args.flags.command === 'string' ? args.flags.command : currentCommandSafe();
  const ok = await runImport(source, { file, command, flags }, cfgFile, io);
  if (!ok) process.exitCode = 1;
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
  console.log(t('cmd.init.done', { name: clean(presetText(preset, 'name')), file: tildify(cfgFile) }));
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
  const plain = plainOutput(io.tty, env);
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
      `\n\x1b[1m${clean(th.name)}\x1b[0m  ${clean(th.id)}${mark}  \x1b[2m${clean(th.style)}${origin} · ${clean(themeDescription(th))}\x1b[0m`,
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
    console.log(`\n${categoryText(cat.id, cat.name)}`);
    const pad = Math.max(...list.map((w) => visibleWidth(w.type)));
    for (const w of list) console.log(`  ${padVisible(w.type, pad)}  ${widgetText(w, 'description')}`);
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
