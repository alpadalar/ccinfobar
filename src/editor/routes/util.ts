import '../../core/i18n/lazy.js';
import type http from 'node:http';
import { ENTRY_ID_RE, type EntryContent, type EntryKind, latest } from '../../catalog/model.js';
import { shareState } from '../../catalog/share.js';
import type { CatalogStoreError, StoreCode } from '../../catalog/store.js';
import type { SystemEntry } from '../../catalog/system.js';
import { hookEntryState } from '../../commands/hooks-doctor.js';
import {
  DEFAULT_EVENTS,
  HOOK_FLOOR,
  type HookRefusal,
  OPTIONAL_EVENTS,
} from '../../commands/hooks-install.js';
import { currentStatusLine, currentSubagentLine, type StatusLineSetting } from '../../commands/install.js';
import { classifyOwner, findHookEntries, owns, readManifest } from '../../commands/manifest.js';
import { readSettings } from '../../commands/settings-file.js';
import { bundleText, presetText, themeDescription } from '../../core/i18n/catalog-text.js';
import { type MessageId, type Params, t, withLanguage } from '../../core/i18n/index.js';
import { ID_RE } from '../../core/ids.js';
import { claudeSettingsPath, tildify } from '../../core/paths.js';
import type { PreviewSource } from '../../core/preview.js';
import { sanitizeText } from '../../core/sanitize.js';
import { getScenario } from '../../core/scenarios.js';
import { parseThemeInput, resolveThemeInput, type Theme } from '../../core/themes.js';
import { PROGRESS_EVENTS } from '../../data/progress.js';
import type { EntrySummary, Found } from './ctx.js';

declare const __VERSION__: string;

export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

export const MAX_BODY = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
    readonly id?: MessageId,
    readonly params?: Params,
  ) {
    super(message);
  }
}

export type Text = { id: MessageId; params?: Params };

export const english = (m: Text): string => withLanguage('en', () => t(m.id, m.params));

// the browser shows t(errorId, errorParams); error stays English
export function httpError(
  status: number,
  id: MessageId,
  params?: Params,
  extra?: Record<string, unknown>,
): HttpError {
  return new HttpError(status, english({ id, ...(params ? { params } : {}) }), extra, id, params);
}

export function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(httpError(413, 'err.server.tooLarge'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'err.server.badJson'));
      }
    });
    req.on('error', reject);
  });
}

// manifest ownership, not a substring
export function isInstalled(statusLine: StatusLineSetting | null, command: string | null): boolean {
  if (!statusLine) return false;
  try {
    const m = readManifest();
    const file = claudeSettingsPath();
    return owns(m, file, statusLine) || classifyOwner(m, file, statusLine, command) === 'legacy-ours';
  } catch {
    return false;
  }
}

export function claudeInfo(command: string | null) {
  let statusLine: StatusLineSetting | null = null;
  try {
    statusLine = currentStatusLine();
  } catch {}
  let subagent: { command: string; owned: boolean } | null = null;
  try {
    subagent = currentSubagentLine();
  } catch {}
  return {
    statusLine,
    installed: isInstalled(statusLine, command),
    defaultCommand: command ?? placeholder(),
    settingsFile: tildify(claudeSettingsPath()),
    subagent,
  };
}

// statusLine command when ccinfobar owns it
export function activeCommand(command: string | null): string | null {
  try {
    const sl = currentStatusLine();
    return isInstalled(sl, command) && typeof sl?.command === 'string' && sl.command.trim()
      ? sl.command
      : null;
  } catch {
    return null;
  }
}

export const ORDER: readonly string[] = [...DEFAULT_EVENTS, ...OPTIONAL_EVENTS, ...PROGRESS_EVENTS];

export function installedHooks(progress = false): string[] {
  try {
    const file = claudeSettingsPath();
    const data = readSettings(file).data as Record<string, unknown>;
    return findHookEntries(readManifest(), file)
      .filter((e) => (progress ? e.role === 'progress' : !e.role) && hookEntryState(e, data) === 'ok')
      .map((e) => e.event)
      .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  } catch {
    return [];
  }
}

export function refusalText(refused: HookRefusal, version: string | null): Text {
  return refused === 'unknown-version'
    ? { id: 'hooks.reason.unknownVersion', params: { floor: HOOK_FLOOR.core } }
    : { id: 'hooks.reason.oldVersion', params: { floor: HOOK_FLOOR.core, version: version ?? '' } };
}

export function progressRefusalText(refused: HookRefusal, version: string | null): Text {
  const floor = HOOK_FLOOR.terminalSequence;
  return refused === 'unknown-version'
    ? { id: 'progress.refused.unknownVersion', params: { floor } }
    : { id: 'progress.refused.oldVersion', params: { floor, version: version ?? '' } };
}

export const NOT_ACTIVE: Text = { id: 'hooks.reason.notActive' };

export const reasonOf = (m: Text) => ({
  reason: english(m),
  reasonId: m.id,
  ...(m.params ? { reasonParams: m.params } : {}),
});

export const textError = (status: number, m: Text, extra?: Record<string, unknown>): HttpError =>
  httpError(status, m.id, m.params, extra);

export const PLACEHOLDER_PREFIX = 'ccinfobar (';
export const placeholder = () => `${PLACEHOLDER_PREFIX}installed on first Install)`;

export function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export function previewSourceOf(body: Record<string, unknown>): PreviewSource {
  if (body.source === 'last') return 'last';
  if (body.source === 'scenario' && typeof body.scenario === 'string' && getScenario(body.scenario)) {
    return { scenario: body.scenario };
  }
  return 'sample';
}

export const KINDS: readonly EntryKind[] = ['bundle', 'preset', 'theme'];
export const LEGACY_RE = /^legacy:(?:preset|theme)\/(.*)$/;
export const SYSTEM_RE = /^(?:bundle|preset|theme)\/(.*)$/;

export const MAX_PUBLISH_REFS = 500;

// market codes; read failures are a bad gateway
export function marketError(code: string | null, id: MessageId, status?: number): HttpError {
  if (code === 'no-endpoint') return httpError(409, 'err.catalog.noEndpoint');
  const http =
    code === 'not-found'
      ? 404
      : code === 'handle-taken'
        ? 409
        : code === 'bad-endpoint'
          ? 400
          : code === 'sign-in'
            ? 401
            : 502;
  return httpError(http, id, status === undefined ? undefined : { status }, { code });
}

export const clean = (v: unknown): string => sanitizeText(typeof v === 'string' ? v : '');

export function refType(ref: unknown): Found['source'] | null {
  if (typeof ref !== 'string') return null;
  if (ENTRY_ID_RE.test(ref)) return 'user';
  const legacy = LEGACY_RE.exec(ref);
  if (legacy && ID_RE.test(legacy[1]!)) return 'legacy';
  const system = SYSTEM_RE.exec(ref);
  return system && ID_RE.test(system[1]!) ? 'system' : null;
}

export const refOf = (a: Found): string =>
  a.source === 'user' ? a.entry.id : a.source === 'legacy' ? a.item.ref : a.entry.ref;
export const entryKind = (a: Found): EntryKind => (a.source === 'legacy' ? a.item.kind : a.entry.kind);

export function contentOf(a: Found): EntryContent {
  if (a.source === 'user') return latest(a.entry).content;
  return a.source === 'legacy' ? a.item.content : a.entry.content;
}

export function systemText(e: SystemEntry, field: 'name' | 'description'): string {
  if (e.kind === 'bundle') return bundleText(e, field);
  if (e.kind === 'preset') return presetText(e, field);
  return field === 'name' ? e.name : themeDescription(e);
}

export const colsOf = (a: Found): number | undefined =>
  a.source === 'user' ? latest(a.entry).cols : undefined;

export function summaryOf(a: Found): EntrySummary {
  const base = { ref: refOf(a), source: a.source, kind: entryKind(a), content: contentOf(a) };
  if (a.source === 'user') {
    const e = a.entry;
    const remote = e.share.remote;
    return {
      ...base,
      id: e.id,
      name: clean(e.name),
      description: clean(e.description),
      author: clean(e.author),
      version: e.version,
      rev: e.rev,
      share: { wanted: e.share.wanted, state: shareState(e) },
      remote: remote
        ? {
            id: clean(remote.id),
            version: remote.version,
            ...(remote.review === 'pending' ? { review: 'pending' as const } : {}),
          }
        : null,
      origin: e.origin
        ? { endpoint: clean(e.origin.endpoint), id: clean(e.origin.id), version: e.origin.version }
        : null,
      updatedAt: e.updatedAt,
      scenario: null,
      cols: latest(e).cols ?? null,
    };
  }
  const fixed = {
    version: 1,
    rev: null,
    share: null,
    remote: null,
    origin: null,
    updatedAt: null,
    cols: null,
  };
  if (a.source === 'legacy') {
    const i = a.item;
    return {
      ...base,
      ...fixed,
      id: i.legacyId,
      name: clean(i.name),
      description: clean(i.description),
      author: clean(i.author),
      scenario: null,
    };
  }
  const e = a.entry;
  return {
    ...base,
    ...fixed,
    id: e.id,
    name: clean(systemText(e, 'name')),
    description: clean(systemText(e, 'description')),
    author: e.author,
    scenario: e.scenario ?? null,
  };
}

export function versionsOf(a: Found) {
  if (a.source !== 'user')
    return [
      { version: 1, at: null, note: '', restoredFrom: null, overwrittenAt: null, content: contentOf(a) },
    ];
  return a.entry.versions.map((v) => ({
    version: v.version,
    at: v.at,
    note: clean(v.note),
    restoredFrom: v.restoredFrom ?? null,
    overwrittenAt: v.overwrittenAt ?? null,
    content: v.content,
  }));
}

// the same draft path as POST /api/preview; nothing is installed
export function draftTheme(raw: unknown): Theme | undefined {
  try {
    const input = parseThemeInput(raw);
    if (input.extends !== undefined && !ID_RE.test(input.extends)) delete input.extends;
    return resolveThemeInput(input);
  } catch {
    return undefined;
  }
}

export const STORE_ERRORS: Record<StoreCode, [number, MessageId]> = {
  exists: [409, 'err.catalog.exists'],
  changed: [409, 'err.catalog.changed'],
  'too-large': [413, 'err.catalog.tooLarge'],
  'not-found': [404, 'err.catalog.unknownRef'],
  'bad-id': [400, 'err.catalog.badId'],
  'bad-name': [400, 'err.catalog.badName'],
  'bad-content': [400, 'err.catalog.badContent'],
  'bad-endpoint': [400, 'err.catalog.badEndpoint'],
  'no-version': [404, 'err.catalog.noVersion'],
  busy: [409, 'err.catalog.busy'],
  reserved: [409, 'catalog.publish.reserved'],
  installed: [409, 'err.catalog.installed'],
};

export function storeError(err: CatalogStoreError, kind = ''): HttpError {
  const d = err.data;
  const [status, id] = STORE_ERRORS[err.code];
  const ref = clean(d.ref ?? d.id ?? d.name);
  const version = typeof d.version === 'number' ? d.version : undefined;
  if (err.code === 'exists') {
    const name = clean(d.name);
    return httpError(
      status,
      id,
      { kind, name, version: version ?? '' },
      { exists: { id: d.id, version, name } },
    );
  }
  if (err.code === 'not-found') return httpError(status, id, { ref });
  if (err.code === 'no-version') return httpError(status, id, { ref, version: version ?? '' });
  if (err.code === 'reserved') return httpError(status, id, { name: clean(d.name) });
  return httpError(status, id);
}
