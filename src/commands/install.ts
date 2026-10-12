import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { claudeSettingsPath } from '../core/paths.js';

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

export function isGloballyInstalled(): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, ['ccinfobar'], { stdio: 'ignore', windowsHide: true, timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export function defaultCommand(): string {
  if (isGloballyInstalled()) return 'ccinfobar';
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (entry && fs.existsSync(entry)) return `"${process.execPath}" "${entry}"`;
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
  if (refreshInterval && refreshInterval > 0) statusLine.refreshInterval = Math.floor(refreshInterval);
  settings.statusLine = statusLine;
  writeJson(file, settings);
  return backup;
}

export function uninstall(file = claudeSettingsPath()): boolean {
  const settings = readJson(file);
  const sl = settings.statusLine as StatusLineSetting | undefined;
  if (!sl || typeof sl.command !== 'string' || !sl.command.includes('ccinfobar')) return false;
  delete settings.statusLine;
  writeJson(file, settings);
  return true;
}
