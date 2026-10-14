import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../core/paths.js';
import { writeAtomic } from './store.js';

export function cacheKey(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 20);
}

export function cacheFile(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), name);
}

export function readCache<T>(name: string, env: NodeJS.ProcessEnv = process.env): T | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(name, env), 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeCache(name: string, value: unknown, env: NodeJS.ProcessEnv = process.env): void {
  try {
    writeAtomic(cacheFile(name, env), JSON.stringify(value));
  } catch {}
}
