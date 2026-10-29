import fs from 'node:fs';
import { t } from '../core/i18n/index.js';
import { claudeSettingsPath } from '../core/paths.js';
import { defaultCommand, type StatusLineSetting } from './install-target.js';
import {
  classifyOwner,
  findSubagentLineEntry,
  type Manifest,
  manifestFile,
  type Owner,
  ownedEqual,
  readManifest,
} from './manifest.js';
import { readSettings, resolveReal } from './settings-file.js';

export function statusLineOf(data: Record<string, unknown>): StatusLineSetting | null {
  const sl = data.statusLine;
  return sl && typeof sl === 'object' && !Array.isArray(sl) ? (sl as StatusLineSetting) : null;
}

export interface SubagentSetting {
  type: 'command';
  command: string;
  [k: string]: unknown;
}

export const subagentCommand = (command: string) => `${command} subagent-line`;

export function subagentOf(data: Record<string, unknown>): unknown | null {
  const v = data.subagentStatusLine;
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

export type SubagentOwner = 'none' | 'ours' | 'foreign';

export interface SubagentPlan {
  current: unknown | null;
  owner: SubagentOwner;
  proposed: SubagentSetting;
  changes: boolean;
  asked: boolean;
}

export function currentSubagentLine(
  file = claudeSettingsPath(),
  env: NodeJS.ProcessEnv = process.env,
): { command: string; owned: boolean } | null {
  const cur = subagentOf(readSettings(file).data) as Record<string, unknown> | null;
  if (!cur) return null;
  const entry = findSubagentLineEntry(openManifest(env), file);
  return {
    command: typeof cur.command === 'string' ? cur.command : '',
    owned: !!entry && ownedEqual(cur, entry.value),
  };
}

export function currentStatusLine(file = claudeSettingsPath()): StatusLineSetting | null {
  return statusLineOf(readSettings(file).data);
}

const EMPTY: Manifest = { version: 1, entries: [] };
export const noOriginal = (env: NodeJS.ProcessEnv) => ({ original: false, env });

export function openManifest(env: NodeJS.ProcessEnv = process.env): Manifest {
  const m = readManifest(env);
  if (m.readOnly) throw new Error(t('install.manifestReadOnly', { file: manifestFile(env) }));
  return m;
}

// defaultCommand() spawns, so only for the unclear case
export function classify(
  m: Manifest,
  file: string,
  sl: StatusLineSetting | null,
  command: string | null,
): Owner {
  const owner = classifyOwner(m, file, sl, command);
  if (owner !== 'legacy-ask') return owner;
  const def = defaultCommand();
  return def && def !== command ? classifyOwner(m, file, sl, def) : owner;
}

export const isMine = (o: Owner) => o === 'ours' || o === 'legacy-ours';

export function legacyBackup(file: string): string | null {
  const candidates = [`${file}.ccinfobar-backup`];
  try {
    candidates.push(`${resolveReal(file)}.ccinfobar-backup`);
  } catch {}
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

export function legacyPrevious(file: string, command: string | null): StatusLineSetting | null {
  const legacy = legacyBackup(file);
  if (!legacy) return null;
  try {
    const sl = statusLineOf(readSettings(legacy).data);
    if (!sl || typeof sl.command !== 'string') return null;
    return classifyOwner(EMPTY, file, sl, command) === 'legacy-ours' ? null : sl;
  } catch {
    return null;
  }
}

export function statusLineOwner(
  file = claudeSettingsPath(),
  command: string | null = null,
): { current: StatusLineSetting | null; owner: Owner } {
  const current = currentStatusLine(file);
  return { current, owner: classify(readManifest(), file, current, command) };
}
