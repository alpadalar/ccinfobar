import { type ExecFileSyncOptionsWithStringEncoding, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { t } from '../core/i18n/index.js';
import { claudeSettingsPath, lastPayloadPath } from '../core/paths.js';
import { HOOK_EVENTS, type HookEvent, isHookEvent } from '../data/hooks.js';
import { isProgressEvent, PROGRESS_EVENTS, type ProgressEvent } from '../data/progress.js';
import { compareVersions, safeCwd } from '../data/update-state.js';
import {
  deepEqual,
  dropHookEntry,
  findHookEntries,
  type HookEntry,
  type Manifest,
  manifestFile,
  noteWrite,
  readManifest,
  realKey,
  recordHook,
  writeManifest,
} from './manifest.js';
import { patchSettings, rollbackPatch } from './settings-file.js';

export const DEFAULT_EVENTS: readonly HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'PermissionDenied',
];
export const OPTIONAL_EVENTS: readonly HookEvent[] = ['PermissionRequest'];
// per-tool, per-batch or blocking: never registered
export const NEVER_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolBatch',
  'PreModelSwitch',
  'SessionEnd',
] as const;

export type HookFloor = Record<
  'core' | 'async' | 'notificationMatcher' | 'PermissionRequest' | 'PermissionDenied' | 'terminalSequence',
  string
>;

export const HOOK_FLOOR: HookFloor = {
  core: '2.1.101',
  async: '2.1.101',
  notificationMatcher: '2.1.101',
  PermissionRequest: '2.1.101',
  PermissionDenied: '2.1.89',
  terminalSequence: '2.1.141',
};

export interface HookHandler {
  type: 'command';
  command: string;
  async?: true;
  timeout: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export type HookAction = 'add' | 'keep' | 'rewrite' | 'skip-unmanaged' | 'skip-version';

export type HookRole = 'hooks' | 'progress' | 'all';

export interface HookPlanItem {
  event: HookEvent | ProgressEvent;
  role?: 'progress';
  action: HookAction;
  group: HookGroup;
  from?: HookGroup;
}

export type HookRefusal = 'unknown-version' | 'old-version';

export interface HookPlan {
  claudeCode: string | null;
  refused: HookRefusal | null;
  asyncOmitted: boolean;
  progressRefused?: HookRefusal | null;
  items: HookPlanItem[];
}

export function hookGroup(event: HookEvent, command: string, opts: { async: boolean }): HookGroup {
  const cmd = `${command} hook ${event}`;
  const handler: HookHandler = opts.async
    ? { type: 'command', command: cmd, async: true, timeout: 5 }
    : { type: 'command', command: cmd, timeout: 5 };
  return event === 'Notification' ? { matcher: 'permission_prompt', hooks: [handler] } : { hooks: [handler] };
}

// sync: async handlers never emit terminalSequence
export function progressGroup(event: ProgressEvent, command: string): HookGroup {
  return { hooks: [{ type: 'command', command: `${command} --progress hook ${event}`, timeout: 5 }] };
}

export const inRole = (e: { role?: unknown }, role: HookRole) =>
  role === 'all' || (role === 'progress' ? e.role === 'progress' : e.role === undefined);

export const hookKey = (i: { event: string; role?: string }) => (i.role ? `${i.role}:${i.event}` : i.event);

export function hookEventsFor(flag: string | boolean | undefined): HookEvent[] | null {
  if (flag === undefined || flag === false) return [];
  if (flag === true) return [...DEFAULT_EVENTS];
  if (flag === 'permission') return [...DEFAULT_EVENTS, ...OPTIONAL_EVENTS];
  return null;
}

export function parseClaudeVersion(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  return /^(\d+\.\d+\.\d+)/.exec(s.trim())?.[1] ?? null;
}

type Exec = (file: string, argv: string[]) => string;

// windows searches cwd first; never run a planted claude
export const claudeExecOptions = (): ExecFileSyncOptionsWithStringEncoding & { env: NodeJS.ProcessEnv } => ({
  encoding: 'utf8',
  timeout: 2000,
  windowsHide: true,
  cwd: safeCwd(),
  env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
  stdio: ['ignore', 'pipe', 'ignore'],
});

const realExec: Exec = (file, argv) => execFileSync(file, argv, claudeExecOptions());

// npm's claude.cmd needs a shell
function claudeTries(platform: NodeJS.Platform): Array<[string, string[]]> {
  return platform === 'win32'
    ? [
        ['claude.exe', ['--version']],
        ['cmd.exe', ['/d', '/s', '/c', 'claude --version']],
      ]
    : [['claude', ['--version']]];
}

function payloadVersion(env: NodeJS.ProcessEnv): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(lastPayloadPath(env), 'utf8'));
    return raw && typeof raw === 'object' ? parseClaudeVersion((raw as { version?: unknown }).version) : null;
  } catch {
    return null;
  }
}

export function detectClaudeCode(
  deps: { exec?: Exec; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const exec = deps.exec ?? realExec;
  for (const [file, argv] of claudeTries(deps.platform ?? process.platform)) {
    try {
      const v = parseClaudeVersion(exec(file, argv));
      if (v) return v;
    } catch {}
  }
  return payloadVersion(deps.env ?? process.env);
}

type AsyncExec = (file: string, argv: string[], signal?: AbortSignal) => Promise<string>;

// no AbortSignal: killing a child whose spawn failed can signal our whole process group;
// on abort it runs out its timeout without holding the process open
export const realExecAsync: AsyncExec = (file, argv, signal) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, argv, claudeExecOptions(), (err, out) => {
      signal?.removeEventListener('abort', done);
      err ? reject(err) : resolve(String(out));
    });
    function done() {
      child.unref();
      (child.stdout as { unref?: () => void } | null)?.unref?.();
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', done, { once: true });
  });

// the editor must not block on claude --version
export async function detectClaudeCodeAsync(
  deps: { exec?: AsyncExec; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<string | null> {
  const exec = deps.exec ?? realExecAsync;
  for (const [file, argv] of claudeTries(deps.platform ?? process.platform)) {
    if (deps.signal?.aborted) return null;
    try {
      const v = parseClaudeVersion(await exec(file, argv, deps.signal));
      if (v) return v;
    } catch {}
  }
  return payloadVersion(deps.env ?? process.env);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const below = (v: string, floor: string) => compareVersions(v, floor) < 0;
const NEVER: ReadonlySet<string> = new Set(NEVER_EVENTS);

function groupsOf(settings: Record<string, unknown>, event: string): unknown[] {
  const hooks = settings.hooks;
  if (!isObj(hooks)) return [];
  const list = hooks[event];
  return Array.isArray(list) ? list : [];
}

const handlersOf = (g: unknown): unknown[] => (isObj(g) && Array.isArray(g.hooks) ? g.hooks : []);

export function eventFloor(event: string, floor: HookFloor = HOOK_FLOOR): string | null {
  if (event === 'PermissionRequest') return floor.PermissionRequest;
  if (event === 'PermissionDenied') return floor.PermissionDenied;
  if (event === 'Notification') return floor.notificationMatcher;
  return null;
}

// Claude Code dedupes identical handlers only, so a same-command one would run twice
function decide(
  event: HookPlanItem['event'],
  desired: HookGroup,
  settings: Record<string, unknown>,
  entry: HookEntry | undefined,
  role?: 'progress',
): HookPlanItem {
  const base = role ? { event, role } : { event };
  const groups = groupsOf(settings, event);
  if (entry && groups.some((g) => deepEqual(g, entry.value))) {
    if (deepEqual(entry.value, desired)) return { ...base, action: 'keep', group: desired };
    return { ...base, action: 'rewrite', group: desired, from: structuredClone(entry.value) as HookGroup };
  }
  const ours = desired.hooks[0] as HookHandler;
  const present = groups.some((g) =>
    handlersOf(g).some((h) => deepEqual(h, ours) || (isObj(h) && h.command === ours.command)),
  );
  return { ...base, action: present ? 'skip-unmanaged' : 'add', group: desired };
}

const entryOf = (entries: HookEntry[], event: string, role?: 'progress') =>
  entries.find((e) => e.event === event && e.role === role);

function progressRefusal(claudeCode: string | null, floor: HookFloor): HookRefusal | null {
  if (!claudeCode) return 'unknown-version';
  return below(claudeCode, floor.terminalSequence) ? 'old-version' : null;
}

// pure
export function planHooks(input: {
  settings: Record<string, unknown>;
  manifest: Manifest;
  file: string;
  command: string;
  claudeCode: string | null;
  events: readonly HookEvent[];
  progress?: boolean;
  floor?: HookFloor;
}): HookPlan {
  const floor = input.floor ?? HOOK_FLOOR;
  const { claudeCode } = input;
  const progressRefused = input.progress ? progressRefusal(claudeCode, floor) : undefined;
  const pr = progressRefused === undefined ? {} : { progressRefused };
  if (!claudeCode) return { claudeCode, refused: 'unknown-version', asyncOmitted: false, ...pr, items: [] };
  if (below(claudeCode, floor.core))
    return { claudeCode, refused: 'old-version', asyncOmitted: false, ...pr, items: [] };
  const asyncOmitted = below(claudeCode, floor.async);
  const wanted = new Set<string>(input.events);
  const entries = findHookEntries(input.manifest, input.file);
  const items = HOOK_EVENTS.filter((e) => wanted.has(e) && !NEVER.has(e)).map((event): HookPlanItem => {
    const desired = hookGroup(event, input.command, { async: !asyncOmitted });
    const min = eventFloor(event, floor);
    if (min && below(claudeCode, min)) return { event, action: 'skip-version', group: desired };
    return decide(event, desired, input.settings, entryOf(entries, event));
  });
  if (input.progress && !progressRefused)
    for (const event of PROGRESS_EVENTS) {
      const desired = progressGroup(event, input.command);
      items.push(decide(event, desired, input.settings, entryOf(entries, event, 'progress'), 'progress'));
    }
  return { claudeCode, refused: null, asyncOmitted, ...pr, items };
}

const hasAsync = (v: unknown) => handlersOf(v).some((h) => isObj(h) && h.async === true);

// D-20: owned groups follow the statusLine command
export function planHookRewrites(
  settings: Record<string, unknown>,
  manifest: Manifest,
  file: string,
  command: string,
): HookPlanItem[] {
  const out: HookPlanItem[] = [];
  for (const entry of findHookEntries(manifest, file)) {
    const event = entry.event;
    const progress = entry.role === 'progress';
    let desired: HookGroup;
    if (progress && isProgressEvent(event)) desired = progressGroup(event, command);
    else if (!progress && entry.role === undefined && isHookEvent(event) && !NEVER.has(event))
      desired = hookGroup(event, command, { async: hasAsync(entry.value) });
    else continue;
    if (!groupsOf(settings, event).some((g) => deepEqual(g, entry.value))) continue;
    if (deepEqual(desired, entry.value)) continue;
    const from = structuredClone(entry.value) as HookGroup;
    out.push({ event, ...(progress ? { role: 'progress' } : {}), action: 'rewrite', group: desired, from });
  }
  return out;
}

// returns the items now in effect; never overwrites user data
export function mutateHooks(draft: Record<string, unknown>, items: HookPlanItem[]): HookPlanItem[] {
  const applied: HookPlanItem[] = [];
  for (const item of items) {
    if (item.action === 'keep') applied.push(item);
    if (item.action !== 'add' && item.action !== 'rewrite') continue;
    const add = item.action === 'add';
    if (add && !Object.hasOwn(draft, 'hooks')) draft.hooks = {};
    const hooks = draft.hooks;
    if (!isObj(hooks)) continue;
    if (add && !Object.hasOwn(hooks, item.event)) hooks[item.event] = [];
    const list = hooks[item.event];
    if (!Array.isArray(list)) continue;
    if (add) list.push(structuredClone(item.group));
    else {
      const i = list.findIndex((g) => deepEqual(g, item.from));
      if (i < 0) continue;
      list[i] = structuredClone(item.group);
    }
    applied.push(item);
  }
  return applied;
}

// reports keep the skips; add/rewrite only when applied
export function appliedItems(planned: HookPlanItem[], applied: HookPlanItem[]): HookPlanItem[] {
  return planned.filter((i) => i.action.startsWith('skip-') || applied.includes(i));
}

export function recordHooks(
  m: Manifest,
  file: string,
  applied: HookPlanItem[],
  claudeCode: string | null,
  hash: string | null,
): Manifest {
  const before = findHookEntries(m, file);
  let next = m;
  for (const item of applied) {
    const prev = entryOf(before, item.event, item.role);
    next = recordHook(next, {
      file,
      event: item.event,
      ...(item.role ? { role: item.role } : {}),
      ...(item.group.matcher !== undefined ? { matcher: item.group.matcher } : {}),
      value: structuredClone(item.group),
      claudeCode: item.action === 'add' ? claudeCode : (prev?.claudeCode ?? claudeCode),
      writtenHash: hash,
    });
  }
  return next;
}

export const isUserSettings = (file: string, env: NodeJS.ProcessEnv) =>
  realKey(file) === realKey(claudeSettingsPath(env));

// hooks-only write; re-decided against the re-read file
// remove: owned events to drop in the same write
export function applyHooks(
  file: string,
  plan: HookPlan,
  env: NodeJS.ProcessEnv = process.env,
  remove: readonly string[] = [],
): { changed: boolean; backup: string | null; items: HookPlanItem[]; removed: string[] } {
  if (plan.refused || !isUserSettings(file, env))
    return { changed: false, backup: null, items: [], removed: [] };
  const m = readManifest(env);
  if (m.readOnly) throw new Error(t('install.manifestReadOnly', { file: manifestFile(env) }));
  const entries = findHookEntries(m, file);
  const planned = new Set<string>(plan.items.map(hookKey));
  const drop = entries.filter((e) => !e.role && remove.includes(e.event) && !planned.has(e.event));
  const state = { planned: [] as HookPlanItem[], applied: [] as HookPlanItem[], removed: [] as string[] };
  const res = patchSettings(
    file,
    (draft) => {
      state.planned = plan.items.map((i) =>
        i.action === 'skip-version'
          ? i
          : decide(i.event, i.group, draft, entryOf(entries, i.event, i.role), i.role),
      );
      state.applied = mutateHooks(draft, state.planned);
      state.removed = drop.length ? removeOwnedHooks(draft, drop).removed : [];
    },
    { original: false, env },
  );
  try {
    let next = recordHooks(m, res.real, state.applied, plan.claudeCode, res.afterHash);
    for (const e of drop) next = dropHookEntry(next, res.real, e.event, e.role);
    writeManifest(res.changed ? noteWrite(next, res.real, res.beforeHash, res.afterHash) : next, env);
  } catch (err) {
    if (res.changed) rollbackPatch(file, res, env);
    throw err;
  }
  return {
    changed: res.changed,
    backup: res.backup,
    items: appliedItems(state.planned, state.applied),
    removed: state.removed,
  };
}

export interface RemovedHooks {
  removed: string[];
  kept: string[];
  // only when progress entries were involved
  progress?: { removed: string[]; kept: string[] };
}

function listsFor(out: RemovedHooks, e: HookEntry): { removed: string[]; kept: string[] } {
  if (e.role !== 'progress') return out;
  out.progress ??= { removed: [], kept: [] };
  return out.progress;
}

// lists for entries removed without a key-level pass
export function removedLists(entries: HookEntry[]): RemovedHooks {
  const out: RemovedHooks = { removed: [], kept: [] };
  for (const e of entries) listsFor(out, e).removed.push(e.event);
  return out;
}

// D-19: deepEqual ownership; only arrays we emptied are dropped
export function removeOwnedHooks(draft: Record<string, unknown>, entries: HookEntry[]): RemovedHooks {
  const out: RemovedHooks = { removed: [], kept: [] };
  const hooks = draft.hooks;
  const touched = new Set<string>();
  for (const entry of entries) {
    const lists = listsFor(out, entry);
    const list = isObj(hooks) ? hooks[entry.event] : undefined;
    const i = Array.isArray(list) ? list.findIndex((g) => deepEqual(g, entry.value)) : -1;
    if (i < 0 || !Array.isArray(list)) {
      lists.kept.push(entry.event);
      continue;
    }
    list.splice(i, 1);
    lists.removed.push(entry.event);
    touched.add(entry.event);
  }
  if (!isObj(hooks) || !touched.size) return out;
  for (const event of touched) {
    const list = hooks[event];
    if (Array.isArray(list) && list.length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete draft.hooks;
  return out;
}

export interface HooksRemoval extends RemovedHooks {
  backup: string | null;
  changed: boolean;
}

// D-19: hooks only; the statusLine stays
export function uninstallHooks(
  file: string = claudeSettingsPath(),
  env: NodeJS.ProcessEnv = process.env,
  only?: readonly string[],
  role: HookRole = 'hooks',
): HooksRemoval {
  const m = readManifest(env);
  if (m.readOnly) throw new Error(t('install.manifestReadOnly', { file: manifestFile(env) }));
  const entries = findHookEntries(m, file).filter(
    (e) => inRole(e, role) && (!only || only.includes(e.event)),
  );
  if (!entries.length) return { removed: [], kept: [], backup: null, changed: false };
  const state: RemovedHooks = { removed: [], kept: [] };
  const res = patchSettings(
    file,
    (draft) => {
      Object.assign(state, removeOwnedHooks(draft, entries));
    },
    { original: false, env },
  );
  let next = m;
  for (const e of entries) next = dropHookEntry(next, res.real, e.event, e.role);
  try {
    writeManifest(res.changed ? noteWrite(next, res.real, res.beforeHash, res.afterHash) : next, env);
  } catch (err) {
    if (res.changed) rollbackPatch(file, res, env);
    throw err;
  }
  return { ...state, backup: res.backup, changed: res.changed };
}
