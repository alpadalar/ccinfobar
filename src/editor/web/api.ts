import type { EntryContent, EntryKind, StyleHistory } from '../../core/edit.js';
import '../../core/i18n/lazy.js';
import { en } from '../../core/i18n/en/index.js';
import { lazyMessages } from '../../core/i18n/en/lazy.js';
import { language, languageLocale, type MessageId, type Params, t } from '../../core/i18n/index.js';
import type { Config, ProgressConfig } from '../../core/types.js';
import type {
  ApiState,
  CatalogEntryInfo,
  CatalogResult,
  CatalogState,
  CatalogVersionInfo,
  ClaudeInfo,
  HooksInfo,
  MarketEntryInfo,
  MarketSummaryInfo,
  PresetInfo,
  PublishPlanInfo,
  PublishResultInfo,
  Store,
  ThemeInfo,
} from './store.js';

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

export interface CatalogSaveBody {
  kind: EntryKind;
  name: string;
  description: string;
  author?: string;
  share?: boolean;
  mode: 'new' | 'update' | 'overwrite';
  note?: string;
  id?: string;
  rev?: number;
  config: Config;
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

export function setToken(value: string): void {
  token = value;
}

// server ids; an unknown id keeps the English text
export function idText(id: unknown, params: unknown, fallback: string): string {
  if (typeof id !== 'string' || !(Object.hasOwn(en, id) || Object.hasOwn(lazyMessages, id))) return fallback;
  const p: Params = Object.create(null);
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params)) if (typeof v === 'string' || typeof v === 'number') p[k] = v;
  }
  // catalog errors carry the raw kind id
  const kind = p.kind;
  if (id.startsWith('err.catalog.') && (kind === 'preset' || kind === 'theme' || kind === 'bundle'))
    p.kind = t(`catalog.kind.${kind}`).toLocaleLowerCase(languageLocale());
  return t(id as MessageId, p);
}

export function apiErrorText(body: Record<string, unknown> | null, status: number): string {
  const error = typeof body?.error === 'string' ? body.error : `HTTP ${status}`;
  return idText(body?.errorId, body?.errorParams, error);
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
    throw new ApiError(res.status, apiErrorText(body, res.status), body);
  }
  return data as T;
}

const lang = () => encodeURIComponent(language());
const entryPath = (ref: string) => `/api/catalog/entries/${encodeURIComponent(ref)}?lang=${lang()}`;

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
  progress: (enabled: boolean, channel?: ProgressConfig['channel']) =>
    call<{
      ok: boolean;
      hooks: HooksInfo;
      backup: string | null;
      progress: ProgressConfig | null;
      held: boolean;
    }>('POST', '/api/progress', channel ? { enabled, channel } : { enabled }),
  update: (install: boolean) =>
    call<{ current: string; latest: string; newer: boolean; kind: string; installed?: string }>(
      'POST',
      '/api/update',
      { install },
    ),
  saveStyles: (history: StyleHistory) => call<{ ok: boolean }>('PUT', '/api/styles', { history }),
  shutdown: () => call<{ ok: boolean }>('POST', '/api/shutdown', {}),
  catalog: () => call<CatalogState>('GET', `/api/catalog?lang=${lang()}`),
  catalogEntry: (ref: string) =>
    call<{ entry: CatalogEntryInfo; versions: CatalogVersionInfo[] }>('GET', entryPath(ref)),
  catalogPreviews: (config: Config, src: PreviewSrc, width: number, refs?: string[]) =>
    call<{ previews: Record<string, string[]> }>('POST', '/api/catalog/previews', {
      config,
      ...src,
      width,
      refs,
      lang: language(),
    }),
  catalogSave: (body: CatalogSaveBody) =>
    call<CatalogResult>('POST', '/api/catalog/save', { ...body, lang: language() }),
  catalogRestore: (id: string, version: number, rev: number | null) =>
    call<CatalogResult>('POST', '/api/catalog/restore', { id, version, rev, lang: language() }),
  catalogShare: (ref: string, share: boolean, rev?: number | null) =>
    call<CatalogResult>('POST', '/api/catalog/share', { ref, share, rev, lang: language() }),
  catalogDelete: (ref: string) => call<{ ok: boolean; catalog: CatalogState }>('DELETE', entryPath(ref)),
  catalogInstallTheme: (ref: string, version?: number) =>
    call<{
      ok: boolean;
      theme: { id: string; written: boolean; renamed: boolean } | null;
      themes: ThemeInfo[];
    }>('POST', '/api/catalog/install-theme', { ref, version }),
  catalogPublishPlan: (refs?: string[]) =>
    call<PublishPlanInfo>('POST', '/api/catalog/publish/plan', { refs }),
  catalogPublish: (refs: string[] | undefined, planHash: string) =>
    call<{
      ok: boolean;
      code: 'read-only' | null;
      submitUrl?: string;
      results: PublishResultInfo[];
      catalog: CatalogState;
    }>('POST', '/api/catalog/publish', { refs, confirm: true, planHash, lang: language() }),
  catalogRemote: () => call<{ endpoint: string; entries: MarketSummaryInfo[] }>('GET', '/api/catalog/remote'),
  // <publisher>/<slug>, each part encoded
  catalogRemoteEntry: (id: string) =>
    call<{
      entry: MarketEntryInfo;
      latest: { version: number; content: EntryContent; targets: { kind: string; target: string }[] } | null;
      code?: string;
      errorId?: string;
    }>('GET', `/api/catalog/remote/${id.split('/').map(encodeURIComponent).join('/')}`),
};
