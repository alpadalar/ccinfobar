import type { EntryContent, EntryKind, StyleHistory } from '../../core/edit.js';
import '../../core/i18n/lazy.js';
import { en } from '../../core/i18n/en/index.js';
import { lazyMessages } from '../../core/i18n/en/lazy.js';
import { language, languageLocale, type MessageId, type Params, t } from '../../core/i18n/index.js';
import type { Config, ProgressConfig } from '../../core/types.js';
import type { ImportTarget } from '../../importers/confirm.js';
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

export interface LoginStartInfo {
  flow: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface LoginStatusInfo {
  status: 'pending' | 'ok' | 'expired' | 'denied' | 'disabled' | 'failed' | 'cancelled';
  handle?: string;
  admin?: boolean;
  code?: string;
  errorId?: string;
  errorParams?: { status?: number };
}

export interface MarketTarget {
  kind: string;
  target: string;
}

export interface RemoteListInfo {
  endpoint: string;
  entries: MarketSummaryInfo[];
  checkedAt: string | null;
  stale?: boolean;
  partial?: boolean;
}

// what the editor server would install; nothing is written yet
export interface MarketInstallPlanInfo {
  id: string;
  version: number;
  hash: string;
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  publisher: string;
  targets: MarketTarget[];
  existing: { entryId: string; same: boolean } | null;
  cols?: number | null;
}

export interface MarketInstallInfo {
  ok: boolean;
  entryId: string;
  name: string;
  result: 'new' | 'version' | 'same';
  catalog: CatalogState;
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
  cols?: number;
  config: Config;
}

export interface ShareInfo {
  code: string;
  chars: number;
  max: number;
  included: boolean;
  targets: MarketTarget[];
  dropped: MarketTarget[];
}

export interface ShareOpenInfo {
  code: string;
  content: EntryContent;
  cols: number | null;
  targets: ImportTarget[];
  unsafe: ImportTarget[];
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

const goneHandlers: Array<() => void> = [];

export function onServerGone(fn: () => void): void {
  goneHandlers.push(fn);
}

export const GONE_RETRY_MS = 1000;

let confirming: Promise<boolean> | null = null;
let gone = false;

function confirmGone(): Promise<boolean> {
  confirming ??= new Promise<void>((resolve) => setTimeout(resolve, GONE_RETRY_MS))
    .then(() => fetch('/api/ping', { headers: { 'x-ccinfobar-token': token } }))
    .then(
      (r) => r.ok,
      () => false,
    )
    .finally(() => {
      confirming = null;
    });
  return confirming;
}

async function call<T>(method: string, path: string, body?: unknown, boot = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'x-ccinfobar-token': token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    // the first load shows the raw network error
    if (boot) throw err;
    if (await confirmGone()) throw new ApiError(0, t('web.app.networkError'), null);
    if (!gone) {
      gone = true;
      for (const fn of goneHandlers) fn();
    }
    throw new ApiError(0, t('web.app.stopped'), null);
  }
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
  ping: () => call<{ ok: boolean }>('GET', '/api/ping'),
  state: (boot = false) => call<ApiState>('GET', '/api/state', undefined, boot),
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
  catalogDelete: (ref: string) =>
    call<{ ok: boolean; kept?: string | null; catalog: CatalogState }>('DELETE', entryPath(ref)),
  catalogInstallTheme: (ref: string, version?: number) =>
    call<{
      ok: boolean;
      theme: { id: string; written: boolean; renamed: boolean } | null;
      themes: ThemeInfo[];
    }>('POST', '/api/catalog/install-theme', { ref, version }),
  share: (config: Config, includeCommands: boolean, cols?: number) =>
    call<ShareInfo>('POST', '/api/share', { config, includeCommands, cols }),
  shareOpen: (code: string) => call<ShareOpenInfo>('POST', '/api/share/open', { code }),
  shareInstallTheme: (code: string) =>
    call<{
      ok: boolean;
      theme: { id: string; written: boolean; renamed: boolean } | null;
      themes: ThemeInfo[];
    }>('POST', '/api/share/install-theme', { code }),
  catalogPublishPlan: (refs?: string[]) =>
    call<PublishPlanInfo>('POST', '/api/catalog/publish/plan', { refs }),
  catalogPublisher: (handle: string, refs?: string[]) =>
    call<PublishPlanInfo>('POST', '/api/catalog/publisher', { handle, refs }),
  catalogPublish: (refs: string[] | undefined, planHash: string) =>
    call<{
      ok: boolean;
      code: 'read-only' | null;
      submitUrl?: string;
      results: PublishResultInfo[];
      catalog: CatalogState;
    }>('POST', '/api/catalog/publish', { refs, confirm: true, planHash, lang: language() }),
  loginStart: () => call<LoginStartInfo>('POST', '/api/catalog/login', {}),
  loginStatus: (flow: string) =>
    call<LoginStatusInfo>('GET', `/api/catalog/login/${encodeURIComponent(flow)}`),
  loginCancel: (flow: string) =>
    call<{ status: string }>('DELETE', `/api/catalog/login/${encodeURIComponent(flow)}`),
  logout: () =>
    call<{ ok: boolean; signedOut: boolean; catalog: CatalogState }>(
      'POST',
      `/api/catalog/logout?lang=${lang()}`,
      {},
    ),
  // the 24 h cache; refresh sends one conditional request
  catalogRemote: (refresh?: boolean) =>
    call<RemoteListInfo>('GET', `/api/catalog/remote${refresh ? '?refresh=1' : ''}`),
  // cached versions; asked only when a marketplace tab shows
  catalogRemotePreviews: (config: Config, src: PreviewSrc, width: number, ids: string[]) =>
    call<{ previews: Record<string, string[]> }>('POST', '/api/catalog/remote/previews', {
      config,
      ...src,
      width,
      ids,
      lang: language(),
    }),
  catalogInstallPlan: (id: string, version?: number) =>
    call<MarketInstallPlanInfo>('POST', '/api/catalog/install/plan', { id, version }),
  // only the reviewed hash and targets install
  catalogInstall: (plan: { id: string; version: number; hash: string; targets: MarketTarget[] }) =>
    call<MarketInstallInfo>('POST', '/api/catalog/install', {
      id: plan.id,
      version: plan.version,
      hash: plan.hash,
      targets: plan.targets.map((x) => ({ kind: x.kind, target: x.target })),
      lang: language(),
    }),
  catalogReport: (id: string, reason: string) =>
    call<{ reported: boolean; already?: boolean; report?: number }>('POST', '/api/catalog/report', {
      id,
      reason,
    }),
  // <publisher>/<slug>, each part encoded
  catalogRemoteEntry: (id: string) =>
    call<{
      entry: MarketEntryInfo;
      latest: { version: number; content: EntryContent; targets: MarketTarget[] } | null;
      code?: string;
      errorId?: string;
      errorParams?: { status?: number };
    }>('GET', `/api/catalog/remote/${id.split('/').map(encodeURIComponent).join('/')}`),
};
