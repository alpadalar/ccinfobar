import fs from 'node:fs';
import path from 'node:path';
import { cacheKey, readCache, writeCache } from './cache.js';

export interface WhichDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isFile: (p: string) => boolean;
  now?: () => number;
}

const POSITIVE_TTL = 86_400_000;
const NEGATIVE_TTL = 300_000;

export function whichDeps(env: NodeJS.ProcessEnv = process.env): WhichDeps {
  return {
    platform: process.platform,
    env,
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    now: Date.now,
  };
}

export function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const key = Object.keys(env)
      .filter((k) => k.toUpperCase() === 'PATH')
      .sort()[0];
    return (key !== undefined ? env[key] : undefined) ?? '';
  }
  return env.PATH ?? '';
}

export function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = pathValue(env, platform);
  if (platform !== 'win32') return raw.split(':').filter((d) => d.startsWith('/'));
  const out: string[] = [];
  for (let d of raw.split(';')) {
    if (d.length >= 2 && d.startsWith('"') && d.endsWith('"')) d = d.slice(1, -1);
    if (!d || d === '.' || d.includes('%')) continue;
    d = d.replace(/\//g, '\\');
    if (!path.win32.isAbsolute(d)) continue;
    if (!/^[A-Za-z]:\\/.test(d) && !/^\\\\/.test(d)) continue;
    out.push(d);
  }
  return out;
}

export function findBinary(name: string, deps: WhichDeps): string | null {
  for (const dir of pathDirs(deps.env, deps.platform)) {
    for (const ext of ['.com', '.exe']) {
      const candidate = path.win32.join(dir, name + ext);
      if (deps.isFile(candidate)) return candidate;
    }
  }
  return null;
}

const memo = new Map<string, string | null>();

export function resetWhich(): void {
  memo.clear();
}

export function binary(name: 'git' | 'jj', deps: WhichDeps = whichDeps()): string | null {
  if (deps.platform !== 'win32') return name;
  const pv = pathValue(deps.env, 'win32');
  const memoKey = `${name}\0${pv}`;
  if (memo.has(memoKey)) return memo.get(memoKey) ?? null;
  const now = (deps.now ?? Date.now)();
  const file = `bin-${name}.json`;
  const pvKey = cacheKey(pv);
  const hit = readCache<{ pv: string; path: string | null; at: number }>(file);
  let found: string | null | undefined;
  if (hit && hit.pv === pvKey && typeof hit.at === 'number' && Number.isFinite(hit.at)) {
    const age = now - hit.at;
    if (hit.path === null && age >= 0 && age < NEGATIVE_TTL) found = null;
    else if (
      typeof hit.path === 'string' &&
      age >= 0 &&
      age < POSITIVE_TTL &&
      /^(?:[A-Za-z]:\\|\\\\)/.test(hit.path) &&
      new RegExp(`^${name}\\.(com|exe)$`, 'i').test(path.win32.basename(hit.path)) &&
      deps.isFile(hit.path)
    )
      found = hit.path;
  }
  if (found === undefined) {
    found = findBinary(name, deps);
    writeCache(file, { pv: pvKey, path: found, at: now });
  }
  memo.set(memoKey, found);
  return found;
}
