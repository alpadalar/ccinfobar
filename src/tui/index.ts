import { applyInstall, type InstallPlan, planInstall, setupCommand } from '../commands/install.js';
import { backupsDir } from '../commands/settings-file.js';
import { ConfigBrokenError, type LoadResult, saveConfig } from '../core/config.js';
import { t } from '../core/i18n/index.js';
import { availablePresets, loadForUse } from '../core/load.js';
import { saveUserTheme } from '../core/themes.js';
import { gsdInstalled } from '../data/gsd.js';
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
  if (!command) throw new Error('could not install ccinfobar; run npm install -g ccinfobar');
  return command;
}

const commandOf = (sl: InstallPlan['current']): string | null =>
  typeof sl?.command === 'string' ? sl.command : null;

function tuiPlan(plan: InstallPlan): TuiInstallPlan {
  return {
    current: commandOf(plan.current),
    proposed: plan.proposed.command,
    needsConfirm: plan.needsConfirm,
  };
}

export function runEffect(state: State, effect: Effect, deps: EffectDeps = {}): Action {
  try {
    if (effect.kind === 'save') {
      saveConfig(state.config, state.path);
      return {
        type: 'effectDone',
        ok: true,
        saved: true,
        message: 'Saved',
        thenQuit: effect.thenQuit === true,
      };
    }
    if (effect.kind === 'saveTheme') {
      const file = saveUserTheme(themeInputFromConfig(state.config, effect.id));
      return {
        type: 'effectDone',
        ok: true,
        applyTheme: effect.id,
        message: `Saved theme ${effect.id} (${file})`,
      };
    }
    const file = deps.settingsFile;
    if (effect.kind === 'planInstall') {
      return { type: 'installPlanned', plan: tuiPlan(planInstall({ file, command: installCommand(deps) })) };
    }
    saveConfig(state.config, state.path);
    const command = effect.plan?.proposed ?? installCommand(deps);
    const plan = planInstall({ file, command });
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
    return { type: 'effectDone', ok: false, message: `Failed: ${(err as Error).message}` };
  }
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const gsd = gsdInstalled();
  const loaded = loadForUse(opts.configPath, () => gsd);
  const broken = brokenConfigMessage(loaded);
  if (broken) {
    console.error(broken);
    process.exitCode = 1;
    return;
  }
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    console.error(
      'ccinfobar tui needs an interactive terminal. Use `ccinfobar edit` for the browser editor.',
    );
    process.exitCode = 1;
    return;
  }

  const note = loaded.error
    ? `Could not read config (${loaded.error}); starting from defaults`
    : loaded.exists
      ? ''
      : 'No config yet. Press s to create it.';
  let state: State = initialState(loaded.config, loaded.path, note, {
    presets: availablePresets(gsd),
    gsd,
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
      state = reduce(state, action);
      while (state.effect) state = reduce(state, runEffect(state, state.effect));
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
