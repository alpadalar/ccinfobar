import type { Config } from '../../core/types.js';
import type { ApiState, ClaudeInfo, ThemeInfo } from './store.js';

let token = '';

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
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  state: () => call<ApiState>('GET', '/api/state'),
  preview: (config: Config, source: string, width: number) =>
    call<{ lines: string[] }>('POST', '/api/preview', { config, source, width }),
  save: (config: Config) => call<{ ok: boolean; config: Config }>('PUT', '/api/config', { config }),
  normalize: (config: unknown) => call<{ config: Config }>('POST', '/api/normalize', { config }),
  install: (command: string, refreshInterval?: number) =>
    call<{ ok: boolean; backup: string | null; claude: ClaudeInfo }>('POST', '/api/install', {
      command,
      refreshInterval,
    }),
  themePreviews: (config: Config, source: string, width: number) =>
    call<{ previews: Record<string, string[]> }>('POST', '/api/theme-previews', { config, source, width }),
  saveTheme: (theme: Record<string, unknown>, fromConfig?: Config) =>
    call<{ ok: boolean; id: string; themes: ThemeInfo[] }>('POST', '/api/themes', { theme, fromConfig }),
  deleteTheme: (id: string) =>
    call<{ ok: boolean; themes: ThemeInfo[] }>('DELETE', `/api/themes/${encodeURIComponent(id)}`),
  shutdown: () => call<{ ok: boolean }>('POST', '/api/shutdown', {}),
};
