import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, managedDirs, managedFilesIn, projectSettingsPath } from '../core/paths.js';
import { effectiveLeaf, type SettingsLayer } from '../core/settings-layers.js';
import { readJson } from './environment.js';
import { insideRepo } from './repos.js';

export interface SandboxState {
  enabled: boolean;
  strict: boolean;
}

export interface SandboxOptions {
  platform?: NodeJS.Platform;
  managedDir?: string;
  home?: string;
}

const MAX = 1024 * 1024;

const list = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

export function readSandbox(
  launch: string,
  env: NodeJS.ProcessEnv,
  opts: SandboxOptions = {},
): SandboxState | null {
  try {
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32') return null;
    const layers: SettingsLayer[] = [];
    const add = (name: SettingsLayer['name'], file: string) =>
      layers.push({ name, file, data: readJson(file, MAX) });
    const bases = opts.managedDir ? [opts.managedDir] : managedDirs(platform, env);
    for (const base of bases) for (const file of managedFilesIn(base, list)) add('managed', file);
    const start = path.resolve(launch);
    const rootDir = insideRepo(start, path, { env, home: opts.home });
    if (rootDir && path.resolve(rootDir) !== start) add('local', projectSettingsPath(rootDir, true));
    add('local', projectSettingsPath(start, true));
    add('project', projectSettingsPath(start, false));
    add('user', path.join(claudeDir(env), 'settings.json'));

    const enabled = effectiveLeaf(layers, ['sandbox', 'enabled']);
    if (!enabled) return null;
    const managed = layers.filter((l) => l.name === 'managed');
    const strictAdmin = effectiveLeaf(managed, ['sandbox', 'allowUnsandboxedCommands'])?.value === false;
    const domainsOnly =
      effectiveLeaf(managed, ['sandbox', 'network', 'allowManagedDomainsOnly'])?.value === true;
    const userOn = layers.some(
      (l) => l.name === 'user' && (l.data?.sandbox as { enabled?: unknown } | undefined)?.enabled === true,
    );
    const repoOff = enabled.layer.name !== 'user' && enabled.layer.name !== 'managed' && !enabled.value;
    const on = (strictAdmin || domainsOnly) && userOn && repoOff ? true : enabled.value;
    const strict = effectiveLeaf(layers, ['sandbox', 'allowUnsandboxedCommands'])?.value === false;
    return { enabled: on, strict };
  } catch {
    return null;
  }
}
