import { describe, expect, it } from 'vitest';
import type { HookState, HookTurn } from '../../src/data/hooks.js';
import { activeTools, groupName, mergeCounts, trustedTurn } from '../../src/data/live.js';
import { parseTranscriptText, type RunningTool, type TranscriptInfo } from '../../src/data/transcript.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const tool = (id: string, start: number | null): RunningTool => ({ id, name: 'Bash', arg: '', start });
const info = (over: Partial<TranscriptInfo>): TranscriptInfo => ({ ...parseTranscriptText(''), ...over });

describe('activeTools', () => {
  it('keeps recent tools and drops ones older than 10 minutes', () => {
    const t = info({ runningTools: [tool('a', NOW - 11 * 60_000), tool('b', NOW - 60_000)] });
    expect(activeTools(t, NOW).map((r) => r.id)).toEqual(['b']);
  });

  it('drops tools that started before a hook Stop', () => {
    const t = info({ runningTools: [tool('a', NOW - 60_000), tool('b', NOW - 10_000)] });
    expect(activeTools(t, NOW, NOW - 30_000).map((r) => r.id)).toEqual(['b']);
    expect(activeTools(t, NOW, null).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('drops every tool once the turn ended after it started', () => {
    const t = info({
      runningTools: [tool('a', NOW - 60_000), tool('b', NOW - 5_000)],
      turnEnd: NOW - 20_000,
    });
    expect(activeTools(t, NOW).map((r) => r.id)).toEqual(['b']);
    expect(activeTools({ ...t, turnEnd: NOW }, NOW)).toEqual([]);
  });
});

describe('groupName', () => {
  it('groups MCP tools by server', () => {
    expect(groupName('mcp__github__create_issue', true)).toBe('mcp:github');
    expect(groupName('mcp__plugin_x_srv__tool', true)).toBe('mcp:plugin_x_srv');
    expect(groupName('mcp__solo', true)).toBe('mcp:solo');
    expect(groupName('mcp__github__create_issue', false)).toBe('mcp__github__create_issue');
    expect(groupName('Bash', true)).toBe('Bash');
  });
});

describe('mergeCounts', () => {
  it('sorts by count and keeps first-reached order on ties', () => {
    expect(
      mergeCounts(
        [
          ['Edit', 1],
          ['Read', 2],
          ['mcp__gh__a', 1],
          ['Bash', 1],
          ['mcp__gh__b', 1],
        ],
        true,
      ),
    ).toEqual([
      ['Read', 2],
      ['mcp:gh', 2],
      ['Edit', 1],
      ['Bash', 1],
    ]);
  });
});

const hooks = (turn: Partial<HookTurn> | null): HookState => ({
  lastEventAt: NOW - 1_000,
  lastSource: 'startup',
  turn: turn ? { promptId: null, start: null, end: null, durationMs: null, ...turn } : null,
  pendingPermission: null,
  agents: Object.create(null),
});

describe('trustedTurn', () => {
  const start = NOW - 100_000;
  const t = info({ promptStart: start, turnEnd: null });
  it.each([
    ['matching prompt ids', hooks({ promptId: 'p1', start }), t, 'p1', 'hooks'],
    ['payload prompt id differs', hooks({ promptId: 'p1', start }), t, 'p2', 'transcript'],
    ['hook prompt id unknown', hooks({ start }), t, 'p2', 'hooks'],
    ['no payload prompt id', hooks({ promptId: 'p1', start }), t, undefined, 'hooks'],
    [
      'missed UserPromptSubmit',
      hooks({ promptId: 'p1', start }),
      info({ promptStart: start + 10_000 }),
      'p1',
      'transcript',
    ],
    [
      'missed Stop',
      hooks({ start }),
      info({ promptStart: start, turnEnd: NOW - 61_000 }),
      'p1',
      'transcript',
    ],
    [
      'recent transcript end',
      hooks({ start }),
      info({ promptStart: start, turnEnd: NOW - 59_000 }),
      'p1',
      'hooks',
    ],
    [
      'transcript end of the previous turn',
      hooks({ start }),
      info({ promptStart: start - 300_000, turnEnd: start - 200_000 }),
      undefined,
      'hooks',
    ],
    ['hook turn without a start', hooks({ end: NOW - 5_000 }), t, undefined, 'transcript'],
    ['no hook state', null, t, 'p1', 'transcript'],
    ['no hook turn and no prompt', hooks(null), info({}), 'p1', null],
    ['nothing at all', null, null, undefined, null],
  ] as const)('%s', (_name, h, tr, id, source) => {
    expect(trustedTurn(h, tr, id, NOW)?.source ?? null).toBe(source);
  });

  it('reports start, end and duration', () => {
    expect(
      trustedTurn(hooks({ start, end: start + 182_000, durationMs: 182_000 }), t, undefined, NOW),
    ).toEqual({
      source: 'hooks',
      start,
      end: start + 182_000,
      durationMs: 182_000,
    });
    expect(trustedTurn(null, info({ promptStart: start, turnEnd: start + 40_000 }), undefined, NOW)).toEqual({
      source: 'transcript',
      start,
      end: start + 40_000,
      durationMs: 40_000,
    });
    expect(trustedTurn(null, t, undefined, NOW)).toEqual({
      source: 'transcript',
      start,
      end: null,
      durationMs: null,
    });
  });
});
