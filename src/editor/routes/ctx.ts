import type { CatalogEntry, EntryContent, EntryKind } from '../../catalog/model.js';
import type { LegacyItem } from '../../catalog/store.js';
import type { SystemEntry } from '../../catalog/system.js';
import type { Setup } from '../../commands/install.js';
import type { InstallKind } from '../../commands/update.js';
import type { StyleHistory } from '../../core/edit.js';
import type { MessageId, Params } from '../../core/i18n/index.js';
import type { LanguageId } from '../../core/i18n/languages.js';
import type { PreviewSource } from '../../core/preview.js';
import type { Config } from '../../core/types.js';
import type { CheckDeps, Verify } from '../../data/self-update.js';
import type { TerminalColors } from '../terminal-colors.js';

export interface EditorOptions {
  configPath: string;
  port?: number | undefined;
  open?: boolean;
  host?: string;
  terminal?: TerminalColors | null;
  setup?: (version: string) => Promise<Setup>;
  claudeVersion?: () => string | null | Promise<string | null>;
  installKind?: () => InstallKind;
  fetchLatest?: (timeoutMs: number) => Promise<string>;
  update?: { install?: CheckDeps['install']; verify?: Verify };
  detached?: { idleMs: number; stateFile: string; checkMs?: number; now?: () => number };
  // a decoded share code; the page opens it from #c=
  share?: string;
  // tests inject the network and the clock of marketplace and GitHub calls
  market?: {
    fetch?: typeof fetch;
    now?: () => number;
    defaultEndpoint?: string | null;
  };
}

export interface HooksInfo {
  installed: string[];
  available: boolean;
  reason?: string;
  reasonId?: MessageId;
  reasonParams?: Params;
  claudeCode?: string;
  events: string[];
  optional: string[];
  progress: string[];
}

export type Found =
  | { source: 'user'; entry: CatalogEntry }
  | { source: 'legacy'; item: LegacyItem }
  | { source: 'system'; entry: SystemEntry };

export interface EntrySummary {
  ref: string;
  source: Found['source'];
  id: string;
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  version: number;
  rev: number | null;
  share: { wanted: boolean; state: string } | null;
  remote: { id: string; version: number; review?: 'pending' } | null;
  // where a marketplace install came from
  origin: { endpoint: string; id: string; version: number } | null;
  updatedAt: string | null;
  scenario: string | null;
  // the author's preview width
  cols: number | null;
  content: EntryContent;
}

export type Market = typeof import('../../commands/catalog-market.js');
export type LoginFlows = ReturnType<Market['createLoginFlows']>;
export type InstallPlan = Awaited<ReturnType<Market['planInstall']>>;
export type PlanItem = ReturnType<Market['publishPlan']>[number];
export type PublishReview = Awaited<ReturnType<Market['reviewPublish']>> & {
  endpoint: string;
  plan: PlanItem[];
};
export type PublishView = Record<string, unknown> & { planHash: string };
export type Skip = { id: string; reason: 'not-shared' | 'up-to-date' | 'withdrawn' };

export interface EditorState {
  command: string | null;
  flows: LoginFlows | null;
}

export interface EditorCtx {
  opts: EditorOptions;
  state: EditorState;
  gsd: boolean;
  auto: { id: LanguageId };
  now: () => number;
  setup: (version: string) => Promise<Setup>;
  close: () => Promise<void>;
  claudeVersion: () => Promise<string | null>;
  hooksInfo: (cmd: string | null) => Promise<HooksInfo>;
  stylesFile: string;
  readStyles: () => StyleHistory;
  presetList: () => unknown[];
  uiLang: (hint: unknown, config?: { language?: unknown }) => LanguageId;
  diskLang: (hint: unknown) => LanguageId;
  allEntries: () => Found[];
  findRef: (ref: string) => Found | null;
  mustFind: (ref: string) => Found;
  catalogBody: (lang: LanguageId) => unknown;
  userResult: (e: CatalogEntry, lang: LanguageId) => unknown;
  writableRef: (ref: unknown) => { type: 'user' | 'legacy'; ref: string };
  liveThemes: (id: string) => string[];
  currentRev: (id: string, rev: unknown) => number;
  previewContent: (
    current: Config,
    kind: EntryKind,
    content: EntryContent,
    system: boolean,
    source: PreviewSource,
    width: number,
  ) => string[];
  previewOf: (current: Config, a: Found, source: PreviewSource, width: number) => string[];
  marketFetch: () => typeof fetch;
  marketNow: () => number;
  kindOf: () => InstallKind;
  latestOf: (timeoutMs: number) => Promise<string>;
  loadMarket: () => Promise<Market>;
  needEndpoint: () => string;
  marketDeps: () => {
    fetch: typeof fetch;
    now: () => Date;
    defaultEndpoint: string | null;
  };
  loginFlows: (m: Market) => LoginFlows;
  publishRefs: (refs: unknown) => { ids: string[] | null; skipped: Skip[] };
  publishView: (
    endpoint: string,
    refs: unknown,
  ) => Promise<{ m: Market; view: PublishView; review: PublishReview }>;
  requested: (body: Record<string, unknown>) => {
    cmd: string | null;
    refresh: number | undefined;
    subagents: boolean | undefined;
  };
  resolveCommand: (cmd: string | null) => Promise<string>;
}
