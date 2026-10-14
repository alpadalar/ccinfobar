import type { HookState, PermissionWait } from './hooks.js';
import type { RunningTool, TranscriptInfo } from './transcript.js';

export const TOOL_MAX_MS = 600_000;
const MISSED_UPS_MS = 5_000;
const MISSED_STOP_MS = 60_000;

export interface TrustedTurn {
  source: 'hooks' | 'transcript';
  start: number;
  end: number | null;
  durationMs: number | null;
}

// hooks unless the transcript shows a missed prompt, a missed Stop or another prompt id
export function trustedTurn(
  h: HookState | null,
  t: TranscriptInfo | null,
  promptId: string | undefined,
  now: number,
): TrustedTurn | null {
  const ht = h?.turn ?? null;
  const pStart = t?.promptStart ?? null;
  const tEnd = t?.turnEnd ?? null;
  if (ht && ht.start !== null) {
    const idOk = !promptId || !ht.promptId || ht.promptId === promptId;
    const missedUps = pStart !== null && pStart > ht.start + MISSED_UPS_MS;
    const missedStop = ht.end === null && tEnd !== null && tEnd >= ht.start && now - tEnd > MISSED_STOP_MS;
    if (idOk && !missedUps && !missedStop) {
      const durationMs = ht.durationMs ?? (ht.end !== null ? Math.max(0, ht.end - ht.start) : null);
      return { source: 'hooks', start: ht.start, end: ht.end, durationMs };
    }
  }
  if (pStart === null) return null;
  return {
    source: 'transcript',
    start: pStart,
    end: tEnd,
    durationMs: tEnd !== null ? Math.max(0, tEnd - pStart) : null,
  };
}

// closed waits only: the status line is hidden while a dialog is open
export function lastWait(
  h: HookState | null,
  t: TranscriptInfo | null,
  turnStart: number | null,
  now: number,
  maxAgeMs: number,
): { ms: number; tool: string | null } | null {
  if (!h) return null;
  const list: PermissionWait[] = [];
  if (h.lastPermission) list.push(h.lastPermission);
  const p = h.pendingPermission;
  const res = t?.lastToolResultAt ?? null;
  if (p && res !== null && res > p.since) list.push({ since: p.since, end: res, tool: p.tool });
  let best: PermissionWait | null = null;
  for (const w of list) {
    if (w.end < w.since || w.end - w.since > maxAgeMs) continue;
    if (turnStart !== null && w.since < turnStart) continue;
    if (!best || w.since > best.since) best = w;
  }
  return best ? { ms: best.end - best.since, tool: best.tool } : null;
}

// stable: ties keep the order they reached the count
export function byCount(a: [string, number], b: [string, number]): number {
  return b[1] - a[1];
}

// mcp__github__create_issue -> mcp:github
export function groupName(name: string, group: boolean): string {
  if (!group || !name.startsWith('mcp__')) return name;
  const rest = name.slice(5);
  const cut = rest.indexOf('__');
  return `mcp:${cut > 0 ? rest.slice(0, cut) : rest}`;
}

export function activeTools(t: TranscriptInfo, now: number, stopAt: number | null = null): RunningTool[] {
  const end = t.turnEnd ?? null;
  return (t.runningTools ?? []).filter((r) => {
    if (r.start === null) return end === null && stopAt === null;
    if (end !== null && r.start <= end) return false;
    if (stopAt !== null && r.start <= stopAt) return false;
    return now - r.start <= TOOL_MAX_MS;
  });
}

export function mergeCounts(list: [string, number][], group: boolean): [string, number][] {
  const merged = new Map<string, number>();
  for (const [name, n] of list) {
    const key = groupName(name, group);
    merged.set(key, (merged.get(key) ?? 0) + n);
  }
  return [...merged].sort(byCount);
}
