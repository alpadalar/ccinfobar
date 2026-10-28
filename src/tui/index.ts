import { applyLanguage, envLanguage, reapplyLanguage } from '../cli/lang.js';
import {
  applyInstall,
  globalBinary,
  type InstallPlan,
  planInstall,
  type SubagentPlan,
  setupCommand,
} from '../commands/install.js';
import { backupsDir } from '../commands/settings-file.js';
import { ConfigBrokenError, type LoadResult, saveConfig } from '../core/config.js';
import { upgradeOptions } from '../core/edit.js';
import { t } from '../core/i18n/index.js';
import { availablePresets, loadForUse } from '../core/load.js';
import { sanitizeText } from '../core/sanitize.js';
import { saveUserTheme } from '../core/themes.js';
import { gsdInstalled } from '../data/gsd.js';
import { installKind } from '../data/update-state.js';
import type { Hit } from './hits.js';
import { keyToAction, mouseToAction, parseInput, splitPending } from './keys.js';
import { type Action, type Effect, initialState, reduce, type State, type TuiInstallPlan } from './state.js';
import { themeInputFromConfig } from './themeio.js';
import { renderScreen } from './view.js';

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

export interface TuiOptions {
  configPath: string;
}

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const LEAVE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l';

export function brokenConfigMessage(loaded: Pick<LoadResult, 'issue' | 'path'>): string | null {
  const i = loaded.issue;
  if (!i) return null;
  return t('tui.configBroken', { file: loaded.path, line: i.line, column: i.column, message: i.message });
}

export interface EffectDeps {
  command?: () => string | null;
  settingsFile?: string;
}

function installCommand(deps: EffectDeps): string {
  const command = deps.command ? deps.command() : setupCommand(VERSION).command;
  if (!command) throw new Error(t('tui.msg.installFailed'));
  return command;
}

// planning must not run npm; null: set up after the confirm
function planCommand(deps: EffectDeps): string | null {
  if (deps.command || installKind() !== 'npx' || globalBinary()) return installCommand(deps);
  return null;
}

const commandOf = (sl: InstallPlan['current']): string | null =>
  typeof sl?.command === 'string' ? sl.command : null;

const clean = (v: unknown): string => sanitizeText(typeof v === 'string' ? v : '').replace(/\s+/g, ' ');

function subagentChange(sub: SubagentPlan): string {
  const from =
    sub.current && typeof sub.current === 'object'
      ? (sub.current as { command?: unknown }).command
      : sub.current;
  const params = { command: clean(sub.proposed.command), from: clean(from) };
  if (!sub.changes) return t('install.dry.subagentKeep');
  if (sub.owner === 'none') return t('install.dry.subagentAdd', params);
  if (sub.owner === 'ours') return t('install.dry.subagentRewrite', params);
  return t('install.dry.subagentReplace', params);
}

function tuiPlan(plan: InstallPlan): TuiInstallPlan {
  const sub = plan.subagent;
  return {
    current: commandOf(plan.current),
    proposed: plan.proposed.command,
    needsConfirm: plan.needsConfirm,
    ...(sub
      ? {
          subagent: {
            owner: sub.owner === 'ours' ? 'us' : sub.owner === 'foreign' ? 'other' : null,
            change: subagentChange(sub),
          },
        }
      : {}),
  } as TuiInstallPlan;
}

export function runEffect(state: State, effect: Effect, deps: EffectDeps = {}): Action {
  try {
    if (effect.kind === 'save') {
      saveConfig(upgradeOptions(state.config), state.path);
      return {
        type: 'effectDone',
        ok: true,
        saved: true,
        message: t('tui.msg.saved'),
        thenQuit: effect.thenQuit === true,
      };
    }
    if (effect.kind === 'saveTheme') {
      const file = saveUserTheme(themeInputFromConfig(state.config, effect.id));
      return {
        type: 'effectDone',
        ok: true,
        applyTheme: effect.id,
        message: t('tui.msg.themeSaved', { id: effect.id, file }),
      };
    }
    const file = deps.settingsFile;
    if (effect.kind === 'planInstall') {
      const command = planCommand(deps);
      const plan = tuiPlan(
        planInstall({ file, command: command ?? t('tui.msg.pending'), subagents: effect.subagents }),
      );
      return {
        type: 'installPlanned',
        plan: command === null ? { ...plan, pending: true } : plan,
        ...(effect.subagents === undefined ? {} : { subagents: effect.subagents }),
      };
    }
    saveConfig(upgradeOptions(state.config), state.path);
    const proposed = effect.plan?.proposed;
    const command = proposed && !effect.plan?.pending ? proposed : installCommand(deps);
    const plan = planInstall({ file, command, subagents: effect.subagents });
    if (effect.plan && commandOf(plan.current) !== effect.plan.current)
      return { type: 'effectDone', ok: false, message: t('install.stale', { file: plan.file }) };
    applyInstall(plan, { confirmed: effect.confirmed, adoptLegacy: effect.confirmed });
    return {
      type: 'effectDone',
      ok: true,
      saved: true,
      message: t('tui.installed', { command, dir: backupsDir() }),
    };
  } catch (err) {
    if (err instanceof ConfigBrokenError) {
      const message = brokenConfigMessage({ issue: err.issue, path: err.file }) ?? err.message;
      return { type: 'effectDone', ok: false, message };
    }
    return {
      type: 'effectDone',
      ok: false,
      message: t('tui.msg.failed', { message: (err as Error).message }),
    };
  }
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const gsd = gsdInstalled();
  const loaded = loadForUse(opts.configPath, () => gsd);
  applyLanguage(loaded.issue ? undefined : loaded.config);
  const broken = brokenConfigMessage(loaded);
  if (broken) {
    console.error(broken);
    process.exitCode = 1;
    return;
  }
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    console.error(t('tui.msg.needsTty'));
    process.exitCode = 1;
    return;
  }

  const note = loaded.error
    ? t('tui.msg.readFailed', { error: loaded.error })
    : loaded.exists
      ? ''
      : t('tui.msg.noConfig');
  let state: State = initialState(loaded.config, loaded.path, note, {
    presets: availablePresets(gsd),
    gsd,
    autoLanguage: envLanguage().id,
    brew: installKind() === 'brew',
  });
  let hits: Hit[] = [];
  let prev: string[] = [];
  let size = '';
  let active = false;

  const draw = () => {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    const screen = renderScreen(state, cols, rows);
    hits = screen.hits;
    const key = `${cols}x${rows}`;
    let buf = '';
    if (key !== size) {
      buf += '\x1b[2J';
      prev = [];
      size = key;
    }
    screen.lines.forEach((line, i) => {
      if (prev[i] !== line) buf += `\x1b[${i + 1};1H${line}\x1b[0m\x1b[K`;
    });
    prev = screen.lines;
    if (buf) stdout.write(buf);
  };

  const restore = () => {
    if (!active) return;
    active = false;
    try {
      stdout.write(LEAVE);
      stdin.setRawMode(false);
      stdin.pause();
    } catch {
      return;
    }
  };

  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (code?: number) => {
      if (finished) return;
      finished = true;
      stdin.off('data', onData);
      stdout.off('resize', onResize);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      process.off('uncaughtException', onError);
      process.off('exit', restore);
      restore();
      if (code) process.exitCode = code;
      resolve();
    };

    const dispatch = (action: Action) => {
      const prev = state.config;
      state = reduce(state, action);
      while (state.effect) state = reduce(state, runEffect(state, state.effect));
      reapplyLanguage(prev, state.config);
      if (state.quit) finish();
      else draw();
    };

    let pending = '';
    let pendingTimer: NodeJS.Timeout | undefined;
    function onData(chunk: string) {
      clearTimeout(pendingTimer);
      const [ready, rest] = splitPending(pending + chunk);
      pending = rest;
      if (rest) {
        pendingTimer = setTimeout(() => {
          const flush = pending;
          pending = '';
          handle(flush);
        }, 30);
      }
      handle(ready);
    }
    function handle(data: string) {
      for (const ev of parseInput(data)) {
        if (finished) return;
        const action = ev.type === 'key' ? keyToAction(ev.key, state) : mouseToAction(ev.mouse, state, hits);
        if (action) dispatch(action);
      }
    }
    function onResize() {
      size = '';
      draw();
    }
    function onSignal() {
      finish(130);
    }
    function onError(err: Error) {
      finish(1);
      console.error(err.stack ?? String(err));
    }

    process.on('exit', restore);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    process.on('uncaughtException', onError);
    stdout.on('resize', onResize);
    active = true;
    stdout.write(ENTER);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
    try {
      draw();
    } catch (err) {
      onError(err as Error);
    }
  });
}
