import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { claudeDir, claudeJsonPath, claudeSettingsPath, projectSettingsPath } from '../core/paths.js';
import { HARDEN } from '../data/git.js';
import { binary } from '../data/which.js';
import { currentStatusLine, isMine } from './install-owner.js';
import type { StatusLineSetting } from './install-target.js';
import { classifyOwner, type Manifest, readManifest, realKey } from './manifest.js';
import { readSettings } from './settings-file.js';
import { uninstall } from './uninstall.js';

function projectRoots(dir: string): string[] {
  const roots = [path.resolve(dir)];
  const bin = binary('git');
  if (bin === null) return roots;
  try {
    const top = execFileSync(bin, [...HARDEN, 'rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10_000,
    }).trim();
    if (top && !roots.includes(path.resolve(top))) roots.push(path.resolve(top));
  } catch {}
  return roots;
}

// ours by the manifest, or a plain 0.6.x command
function ownedHere(m: Manifest, file: string, sl: StatusLineSetting | null): boolean {
  return isMine(classifyOwner(m, file, sl, null));
}

export function projectLocalFile(dir: string): string {
  const m = readManifest();
  for (const root of projectRoots(dir)) {
    const file = projectSettingsPath(root);
    try {
      if (ownedHere(m, file, currentStatusLine(file))) return file;
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
  const m = readManifest();
  for (const root of projectRoots(dir)) {
    for (const file of [projectSettingsPath(root, true), projectSettingsPath(root, false)]) {
      let sl: StatusLineSetting | null = null;
      try {
        sl = currentStatusLine(file);
      } catch {}
      if (!sl || typeof sl.command !== 'string') continue;
      return ownedHere(m, file, sl) ? null : { file, command: sl.command };
    }
  }
  return null;
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

const fileKey = (f: string) => (process.platform === 'win32' ? realKey(f).toLowerCase() : realKey(f));

// --project installs in folders .claude.json does not list, the home folder too
function recordedProjects(m: Manifest, env: NodeJS.ProcessEnv): string[] {
  const user = fileKey(claudeSettingsPath(env));
  return m.entries.flatMap((e) => {
    if (e.kind !== 'statusLine' || typeof e.file !== 'string') return [];
    const dir = path.dirname(e.file);
    const local = path.basename(e.file) === 'settings.local.json' && path.basename(dir) === '.claude';
    return local && fileKey(e.file) !== user ? [path.dirname(dir)] : [];
  });
}

export function releaseProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  const done: string[] = [];
  const m = readManifest(env);
  const seen = new Set<string>();
  for (const root of [...knownProjects(env), ...recordedProjects(m, env)]) {
    const file = projectSettingsPath(root);
    const key = fileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!ownedHere(m, file, currentStatusLine(file))) continue;
      if (uninstall(file, { env }).removed) done.push(root);
    } catch {}
  }
  return done;
}
