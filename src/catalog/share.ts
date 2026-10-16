import { createHash } from 'node:crypto';
import { deepSanitize } from '../core/sanitize.js';
import { canonicalJson } from '../market/protocol.js';
import {
  APPEARANCE_KEYS,
  type CatalogEntry,
  type EntryContent,
  LAYOUT_KEYS,
  latest,
  pick,
  type ShareState,
  shareView,
} from './model.js';

export function entryHash(content: EntryContent): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

// kind keys only, sanitized as the marketplace stores it
export function sendable(e: CatalogEntry): EntryContent {
  const c = latest(e).content;
  const out: EntryContent = {};
  if (e.kind !== 'theme' && c.layout) out.layout = pick(c.layout, LAYOUT_KEYS);
  if (e.kind !== 'preset' && c.appearance) out.appearance = pick(c.appearance, APPEARANCE_KEYS);
  if (e.kind !== 'preset' && c.theme) out.theme = structuredClone(c.theme);
  return deepSanitize(out);
}

export function shareState(e: CatalogEntry): ShareState {
  return shareView(e, entryHash(sendable(e)));
}
