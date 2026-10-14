import type { RunningTool, TranscriptInfo } from './transcript.js';

export const TOOL_MAX_MS = 600_000;

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
