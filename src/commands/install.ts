import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDir, claudeSettingsPath } from '../core/paths.js';

export interface StatusLineSetting {
  type: 'command';
  command: string;
  padding?: number;
  refreshInterval?: number;
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${file}: ${(err as Error).message}`);
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function globalBinary(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['ccinfobar'], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
    const first = out.split(/\r?\n/).find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

function quote(p: string): string {
  return /[\s"]/.test(p) ? `"${p}"` : p;
}

export function defaultCommand(): string {
  const bin = globalBinary();
  if (bin) return quote(bin);
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (entry && fs.existsSync(entry)) return `${quote(process.execPath)} ${quote(entry)}`;
  return 'npx -y https://github.com/alpadalar/ccinfobar/releases/latest/download/ccinfobar.tgz';
}

export function currentStatusLine(file = claudeSettingsPath()): StatusLineSetting | null {
  const sl = readJson(file).statusLine;
  return sl && typeof sl === 'object' ? (sl as StatusLineSetting) : null;
}

export function install(
  command: string,
  refreshInterval?: number,
  file = claudeSettingsPath(),
): string | null {
  const settings = readJson(file);
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    backup = `${file}.ccinfobar-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  const statusLine: StatusLineSetting = { type: 'command', command, padding: 0 };
  const prev = settings.statusLine as StatusLineSetting | undefined;
  const refresh =
    refreshInterval ?? (prev?.command?.includes('ccinfobar') ? prev.refreshInterval : undefined);
  if (refresh && refresh > 0) statusLine.refreshInterval = Math.floor(refresh);
  settings.statusLine = statusLine;
  writeJson(file, settings);
  return backup;
}

export type UninstallResult = { removed: false } | { removed: true; restored: StatusLineSetting | null };

export function uninstall(file = claudeSettingsPath()): UninstallResult {
  const settings = readJson(file);
  const sl = settings.statusLine as StatusLineSetting | undefined;
  if (!sl || typeof sl.command !== 'string' || !sl.command.includes('ccinfobar')) return { removed: false };
  let previous: StatusLineSetting | null = null;
  try {
    const backup = readJson(`${file}.ccinfobar-backup`).statusLine as StatusLineSetting | undefined;
    if (backup && typeof backup.command === 'string' && !backup.command.includes('ccinfobar'))
      previous = backup;
  } catch {}
  if (previous) settings.statusLine = previous;
  else delete settings.statusLine;
  if (!previous && !fs.existsSync(`${file}.ccinfobar-backup`) && Object.keys(settings).length === 0) {
    fs.rmSync(file, { force: true });
  } else writeJson(file, settings);
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
    const projects = (readJson(claudeJsonPath(env)).projects ?? {}) as Record<string, unknown>;
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
