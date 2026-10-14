import os from 'node:os';
import path from 'node:path';

const APP = 'ccinfobar';

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

export function lastPayloadPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'last-payload.json');
}

export function tildify(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}
