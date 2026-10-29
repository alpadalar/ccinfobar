import type { CatalogEntry, EntryContent, EntryKind } from '../../catalog/model.js';
import type { Setup } from '../../commands/install.js';
import type { StyleHistory } from '../../core/edit.js';
import type { LanguageId } from '../../core/i18n/languages.js';
import type { PreviewSource } from '../../core/preview.js';
import type { Config } from '../../core/types.js';
import type { EditorOptions, Found, HooksInfo, LoginFlows, Market, PlanItem, Skip } from '../server.js';

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
  ) => Promise<{ m: Market; view: unknown; review: { endpoint: string; plan: PlanItem[] } }>;
  requested: (body: Record<string, unknown>) => {
    cmd: string | null;
    refresh: number | undefined;
    subagents: boolean | undefined;
  };
  resolveCommand: (cmd: string | null) => Promise<string>;
}
