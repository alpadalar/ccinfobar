import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { t } from '../core/i18n/index.js';
import { claudeSettingsPath, lastPayloadPath } from '../core/paths.js';
import { HOOK_EVENTS, type HookEvent, isHookEvent } from '../data/hooks.js';
import { compareVersions } from '../data/update-state.js';
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

export type HookFloor = Record<'core' | 'async' | 'notificationMatcher' | 'PermissionRequest', string>;

export const HOOK_FLOOR: HookFloor = {
  core: '2.1.101',
  async: '2.1.101',
  notificationMatcher: '2.1.101',
  PermissionRequest: '2.1.101',
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

export interface HookPlanItem {
  event: HookEvent;
  action: HookAction;
  group: HookGroup;
  from?: HookGroup;
}

export type HookRefusal = 'unknown-version' | 'old-version';

export interface HookPlan {
  claudeCode: string | null;
  refused: HookRefusal | null;
  asyncOmitted: boolean;
  items: HookPlanItem[];
}

export function hookGroup(event: HookEvent, command: string, opts: { async: boolean }): HookGroup {
  const cmd = `${command} hook ${event}`;
  const handler: HookHandler = opts.async
    ? { type: 'command', command: cmd, async: true, timeout: 5 }
    : { type: 'command', command: cmd, timeout: 5 };
  return event === 'Notification' ? { matcher: 'permission_prompt', hooks: [handler] } : { hooks: [handler] };
}

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

const realExec: Exec = (file, argv) =>
  execFileSync(file, argv, {
    encoding: 'utf8',
    timeout: 2000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

// npm's claude.cmd needs a shell
export function detectClaudeCode(
  deps: { exec?: Exec; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const exec = deps.exec ?? realExec;
  const tries: Array<[string, string[]]> =
    (deps.platform ?? process.platform) === 'win32'
      ? [
          ['claude.exe', ['--version']],
          ['cmd.exe', ['/d', '/s', '/c', 'claude --version']],
        ]
      : [['claude', ['--version']]];
  for (const [file, argv] of tries) {
    try {
      const v = parseClaudeVersion(exec(file, argv));
      if (v) return v;
    } catch {}
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(lastPayloadPath(deps.env ?? process.env), 'utf8'));
    return raw && typeof raw === 'object' ? parseClaudeVersion((raw as { version?: unknown }).version) : null;
  } catch {
    return null;
  }
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

function eventFloor(event: HookEvent, floor: HookFloor): string | null {
  if (event === 'PermissionRequest') return floor.PermissionRequest;
  if (event === 'Notification') return floor.notificationMatcher;
  return null;
}

// Claude Code dedupes identical handlers only, so a same-command one would run twice
function decide(
  event: HookEvent,
  desired: HookGroup,
  settings: Record<string, unknown>,
  entry: HookEntry | undefined,
): HookPlanItem {
  const groups = groupsOf(settings, event);
  if (entry && groups.some((g) => deepEqual(g, entry.value))) {
    if (deepEqual(entry.value, desired)) return { event, action: 'keep', group: desired };
    return { event, action: 'rewrite', group: desired, from: structuredClone(entry.value) as HookGroup };
  }
  const ours = desired.hooks[0] as HookHandler;
  const present = groups.some((g) =>
    handlersOf(g).some((h) => deepEqual(h, ours) || (isObj(h) && h.command === ours.command)),
  );
  return { event, action: present ? 'skip-unmanaged' : 'add', group: desired };
}

const entryOf = (entries: HookEntry[], event: string) => entries.find((e) => e.event === event);

// pure
export function planHooks(input: {
  settings: Record<string, unknown>;
  manifest: Manifest;
  file: string;
  command: string;
  claudeCode: string | null;
  events: readonly HookEvent[];
  floor?: HookFloor;
}): HookPlan {
  const floor = input.floor ?? HOOK_FLOOR;
  const { claudeCode } = input;
  if (!claudeCode) return { claudeCode, refused: 'unknown-version', asyncOmitted: false, items: [] };
  if (below(claudeCode, floor.core))
    return { claudeCode, refused: 'old-version', asyncOmitted: false, items: [] };
  const asyncOmitted = below(claudeCode, floor.async);
  const wanted = new Set<string>(input.events);
  const entries = findHookEntries(input.manifest, input.file);
  const items = HOOK_EVENTS.filter((e) => wanted.has(e) && !NEVER.has(e)).map((event): HookPlanItem => {
    const desired = hookGroup(event, input.command, { async: !asyncOmitted });
    const min = eventFloor(event, floor);
    if (min && below(claudeCode, min)) return { event, action: 'skip-version', group: desired };
    return decide(event, desired, input.settings, entryOf(entries, event));
  });
  return { claudeCode, refused: null, asyncOmitted, items };
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
    if (!isHookEvent(event) || NEVER.has(event)) continue;
    if (!groupsOf(settings, event).some((g) => deepEqual(g, entry.value))) continue;
    const desired = hookGroup(event, command, { async: hasAsync(entry.value) });
    if (deepEqual(desired, entry.value)) continue;
    out.push({ event, action: 'rewrite', group: desired, from: structuredClone(entry.value) as HookGroup });
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
    const prev = entryOf(before, item.event);
    next = recordHook(next, {
      file,
      event: item.event,
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
export function applyHooks(
  file: string,
  plan: HookPlan,
  env: NodeJS.ProcessEnv = process.env,
): { changed: boolean; backup: string | null; items: HookPlanItem[] } {
  if (plan.refused || !isUserSettings(file, env)) return { changed: false, backup: null, items: [] };
  const m = readManifest(env);
  if (m.readOnly) throw new Error(t('install.manifestReadOnly', { file: manifestFile(env) }));
  const entries = findHookEntries(m, file);
  const state = { planned: [] as HookPlanItem[], applied: [] as HookPlanItem[] };
  const res = patchSettings(
    file,
    (draft) => {
      state.planned = plan.items.map((i) =>
        i.action === 'skip-version' ? i : decide(i.event, i.group, draft, entryOf(entries, i.event)),
      );
      state.applied = mutateHooks(draft, state.planned);
    },
    { original: false, env },
  );
  try {
    const next = recordHooks(m, res.real, state.applied, plan.claudeCode, res.afterHash);
    writeManifest(res.changed ? noteWrite(next, res.real, res.beforeHash, res.afterHash) : next, env);
  } catch (err) {
    if (res.changed) rollbackPatch(file, res, env);
    throw err;
  }
  return { changed: res.changed, backup: res.backup, items: appliedItems(state.planned, state.applied) };
}

// D-19: deepEqual ownership; only arrays we emptied are dropped
export function removeOwnedHooks(
  draft: Record<string, unknown>,
  entries: HookEntry[],
): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  const hooks = draft.hooks;
  const touched = new Set<string>();
  for (const entry of entries) {
    const list = isObj(hooks) ? hooks[entry.event] : undefined;
    const i = Array.isArray(list) ? list.findIndex((g) => deepEqual(g, entry.value)) : -1;
    if (i < 0 || !Array.isArray(list)) {
      kept.push(entry.event);
      continue;
    }
    list.splice(i, 1);
    removed.push(entry.event);
    touched.add(entry.event);
  }
  if (!isObj(hooks) || !touched.size) return { removed, kept };
  for (const event of touched) {
    const list = hooks[event];
    if (Array.isArray(list) && list.length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete draft.hooks;
  return { removed, kept };
}

export interface HooksRemoval {
  removed: string[];
  kept: string[];
  backup: string | null;
  changed: boolean;
}

// D-19: hooks only; the statusLine stays
export function uninstallHooks(
  file: string = claudeSettingsPath(),
  env: NodeJS.ProcessEnv = process.env,
): HooksRemoval {
  const m = readManifest(env);
  if (m.readOnly) throw new Error(t('install.manifestReadOnly', { file: manifestFile(env) }));
  const entries = findHookEntries(m, file);
  if (!entries.length) return { removed: [], kept: [], backup: null, changed: false };
  const state = { removed: [] as string[], kept: [] as string[] };
  const res = patchSettings(
    file,
    (draft) => {
      Object.assign(state, removeOwnedHooks(draft, entries));
    },
    { original: false, env },
  );
  let next = m;
  for (const e of entries) next = dropHookEntry(next, res.real, e.event);
  try {
    writeManifest(res.changed ? noteWrite(next, res.real, res.beforeHash, res.afterHash) : next, env);
  } catch (err) {
    if (res.changed) rollbackPatch(file, res, env);
    throw err;
  }
  return { ...state, backup: res.backup, changed: res.changed };
}
