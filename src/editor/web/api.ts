import type { StyleHistory } from '../../core/edit.js';
import type { Config } from '../../core/types.js';
import type { ApiState, ClaudeInfo, HooksInfo, PresetInfo, Store, ThemeInfo } from './store.js';

export type PreviewSrc = { source: 'sample' | 'last' | 'scenario'; scenario?: string };

export function previewSource(S: Pick<Store, 'source' | 'scenario'>): PreviewSrc {
  return S.source === 'scenario' && S.scenario
    ? { source: 'scenario', scenario: S.scenario }
    : { source: S.source === 'last' ? 'last' : 'sample' };
}

export interface InstallPlanInfo {
  current: { command?: unknown; refreshInterval?: number } | null;
  proposed: { command: string; refreshInterval?: number };
  owner: string;
  needsConfirm: boolean;
  changes: boolean;
}

let token = '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

export function setToken(t: string): void {
  token = t;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-ccinfobar-token': token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const msg = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, body);
  }
  return data as T;
}

export const api = {
  state: () => call<ApiState>('GET', '/api/state'),
  preview: (config: Config, src: PreviewSrc, width: number, theme?: Record<string, unknown>) =>
    call<{ lines: string[]; hidden: string[]; dropped?: string[] }>('POST', '/api/preview', {
      config,
      ...src,
      width,
      theme,
    }),
  save: (config: Config) => call<{ ok: boolean; config: Config }>('PUT', '/api/config', { config }),
  normalize: (config: unknown) => call<{ config: Config }>('POST', '/api/normalize', { config }),
  installPlan(command: string, refreshInterval?: number) {
    return call<{ plan: InstallPlanInfo }>('POST', '/api/install/plan', { command, refreshInterval });
  },
  install: (command: string, refreshInterval?: number, confirm?: boolean, current?: unknown) =>
    call<{ ok: boolean; backup: string | null; backupsDir: string; claude: ClaudeInfo }>(
      'POST',
      '/api/install',
      { command, refreshInterval, ...(confirm ? { confirm: true, current: current ?? null } : {}) },
    ),
  themePreviews: (config: Config, src: PreviewSrc, width: number) =>
    call<{ previews: Record<string, string[]> }>('POST', '/api/theme-previews', { config, ...src, width }),
  saveTheme: (theme: Record<string, unknown>, fromConfig?: Config) =>
    call<{ ok: boolean; id: string; themes: ThemeInfo[] }>('POST', '/api/themes', { theme, fromConfig }),
  deleteTheme: (id: string) =>
    call<{ ok: boolean; themes: ThemeInfo[] }>('DELETE', `/api/themes/${encodeURIComponent(id)}`),
  savePreset: (preset: { id: string; name: string; description: string }, config: Config) =>
    call<{ ok: boolean; presets: PresetInfo[] }>('POST', '/api/presets', { preset, config }),
  deletePreset: (id: string) =>
    call<{ ok: boolean; presets: PresetInfo[] }>('DELETE', `/api/presets/${encodeURIComponent(id)}`),
  system: () =>
    call<{
      version: string;
      kind: string;
      update: { checkedAt: number; latest: string | null; error?: string } | null;
      claude: ClaudeInfo;
      hooks: HooksInfo;
    }>('GET', '/api/system'),
  hooks: (enabled: boolean, permission?: boolean) =>
    call<{ ok: boolean; hooks: HooksInfo; backup: string | null }>('POST', '/api/hooks', {
      enabled,
      permission,
    }),
  update: (install: boolean) =>
    call<{ current: string; latest: string; newer: boolean; kind: string; installed?: string }>(
      'POST',
      '/api/update',
      { install },
    ),
  saveStyles: (history: StyleHistory) => call<{ ok: boolean }>('PUT', '/api/styles', { history }),
  shutdown: () => call<{ ok: boolean }>('POST', '/api/shutdown', {}),
};
