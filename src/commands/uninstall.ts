import fs from 'node:fs';
import path from 'node:path';
import { claudeSettingsPath, configDir } from '../core/paths.js';
import { type RemovedHooks, removedLists, removeOwnedHooks } from './hooks-install.js';
import {
  classify,
  legacyBackup,
  legacyPrevious,
  noOriginal,
  openManifest,
  statusLineOf,
} from './install-owner.js';
import type { StatusLineSetting } from './install-target.js';
import {
  deepEqual,
  dropEntry,
  dropHookEntry,
  findHookEntries,
  findStatusLineEntry,
  findSubagentLineEntry,
  type HookEntry,
  noteWrite,
  ownedEqual,
  type StatusLineEntry,
  type SubagentLineEntry,
  updateManifest,
} from './manifest.js';
import {
  deleteSettingsFile,
  hashBytes,
  patchSettings,
  readSettings,
  writeSettingsBytes,
} from './settings-file.js';

export type UninstallStatus =
  | 'restored-exact'
  | 'restored-previous'
  | 'removed'
  | 'deleted-file'
  | 'foreign'
  | 'gone-restored'
  | 'gone-nothing'
  | 'not-installed';

export type SubagentOut = 'removed' | 'restored' | 'kept' | null;

export interface UninstallResult {
  status: UninstallStatus;
  file: string;
  removed: boolean;
  restored: StatusLineSetting | null;
  current?: StatusLineSetting | null;
  hooks: RemovedHooks;
  subagent: SubagentOut;
}

type HooksOut = UninstallResult['hooks'];

const REMOVED = new Set<UninstallStatus>([
  'restored-exact',
  'restored-previous',
  'removed',
  'deleted-file',
  'gone-restored',
]);

function backupBytes(restore: { backup: string; hash: string }, env: NodeJS.ProcessEnv): Buffer | null {
  try {
    const bytes = fs.readFileSync(path.resolve(configDir(env), restore.backup));
    return hashBytes(bytes) === restore.hash ? bytes : null;
  } catch {
    return null;
  }
}

function removeOwnedSubagent(d: Record<string, unknown>, entry: SubagentLineEntry | null): SubagentOut {
  if (!entry) return null;
  if (!ownedEqual(d.subagentStatusLine, entry.value)) return 'kept';
  const prev = entry.previous;
  if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
    d.subagentStatusLine = prev;
    return 'restored';
  }
  delete d.subagentStatusLine;
  return 'removed';
}

// only while the file is byte-identical to our last write
function restoreExact(
  file: string,
  entry: StatusLineEntry,
  hash: string | null,
  env: NodeJS.ProcessEnv,
): UninstallStatus | null {
  const r = entry.restore;
  const opts = noOriginal(env);
  if (!r || !hash || hash !== entry.writtenHash) return null;
  if ('absent' in r) return deleteSettingsFile(file, { ...opts, ifHash: hash }) ? 'deleted-file' : null;
  const bytes = backupBytes(r, env);
  if (!bytes) return null;
  writeSettingsBytes(file, bytes, opts);
  return 'restored-exact';
}

// D-41: one write for statusLine and owned hooks
function restoreKey(
  file: string,
  data: Record<string, unknown>,
  ours: StatusLineSetting,
  previous: StatusLineSetting | null,
  fileExisted: boolean,
  hash: string | null,
  hookEntries: HookEntry[],
  subEntry: SubagentLineEntry | null,
  env: NodeJS.ProcessEnv,
): [UninstallStatus, StatusLineSetting | null, undefined, HooksOut, SubagentOut] {
  const opts = noOriginal(env);
  const { statusLine: _, ...rest } = structuredClone(data);
  const left = removeOwnedHooks(rest, hookEntries);
  const subLeft = removeOwnedSubagent(rest, subEntry);
  const empty = !previous && !fileExisted && Object.keys(rest).length === 0;
  if (empty && deleteSettingsFile(file, { ...opts, ifHash: hash }))
    return ['deleted-file', null, undefined, left, subLeft];
  const state = { raced: false, hooks: left, sub: subLeft };
  patchSettings(
    file,
    (d) => {
      state.hooks = removeOwnedHooks(d, hookEntries);
      state.sub = removeOwnedSubagent(d, subEntry);
      state.raced = !deepEqual(d.statusLine, ours);
      if (state.raced) return;
      if (previous) d.statusLine = previous;
      else delete d.statusLine;
    },
    opts,
  );
  if (state.raced) return ['foreign', null, undefined, state.hooks, state.sub];
  return [previous ? 'restored-previous' : 'removed', previous, undefined, state.hooks, state.sub];
}

export function uninstall(
  file?: string,
  opts: { adoptLegacy?: boolean; env?: NodeJS.ProcessEnv } = {},
): UninstallResult {
  const env = opts.env ?? process.env;
  const target = file ?? claudeSettingsPath(env);
  const m = openManifest(env);
  const cur = readSettings(target);
  const sl = statusLineOf(cur.data);
  const entry = findStatusLineEntry(m, target);
  const hookEntries = findHookEntries(m, target);
  const subEntry = findSubagentLineEntry(m, target);
  const none: HooksOut = { removed: [], kept: [] };
  const patchOpts = noOriginal(env);
  // D-41: owned hooks go on every branch
  let subOut: SubagentOut = null;
  const hooksOnly = (): HooksOut => {
    if (!hookEntries.length && !subEntry) return none;
    let out = none;
    patchSettings(
      target,
      (d) => {
        out = removeOwnedHooks(d, hookEntries);
        subOut = removeOwnedSubagent(d, subEntry);
      },
      patchOpts,
    );
    return out;
  };
  const done = (
    status: UninstallStatus,
    restored: StatusLineSetting | null = null,
    current?: StatusLineSetting | null,
    hooks: HooksOut = none,
    subagent: SubagentOut = subOut,
  ): UninstallResult => {
    if (entry || hookEntries.length || subEntry)
      updateManifest(env, (cur) => {
        let next = entry ? dropEntry(cur, target, 'statusLine') : cur;
        if (subEntry) next = dropEntry(next, target, 'subagentStatusLine');
        for (const h of hookEntries) next = dropHookEntry(next, target, h.event, h.role);
        return next;
      });
    const res: UninstallResult = {
      status,
      file: target,
      removed: REMOVED.has(status),
      restored,
      hooks,
      subagent,
    };
    if (current !== undefined) res.current = current;
    return res;
  };
  if (entry) {
    if (!sl) {
      const prev = entry.previous;
      if (!prev) return done('gone-nothing', null, null, hooksOnly());
      let out = none;
      patchSettings(
        target,
        (d) => {
          out = removeOwnedHooks(d, hookEntries);
          subOut = removeOwnedSubagent(d, subEntry);
          if (!statusLineOf(d)) d.statusLine = prev;
        },
        patchOpts,
      );
      return done('gone-restored', prev, null, out);
    }
    if (!ownedEqual(sl, entry.value)) return done('foreign', null, sl, hooksOnly());
    const exact = restoreExact(target, entry, cur.hash, env);
    // the restore point predates every owned hook
    const all = removedLists(hookEntries);
    const subExact: SubagentOut = subEntry ? (subEntry.previous ? 'restored' : 'removed') : null;
    if (exact)
      return done(exact, exact === 'restored-exact' ? entry.previous : null, undefined, all, subExact);
    return done(
      ...restoreKey(
        target,
        cur.data,
        sl,
        entry.previous,
        entry.fileExisted,
        cur.hash,
        hookEntries,
        subEntry,
        env,
      ),
    );
  }
  if (!sl) return done('not-installed', null, null, hooksOnly());
  const owner = classify(m, target, sl, null);
  if (owner === 'legacy-ours' || (owner === 'legacy-ask' && opts.adoptLegacy)) {
    const previous = legacyPrevious(target, null);
    const existed = legacyBackup(target) !== null;
    return done(...restoreKey(target, cur.data, sl, previous, existed, cur.hash, hookEntries, subEntry, env));
  }
  return done('foreign', null, sl, hooksOnly());
}

export function uninstallSubagentLine(
  file = claudeSettingsPath(),
  env: NodeJS.ProcessEnv = process.env,
): { subagent: SubagentOut; backup: string | null; changed: boolean } {
  const entry = findSubagentLineEntry(openManifest(env), file);
  if (!entry) return { subagent: null, backup: null, changed: false };
  let out: SubagentOut = null;
  const res = patchSettings(
    file,
    (d) => {
      out = removeOwnedSubagent(d, entry);
    },
    noOriginal(env),
  );
  updateManifest(env, (cur) => {
    const next = dropEntry(cur, file, 'subagentStatusLine');
    return res.changed ? noteWrite(next, file, res.beforeHash, res.afterHash) : next;
  });
  return { subagent: out, backup: res.backup, changed: res.changed };
}
