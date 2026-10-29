import type { Args } from '../cli/args.js';
import { intFlag } from '../cli/flags.js';
import { applyLanguage } from '../cli/lang.js';
import { type LoadResult, saveConfig } from '../core/config.js';
import { setThemeRotation } from '../core/edit.js';
import { themeDescription } from '../core/i18n/catalog-text.js';
import { formatDateTime } from '../core/i18n/format.js';
import { languageLocale, type MessageId, t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { tildify } from '../core/paths.js';
import { renderPreview } from '../core/preview.js';
import {
  formatWeekdays,
  nextRotationChange,
  parseEvery,
  parseWeekdays,
  withoutRotation,
} from '../core/rotation.js';
import { sanitizeText } from '../core/sanitize.js';
import {
  activeThemeId,
  listThemes,
  resolveTheme,
  saveUserTheme,
  themeExists,
  themesDir,
  themeToInput,
} from '../core/themes.js';
import type { Config, ThemeRotation } from '../core/types.js';

const DEMO_LINE = ['model', 'cwd', 'git-branch', 'context-bar', 'gsd-phase', 'gsd-plans', 'session-cost'].map(
  (type) => ({
    id: type,
    type,
  }),
);

const clean = (v: unknown): string => sanitizeText(String(v ?? ''));

export function runThemes(args: Args, cfgFile: string): void {
  const width = intFlag(args, 'width', 1, 10000) ?? process.stdout.columns ?? 120;
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
    for (const line of renderPreview(withoutRotation(demo), 'sample', width)) console.log(`  ${line}`);
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
  if (args.positional[0] === 'rotate') {
    runThemeRotate(args, cfgFile, loaded.config);
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
    const status = rotationStatus(loaded.config);
    if (status) console.log(status);
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
  if (next.themeRotation) console.log(t('cmd.theme.rotating'));
  const width = process.stdout.columns ?? 120;
  for (const line of renderPreview(withoutRotation(next), 'sample', width)) console.log(line);
}

export function rotationStatus(config: Config, now = new Date()): string | null {
  const rot = config.themeRotation;
  if (!rot) return null;
  const every = rot.every ?? 'day';
  const days = formatWeekdays(rot.weekdays);
  return t('cmd.rotate.status', {
    count: rot.themes?.length ?? 0,
    every:
      typeof every === 'number'
        ? t('cmd.rotate.every.minutes', { n: every })
        : t(`cmd.rotate.every.${every}`),
    order: t(rot.order === 'shuffle' ? 'cmd.rotate.order.shuffle' : 'cmd.rotate.order.cycle'),
    weekdays: days ? t('cmd.rotate.weekdays', { map: clean(days) }) : '',
    name: clean(resolveTheme(activeThemeId(config, now)).name),
    next: formatDateTime(nextRotationChange(rot, now), languageLocale()),
  });
}

function rotateError(id: MessageId, value: string): void {
  console.error(t(id, { value: clean(value) }));
  process.exitCode = 1;
}

function runThemeRotate(args: Args, cfgFile: string, config: Config): void {
  const ids = args.positional.slice(1);
  const f = args.flags;
  if (ids.length === 1 && ids[0] === 'off') {
    if (!config.themeRotation) {
      console.log(t('cmd.rotate.alreadyOff'));
      return;
    }
    saveConfig(setThemeRotation(config, undefined), cfgFile);
    console.log(t('cmd.rotate.off'));
    return;
  }
  const patch =
    ids.length > 0 ||
    f.every !== undefined ||
    f.weekdays !== undefined ||
    f.shuffle === true ||
    f.cycle === true;
  if (!patch) {
    console.log(rotationStatus(config) ?? t('cmd.rotate.none'));
    return;
  }
  const missing = ids.find((id) => !themeExists(id));
  if (missing !== undefined) {
    rotateError('cmd.rotate.unknown', missing);
    return;
  }
  const rot: ThemeRotation = { ...config.themeRotation };
  if (ids.length) rot.themes = ids;
  if (f.every !== undefined) {
    const every = typeof f.every === 'string' ? parseEvery(f.every) : null;
    if (every === null) {
      rotateError('cmd.rotate.badEvery', String(f.every));
      return;
    }
    rot.every = every;
  }
  if (f.shuffle === true) rot.order = 'shuffle';
  else if (f.cycle === true) delete rot.order;
  if (f.weekdays !== undefined) {
    const raw = typeof f.weekdays === 'string' ? f.weekdays : '';
    if (raw.trim().toLowerCase() === 'off') delete rot.weekdays;
    else {
      const parsed = parseWeekdays(raw);
      if (!parsed.ok) {
        rotateError('cmd.rotate.badWeekdays', parsed.bad);
        return;
      }
      const days = Object.values(parsed.map);
      if (!days.length) {
        rotateError('cmd.rotate.badWeekdays', raw);
        return;
      }
      const gone = days.find((id) => !themeExists(id));
      if (gone !== undefined) {
        rotateError('cmd.rotate.unknown', gone);
        return;
      }
      rot.weekdays = parsed.map;
    }
  }
  const next = setThemeRotation(config, rot);
  if (!next.themeRotation) {
    console.error(t('cmd.rotate.empty'));
    process.exitCode = 1;
    return;
  }
  saveConfig(next, cfgFile);
  console.log(t('cmd.rotate.set'));
  console.log(rotationStatus(next));
  const width = process.stdout.columns ?? 120;
  for (const line of renderPreview(next, 'sample', width)) console.log(line);
}
