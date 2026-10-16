import os from 'node:os';
import path from 'node:path';

const APP = 'ccinfobar';

export const MAX_PROJECT = 1024;

function trimRoot(raw: string, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let root = p.resolve(raw);
  while (root.length > 1 && /[\\/]$/.test(root) && p.dirname(root) !== root) root = root.slice(0, -1);
  return root;
}

// project key: resolved, no trailing separator, lowercased on Windows
export function normalizeRoot(raw: string, platform: NodeJS.Platform = process.platform): string {
  const root = trimRoot(raw, platform);
  return (platform === 'win32' ? root.toLowerCase() : root).slice(0, MAX_PROJECT);
}

// normalizeRoot in the path's own letter case
export function displayRoot(raw: string, platform: NodeJS.Platform = process.platform): string {
  return trimRoot(raw, platform).slice(0, MAX_PROJECT);
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCINFOBAR_CONFIG_DIR) return env.CCINFOBAR_CONFIG_DIR;
  if (process.platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), APP);
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), APP);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCINFOBAR_CONFIG ?? path.join(configDir(env), 'config.json');
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCINFOBAR_CACHE_DIR) return env.CCINFOBAR_CACHE_DIR;
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), APP, 'cache');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', APP);
  return path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), APP);
}

export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeDir(env), 'settings.json');
}

export function projectSettingsPath(dir: string, local = true): string {
  return path.join(dir, '.claude', local ? 'settings.local.json' : 'settings.json');
}

const envOf = (env: NodeJS.ProcessEnv, key: string, win: boolean): string | undefined => {
  if (!win) return env[key];
  const k = Object.keys(env).find((x) => x.toUpperCase() === key.toUpperCase());
  return k === undefined ? undefined : env[k];
};

export function managedDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode'];
  if (platform !== 'win32') return ['/etc/claude-code'];
  const bases = ['C:\\Program Files\\ClaudeCode'];
  const pf = envOf(env, 'ProgramFiles', true);
  if (pf && path.win32.isAbsolute(pf)) {
    const alt = path.win32.join(pf, 'ClaudeCode');
    if (!bases.some((b) => b.toLowerCase() === alt.toLowerCase())) bases.push(alt);
  }
  return bases;
}

export function managedDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return managedDirs(platform, env)[0]!;
}

export function managedFilesIn(base: string, list: (dir: string) => string[], p = path): string[] {
  const dir = p.join(base, 'managed-settings.d');
  const names = list(dir)
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .sort();
  return [p.join(base, 'managed-settings.json'), ...names.map((n) => p.join(dir, n))];
}

// file-based only; MDM and registry are not read
export function managedSettingsFiles(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  list: (dir: string) => string[],
): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return managedDirs(platform, env).flatMap((b) => managedFilesIn(b, list, p));
}

export function lastPayloadPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'last-payload.json');
}

export function tildify(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}
