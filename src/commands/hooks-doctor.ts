import fs from 'node:fs';
import path from 'node:path';
import { managedSettingsFiles as coreManagedFiles } from '../core/paths.js';
import { deepEqual, type HookEntry } from './manifest.js';

export interface SettingsLayer {
  name: 'user' | 'project' | 'local' | 'managed';
  file: string;
  data: Record<string, unknown> | null;
}

export interface HookWarning {
  key: 'doctor.hooks.disableAll' | 'doctor.hooks.managedOnly';
  params: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const envOf = (env: NodeJS.ProcessEnv, key: string, win: boolean): string | undefined => {
  if (!win) return env[key];
  const k = Object.keys(env).find((x) => x.toUpperCase() === key.toUpperCase());
  return k === undefined ? undefined : env[k];
};

const listDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

export function managedSettingsFiles(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  list: (dir: string) => string[] = listDir,
): string[] {
  return coreManagedFiles(platform, env, list);
}

export function readSettingsLayer(name: SettingsLayer['name'], file: string): SettingsLayer {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const raw: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return { name, file, data: isObj(raw) ? raw : null };
  } catch {
    return { name, file, data: null };
  }
}

// pure
export function hookGateWarnings(layers: SettingsLayer[]): HookWarning[] {
  const out: HookWarning[] = [];
  for (const l of layers) {
    if (l.data?.disableAllHooks === true)
      out.push({ key: 'doctor.hooks.disableAll', params: { layer: l.name, file: l.file } });
  }
  for (const l of layers) {
    if (l.name === 'managed' && l.data?.allowManagedHooksOnly === true)
      out.push({ key: 'doctor.hooks.managedOnly', params: { file: l.file } });
  }
  return out;
}

function tokens(command: string, n: number): string[] {
  const out: string[] = [];
  let s = command.trimStart();
  while (s && out.length < n) {
    const q = s[0];
    if (q === '"' || q === "'") {
      const end = s.indexOf(q, 1);
      if (end < 0) {
        out.push(s.slice(1));
        break;
      }
      out.push(s.slice(1, end));
      s = s.slice(end + 1).trimStart();
    } else {
      const m = /^\S+/.exec(s) as RegExpExecArray;
      out.push(m[0]);
      s = s.slice(m[0].length).trimStart();
    }
  }
  return out;
}

// never spawns
export function commandResolves(
  command: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {},
): boolean {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const [first, second] = tokens(command, 2);
  if (!first) return false;
  const bare = !/[\\/]/.test(first) && !(win && /^[A-Za-z]:/.test(first));
  let found: boolean;
  if (p.isAbsolute(first)) found = exists(first);
  else if (bare) {
    const dirs = (envOf(env, 'PATH', win) ?? '').split(win ? ';' : ':').filter(Boolean);
    const exts = win
      ? ['', ...(envOf(env, 'PATHEXT', true) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
    found = dirs.some((d) => exts.some((x) => exists(p.join(d, first + x))));
  } else return true;
  if (!found) return false;
  const name = p.basename(first).toLowerCase();
  if ((name === 'node' || name === 'node.exe') && second && p.isAbsolute(second)) return exists(second);
  return true;
}

export function hookEntryState(entry: HookEntry, settings: Record<string, unknown>): 'ok' | 'edited' {
  const hooks = settings.hooks;
  const list = isObj(hooks) && Object.hasOwn(hooks, entry.event) ? hooks[entry.event] : null;
  return Array.isArray(list) && list.some((g) => deepEqual(g, entry.value)) ? 'ok' : 'edited';
}

export function entryCommand(entry: HookEntry): string | null {
  const v = entry.value;
  const h = isObj(v) && Array.isArray(v.hooks) ? v.hooks[0] : null;
  if (!isObj(h) || typeof h.command !== 'string') return null;
  return h.command.replace(/\s+hook\s+[A-Za-z]+\s*$/, '');
}
