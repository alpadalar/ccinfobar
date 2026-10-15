import fs from 'node:fs';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { configDir } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { writeAtomic } from '../data/store.js';
import type { StatusLineSetting } from './install.js';
import { resolveReal } from './settings-file.js';

export type Restore = { backup: string; hash: string } | { absent: true };

export interface StatusLineEntry {
  kind: 'statusLine';
  file: string;
  key: ['statusLine'];
  value: StatusLineSetting;
  previous: StatusLineSetting | null;
  fileExisted: boolean;
  restore: Restore | null;
  writtenHash: string | null;
  version: string;
  at: string;
}

export interface GitExcludeEntry {
  kind: 'gitExclude';
  file: string;
  line: string;
  version: string;
  at: string;
}

export interface HookEntry {
  kind: 'hook';
  file: string;
  event: string;
  // progress entries: 'progress:<Event>', older readers skip them (WR-06)
  hookEvent?: string;
  role?: 'progress';
  matcher?: string;
  value: unknown;
  claudeCode: string | null;
  writtenHash: string | null;
  version: string;
  at: string;
}

export type ManifestEntry =
  | StatusLineEntry
  | GitExcludeEntry
  | HookEntry
  | { kind: string; [k: string]: unknown };

export interface Manifest {
  version: 1;
  entries: ManifestEntry[];
  readOnly?: boolean;
}

export type Owner = 'none' | 'ours' | 'legacy-ours' | 'legacy-ask' | 'foreign';

export function manifestFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'manifest.json');
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// newer or damaged: owns nothing, never overwritten
export function readManifest(env: NodeJS.ProcessEnv = process.env): Manifest {
  let text: string;
  try {
    text = fs.readFileSync(manifestFile(env), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
    return { version: 1, entries: [], readOnly: true };
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error();
    if (!raw.entries.every((e) => isObj(e) && typeof e.kind === 'string')) throw new Error();
    return { version: 1, entries: raw.entries as ManifestEntry[] };
  } catch {
    return { version: 1, entries: [], readOnly: true };
  }
}

export function writeManifest(m: Manifest, env: NodeJS.ProcessEnv = process.env): void {
  if (m.readOnly) throw new Error(t('install.manifestReadOnly', { file: manifestFile(env) }));
  const out = { version: 1, entries: m.entries };
  writeAtomic(manifestFile(env), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600, class: 'settings' });
}

export function realKey(file: string): string {
  try {
    return resolveReal(file);
  } catch {
    return path.resolve(file);
  }
}

const sameFile = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function isStatusLineEntry(e: ManifestEntry): e is StatusLineEntry {
  return e.kind === 'statusLine' && typeof e.file === 'string' && isObj(e.value);
}

export function findStatusLineEntry(m: Manifest, file: string): StatusLineEntry | null {
  if (m.readOnly) return null;
  const key = realKey(file);
  return m.entries.find((e): e is StatusLineEntry => isStatusLineEntry(e) && sameFile(e.file, key)) ?? null;
}

export function owns(m: Manifest, file: string, value: unknown): boolean {
  const entry = findStatusLineEntry(m, file);
  return !!entry && value != null && deepEqual(value, entry.value);
}

// unquote; null when the command uses shell operators
function words(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) {
      cur += cmd[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else if (/[|&;<>()$`]/.test(c)) {
      return null;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(cur);
  return out;
}

const base = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? '';

// the forms 0.6.x wrote: the binary, or node + dist/ccinfobar.js; 0.5.x wrote npx
export function isLegacyCcinfobarCommand(cmd: string): boolean {
  const w = words(cmd);
  if (w?.join(' ') === 'npx -y ccinfobar@latest') return true;
  if (!w || w.length === 0 || w.length > 2) return false;
  const [first, second] = w as [string, string | undefined];
  if (second === undefined) return /^ccinfobar(\.cmd|\.ps1|\.exe)?$/i.test(base(first));
  return (
    /^node(js)?(\.exe)?$/i.test(base(first)) && /(^|\/)dist\/ccinfobar\.js$/i.test(second.replace(/\\/g, '/'))
  );
}

export function classifyOwner(
  m: Manifest,
  file: string,
  current: StatusLineSetting | null | undefined,
  expected: string | null,
): Owner {
  if (!current) return 'none';
  if (m.readOnly) return 'foreign';
  const entry = findStatusLineEntry(m, file);
  if (entry) return deepEqual(current, entry.value) ? 'ours' : 'foreign';
  const cmd = current.command;
  if (typeof cmd !== 'string') return 'foreign';
  if ((expected && cmd === expected) || isLegacyCcinfobarCommand(cmd)) return 'legacy-ours';
  return /ccinfobar/i.test(cmd) ? 'legacy-ask' : 'foreign';
}

const stampNow = () => new Date().toISOString();

export function recordStatusLine(
  m: Manifest,
  entry: Omit<StatusLineEntry, 'kind' | 'key' | 'version' | 'at'> & Partial<StatusLineEntry>,
): Manifest {
  const file = realKey(entry.file);
  const next: StatusLineEntry = {
    version: VERSION,
    at: stampNow(),
    ...entry,
    kind: 'statusLine',
    key: ['statusLine'],
    file,
  };
  const rest = m.entries.filter((e) => !(e.kind === 'statusLine' && sameFile(String(e.file), file)));
  return { ...m, entries: [...rest, next] };
}

export function recordGitExclude(m: Manifest, file: string, line: string): Manifest {
  const key = realKey(file);
  const rest = m.entries.filter(
    (e) => !(e.kind === 'gitExclude' && sameFile(String(e.file), key) && e.line === line),
  );
  const next: GitExcludeEntry = { kind: 'gitExclude', file: key, line, version: VERSION, at: stampNow() };
  return { ...m, entries: [...rest, next] };
}

export function dropEntry(m: Manifest, file: string, kind: string): Manifest {
  const key = realKey(file);
  return { ...m, entries: m.entries.filter((e) => !(e.kind === kind && sameFile(String(e.file), key))) };
}

const isHookEntry = (e: ManifestEntry): e is HookEntry =>
  e.kind === 'hook' && typeof e.file === 'string' && typeof e.event === 'string';

const PREFIX = 'progress:';
const storedEvent = (event: string, role?: 'progress') => (role ? `${PREFIX}${event}` : event);

// settings event; reads the old progress shape too
function hookEventOf(e: HookEntry): string {
  if (e.role === 'progress' && e.event.startsWith(PREFIX))
    return typeof e.hookEvent === 'string' ? e.hookEvent : e.event.slice(PREFIX.length);
  return e.event;
}

// event is the settings key here, whatever the stored shape
export function findHookEntries(m: Manifest, file: string): HookEntry[] {
  if (m.readOnly) return [];
  const key = realKey(file);
  return m.entries
    .filter((e): e is HookEntry => isHookEntry(e) && sameFile(e.file, key))
    .map((e) => {
      const event = hookEventOf(e);
      if (event === e.event) return e;
      const { hookEvent: _, ...rest } = e;
      return { ...rest, event };
    });
}

// no role is the Phase 4 entry
const isHookOf = (e: ManifestEntry, key: string, event: string, role?: 'progress') =>
  e.kind === 'hook' &&
  sameFile(String(e.file), key) &&
  e.role === role &&
  (isHookEntry(e) ? hookEventOf(e) : e.event) === event;

export function recordHook(
  m: Manifest,
  e: {
    file: string;
    event: string;
    role?: 'progress';
    matcher?: string;
    value: unknown;
    claudeCode: string | null;
    writtenHash: string | null;
  },
): Manifest {
  const file = realKey(e.file);
  const next: HookEntry = {
    kind: 'hook',
    file,
    event: storedEvent(e.event, e.role),
    ...(e.role ? { hookEvent: e.event, role: e.role } : {}),
    ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
    value: e.value,
    claudeCode: e.claudeCode,
    writtenHash: e.writtenHash,
    version: VERSION,
    at: stampNow(),
  };
  const rest = m.entries.filter((x) => !isHookOf(x, file, e.event, e.role));
  return { ...m, entries: [...rest, next] };
}

export function dropHookEntry(m: Manifest, file: string, event: string, role?: 'progress'): Manifest {
  const key = realKey(file);
  return { ...m, entries: m.entries.filter((e) => !isHookOf(e, key, event, role)) };
}

// D-19: the file's last ccinfobar write is the reference
export function refreshWrittenHash(m: Manifest, file: string, hash: string | null): Manifest {
  const key = realKey(file);
  const entries = m.entries.map((e) =>
    Object.hasOwn(e, 'writtenHash') && sameFile(String(e.file), key) ? { ...e, writtenHash: hash } : e,
  );
  return { ...m, entries };
}

// D-19: an outside edit since our last write voids the byte restore
export function noteWrite(m: Manifest, file: string, before: string | null, after: string | null): Manifest {
  const sl = findStatusLineEntry(m, file);
  const stale = !!sl?.restore && before !== sl.writtenHash;
  const next = stale ? { ...m, entries: m.entries.map((e) => (e === sl ? { ...sl, restore: null } : e)) } : m;
  return refreshWrittenHash(next, file, after);
}
