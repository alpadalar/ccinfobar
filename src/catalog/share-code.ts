import zlib from 'node:zlib';
import { normalizeConfig } from '../core/config.js';
import { type EntryContent, LAYOUT_KEYS, parseCols } from '../core/entry-keys.js';
import type { MessageId, Params } from '../core/i18n/index.js';
import { deepSanitize, safeConfigUrl } from '../core/sanitize.js';
import {
  extractCode,
  MAX_CODE_CHARS,
  MAX_JSON_BYTES,
  parseShareDoc,
  SHARE_PREFIX,
} from '../core/share-code.js';
import { BUILTIN_THEMES, DEFAULT_THEME, parseThemeInput } from '../core/themes.js';
import type { Config } from '../core/types.js';
import { dropTargets, type ImportTarget, importTargets } from '../importers/confirm.js';
import { contentFromConfig } from './snapshot.js';

export type EncodeResult =
  | { ok: true; code: string; chars: number; targets: ImportTarget[]; dropped: ImportTarget[] }
  | { ok: false; errorId: MessageId; params?: Params };

export type DecodeResult =
  | { ok: true; content: EntryContent; cols?: number; targets: ImportTarget[]; code: string }
  | { ok: false; errorId: MessageId };

const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));

export function encodeShare(
  config: Config,
  o: { includeCommands?: boolean; cols?: unknown } = {},
): EncodeResult {
  const content = deepSanitize(contentFromConfig(normalizeConfig(config), 'bundle'));
  const targets = importTargets(content.layout ?? {});
  const dropped = o.includeCommands ? [] : targets;
  if (dropped.length && content.layout) content.layout = dropTargets(content.layout, dropped);
  const cols = parseCols(o.cols);
  const doc = { v: 1, content, ...(cols === undefined ? {} : { cols }) };
  const data = zlib
    .deflateRawSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 })
    .toString('base64url');
  const code = SHARE_PREFIX + data;
  if (code.length > MAX_CODE_CHARS)
    return { ok: false, errorId: 'err.share.tooBig', params: { chars: code.length, max: MAX_CODE_CHARS } };
  return { ok: true, code, chars: code.length, targets, dropped };
}

function inflate(data: string): Buffer | { errorId: MessageId } {
  try {
    const buf = Buffer.from(data, 'base64url');
    return zlib.inflateRawSync(buf, { maxOutputLength: MAX_JSON_BYTES });
  } catch (err) {
    return { errorId: err instanceof RangeError ? 'err.share.tooLarge' : 'err.share.corrupt' };
  }
}

function cleanTheme(content: EntryContent): void {
  if (!content.theme) return;
  let ok = false;
  try {
    const input = parseThemeInput(content.theme);
    ok = Object.keys(input).length > 0;
    if (ok) content.theme = input;
  } catch {}
  if (ok) return;
  delete content.theme;
  const id = content.appearance?.theme;
  if (content.appearance && (typeof id !== 'string' || !BUILTIN_IDS.has(id)))
    content.appearance.theme = DEFAULT_THEME;
}

export function decodeShare(input: unknown): DecodeResult {
  try {
    const ex = extractCode(input);
    if ('errorId' in ex) return { ok: false, errorId: ex.errorId };
    const buf = inflate(ex.data);
    if (!Buffer.isBuffer(buf)) return { ok: false, errorId: buf.errorId };
    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString('utf8'));
    } catch {
      return { ok: false, errorId: 'err.share.corrupt' };
    }
    const doc = parseShareDoc(raw);
    if (!doc) return { ok: false, errorId: 'err.share.corrupt' };
    const content = deepSanitize(doc.content);
    cleanTheme(content);
    const layout = content.layout ?? {};
    const norm = normalizeConfig({ ...layout }) as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of LAYOUT_KEYS) if (Object.hasOwn(layout, k) && norm[k] !== undefined) out[k] = norm[k];
    content.layout = out as Partial<Config>;
    const unsafe = importTargets(content.layout).filter((x) => x.kind === 'link' && !safeConfigUrl(x.target));
    if (unsafe.length) content.layout = dropTargets(content.layout, unsafe);
    const cols = parseCols(doc.cols);
    return {
      ok: true,
      content,
      ...(cols === undefined ? {} : { cols }),
      targets: importTargets(content.layout),
      code: SHARE_PREFIX + ex.data,
    };
  } catch {
    return { ok: false, errorId: 'err.share.corrupt' };
  }
}
