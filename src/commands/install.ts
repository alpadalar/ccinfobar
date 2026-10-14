import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { claudeDir, claudeSettingsPath } from '../core/paths.js';
import { type BuiltCommand, buildCommand, type CommandTarget } from './command.js';
import { deleteSettingsFile, patchSettings, readSettings } from './settings-file.js';
import { type InstallKind, installKind, installVersion, localPrefix, npmCommand } from './update.js';

export interface StatusLineSetting {
  type: 'command';
  command: string;
  padding?: number;
  refreshInterval?: number;
}

// npx puts its cache on PATH; that is not an install
export function isTransientBin(p: string): boolean {
  return /[\\/](_npx|node_modules[\\/]\.bin)[\\/]/.test(p);
}

export function globalBinary(): string | null {
  try {
    const win = process.platform === 'win32';
    const out = execFileSync(win ? 'where' : 'which', win ? ['ccinfobar'] : ['-a', 'ccinfobar'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
    });
    const hit = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !isTransientBin(l));
    return hit ?? null;
  } catch {
    return null;
  }
}

export function localBin(env: NodeJS.ProcessEnv = process.env): string {
  const bin = path.join(localPrefix(env), 'node_modules', '.bin');
  return path.join(bin, process.platform === 'win32' ? 'ccinfobar.cmd' : 'ccinfobar');
}

export function acceptCommand(built: BuiltCommand, log: (line: string) => void = () => {}): string | null {
  if (built.ok) return built.command;
  log(t('install.unsafePath', { path: built.path, chars: built.chars }));
  return null;
}

// never npx@latest: it runs whatever npm serves
function defaultTarget(kind: InstallKind): CommandTarget | null {
  const bin = globalBinary();
  if (bin) return { kind: 'bin', bin, onPath: true };
  if (fs.existsSync(localBin())) return { kind: 'bin', bin: localBin(), onPath: false };
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (kind !== 'npx' && entry && fs.existsSync(entry)) return { kind: 'script', script: entry };
  return null;
}

export function defaultCommand(
  kind: InstallKind = installKind(),
  log?: (line: string) => void,
): string | null {
  const target = defaultTarget(kind);
  return target ? acceptCommand(buildCommand(target), log) : null;
}

export function currentStatusLine(file = claudeSettingsPath()): StatusLineSetting | null {
  const sl = readSettings(file).data.statusLine;
  return sl && typeof sl === 'object' ? (sl as StatusLineSetting) : null;
}

export function install(
  command: string,
  refreshInterval?: number,
  file = claudeSettingsPath(),
): string | null {
  const res = patchSettings(file, (settings) => {
    const statusLine: StatusLineSetting = { type: 'command', command, padding: 0 };
    const prev = settings.statusLine as StatusLineSetting | undefined;
    const refresh =
      refreshInterval ?? (prev?.command?.includes('ccinfobar') ? prev.refreshInterval : undefined);
    if (refresh && refresh > 0) statusLine.refreshInterval = Math.floor(refresh);
    settings.statusLine = statusLine;
  });
  return res.backup;
}

export type UninstallResult = { removed: false } | { removed: true; restored: StatusLineSetting | null };

export function uninstall(file = claudeSettingsPath()): UninstallResult {
  const settings = readSettings(file).data;
  const sl = settings.statusLine as StatusLineSetting | undefined;
  if (!sl || typeof sl.command !== 'string' || !sl.command.includes('ccinfobar')) return { removed: false };
  const legacy = `${file}.ccinfobar-backup`;
  let previous: StatusLineSetting | null = null;
  try {
    const backup = readSettings(legacy).data.statusLine as StatusLineSetting | undefined;
    if (backup && typeof backup.command === 'string' && !backup.command.includes('ccinfobar'))
      previous = backup;
  } catch {}
  const { statusLine: _, ...rest } = settings;
  if (!previous && !fs.existsSync(legacy) && Object.keys(rest).length === 0) deleteSettingsFile(file);
  else
    patchSettings(file, (d) => {
      if (previous) d.statusLine = previous;
      else delete d.statusLine;
    });
  return { removed: true, restored: previous };
}

export function projectSettingsPath(dir: string, local = true): string {
  return path.join(dir, '.claude', local ? 'settings.local.json' : 'settings.json');
}

function projectRoots(dir: string): string[] {
  const roots = [path.resolve(dir)];
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 2000,
    }).trim();
    if (top && !roots.includes(path.resolve(top))) roots.push(path.resolve(top));
  } catch {}
  return roots;
}

export function projectLocalFile(dir: string): string {
  for (const root of projectRoots(dir)) {
    const file = projectSettingsPath(root);
    try {
      if (currentStatusLine(file)?.command?.includes('ccinfobar')) return file;
    } catch {}
  }
  return projectSettingsPath(dir);
}

export interface ProjectOverride {
  file: string;
  command: string;
}

// project settings beat ~/.claude/settings.json
export function projectOverride(dir: string): ProjectOverride | null {
  for (const root of projectRoots(dir)) {
    for (const file of [projectSettingsPath(root, true), projectSettingsPath(root, false)]) {
      let sl: StatusLineSetting | null = null;
      try {
        sl = currentStatusLine(file);
      } catch {}
      if (!sl || typeof sl.command !== 'string') continue;
      return sl.command.includes('ccinfobar') ? null : { file, command: sl.command };
    }
  }
  return null;
}

// keep settings.local.json out of git
export function ignoreLocally(file: string): boolean {
  const dir = path.dirname(file);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 2000,
    }).trim();
  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    return false;
  }
  try {
    git(['check-ignore', '-q', file]);
    return false;
  } catch {}
  try {
    const top = git(['rev-parse', '--show-toplevel']);
    const exclude = path.resolve(dir, git(['rev-parse', '--git-path', 'info/exclude']));
    const rel = `/${path.relative(top, file).split(path.sep).join('/')}`;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const prev = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    fs.appendFileSync(exclude, `${prev && !prev.endsWith('\n') ? '\n' : ''}${rel}\n`);
    return true;
  } catch {
    return false;
  }
}

export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

export function knownProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const projects = (readSettings(claudeJsonPath(env)).data.projects ?? {}) as Record<string, unknown>;
    const own = path.resolve(claudeDir(env));
    return Object.keys(projects).filter((p) => path.resolve(p, '.claude') !== own);
  } catch {
    return [];
  }
}

function ownStatusLine(file: string): string | null {
  try {
    const cmd = currentStatusLine(file)?.command;
    return typeof cmd === 'string' ? cmd : null;
  } catch {
    return null;
  }
}

// GSD's per-project status line
export function gsdProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  return knownProjects(env).filter((root) => {
    const local = ownStatusLine(projectSettingsPath(root));
    if (local !== null) return /gsd-statusline/.test(local);
    return /gsd-statusline/.test(ownStatusLine(projectSettingsPath(root, false)) ?? '');
  });
}

export function takeOverProjects(
  command: string,
  refreshInterval?: number,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const done: string[] = [];
  for (const root of gsdProjects(env)) {
    try {
      const file = projectSettingsPath(root);
      install(command, refreshInterval, file);
      ignoreLocally(file);
      done.push(root);
    } catch {}
  }
  return done;
}

export function releaseProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  const done: string[] = [];
  for (const root of knownProjects(env)) {
    const file = projectSettingsPath(root);
    if (!ownStatusLine(file)?.includes('ccinfobar')) continue;
    try {
      if (uninstall(file).removed) done.push(root);
    } catch {}
  }
  return done;
}

export function npmGlobalBin(): string | null {
  try {
    const npm = npmCommand();
    const prefix = execFileSync(npm.file, [...npm.args, 'prefix', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 15_000,
      shell: npm.shell,
    }).trim();
    const bin =
      process.platform === 'win32'
        ? path.join(prefix, 'ccinfobar.cmd')
        : path.join(prefix, 'bin', 'ccinfobar');
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export type GlobalInstall = { ok: true; bin: string; onPath: boolean } | { ok: false; error: string };

// npx runs from a cache; keep a real copy
export function installGlobal(version: string): GlobalInstall {
  try {
    installVersion(version);
  } catch (err) {
    const msg = (err as Error).message;
    return {
      ok: false,
      error: /EACCES|EPERM/.test(msg) ? "no permission to write to npm's global folder (EACCES)" : msg,
    };
  }
  const onPath = globalBinary();
  if (onPath) return { ok: true, bin: onPath, onPath: true };
  const bin = npmGlobalBin();
  return bin
    ? { ok: true, bin, onPath: false }
    : { ok: false, error: 'npm finished but ccinfobar was not found' };
}

export interface Setup {
  command: string | null;
  onPath: boolean;
}

function setup(command: string | null, onPath: boolean): Setup {
  return { command, onPath: !!command && onPath };
}

// npx: global command, else a pinned copy under the config dir
export function setupCommand(
  version: string,
  opts: { global?: boolean; log?: (line: string) => void } = {},
): Setup {
  const log = opts.log ?? (() => {});
  if (installKind() !== 'npx') return setup(defaultCommand(undefined, log), !!globalBinary());
  const existing = globalBinary();
  if (existing)
    return setup(acceptCommand(buildCommand({ kind: 'bin', bin: existing, onPath: true }), log), true);
  if (opts.global !== false) {
    log(`Installing ccinfobar ${version} globally (skip with --no-global) ...`);
    const g = installGlobal(version);
    if (g.ok) {
      log(`✓ Installed ${g.bin}`);
      if (!g.onPath)
        log(`  ${path.dirname(g.bin)} is not on your PATH; add it to type \`ccinfobar\` directly.`);
      return setup(acceptCommand(buildCommand({ kind: 'bin', bin: g.bin, onPath: g.onPath }), log), g.onPath);
    }
    log(`⚠ Global install failed: ${g.error}`);
  }
  log(`Installing a pinned copy of ccinfobar ${version} in ${localPrefix()} ...`);
  try {
    installVersion(version, localPrefix());
  } catch (err) {
    log(`✗ Could not install ccinfobar: ${(err as Error).message}`);
    return { command: null, onPath: false };
  }
  if (!fs.existsSync(localBin())) {
    log('✗ npm finished but ccinfobar was not found');
    return { command: null, onPath: false };
  }
  log(`✓ Installed ${localBin()}`);
  return setup(acceptCommand(buildCommand({ kind: 'bin', bin: localBin(), onPath: false }), log), false);
}
