import '../core/i18n/lazy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { tildify } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import { parseToml, TomlError } from './toml.js';

export const MAX_SOURCE_BYTES = 1_048_576;

export class SourceTooLargeError extends Error {}

// fstat on the open fd, so a swapped file is still capped
export function readSource(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const tooLarge = () => new SourceTooLargeError(t('import.tooLarge', { file }));
    if (fs.fstatSync(fd).size > MAX_SOURCE_BYTES) throw tooLarge();
    const buf = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > MAX_SOURCE_BYTES) throw tooLarge();
    const text = buf.toString('utf8', 0, n);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// a regular file, followed through symlinks (not a device or dir)
export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// regular files only, never through a symlink
export function isPlainFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export function expand(p: string, home = os.homedir()): string {
  return p.startsWith('~') ? path.join(home, p.slice(1)) : p;
}

export function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

// tildify against the injected home
export function shownFile(file: string, home: string): string {
  const rel = file === home ? '~' : file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : null;
  return sanitizeText(rel ?? tildify(file));
}

export function readJson(file: string): unknown | null {
  try {
    return JSON.parse(readSource(file));
  } catch (err) {
    if (err instanceof SourceTooLargeError) throw err;
    return null;
  }
}

export function readJsonTool(file: string, tool: string): unknown {
  const shown = sanitizeText(tildify(file));
  let text: string;
  try {
    text = readSource(file);
  } catch (err) {
    if (err instanceof SourceTooLargeError) throw err;
    throw new Error(t('import.cannotReadTool', { tool, file: shown }));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(t('import.cannotParseTool', { tool, file: shown }));
  }
}

export function readToml(file: string, tool: string): unknown {
  let text: string;
  try {
    text = readSource(file);
  } catch (err) {
    if (err instanceof SourceTooLargeError) throw err;
    throw new Error(t('import.cannotReadTool', { tool, file }));
  }
  try {
    return parseToml(text);
  } catch (err) {
    if (err instanceof TomlError) {
      throw new Error(`${sanitizeText(tildify(file))}:${err.line}:${err.col} ${err.message}`);
    }
    throw err;
  }
}

export const tableOf = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export const safeThemeName = (name: string) => /^[\w.-]+$/.test(name) && !name.includes('..');
