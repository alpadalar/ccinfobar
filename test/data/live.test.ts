import { describe, expect, it } from 'vitest';
import { activeTools, groupName, mergeCounts } from '../../src/data/live.js';
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
