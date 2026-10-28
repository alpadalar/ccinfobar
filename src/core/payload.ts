import type { TranscriptInfo } from '../data/transcript.js';
import { deepSanitize } from './sanitize.js';
import type { StatusPayload } from './types.js';

const SKIP: ReadonlySet<string> = new Set(['transcript_path']);

export function ingestPayload(raw: string): StatusPayload | null {
  const text = raw.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  try {
    return deepSanitize(parsed as StatusPayload, SKIP);
  } catch {
    return null;
  }
}

export function hasReplies(p: StatusPayload): boolean {
  return (
    (p.cost?.total_cost_usd ?? 0) > 0 || !!p.prompt_cache || (p.context_window?.total_output_tokens ?? 0) > 0
  );
}

export function isFreshSession(p: StatusPayload, transcript: TranscriptInfo | null): boolean {
  const cw = p.context_window;
  const u = cw?.current_usage;
  if (u === undefined ? typeof cw?.used_percentage === 'number' : u !== null) return false;
  if (hasReplies(p) || (cw?.total_input_tokens ?? 0) > 0) return false;
  return !transcript || !(transcript.totalTokens > 0);
}
