import { describe, expect, it } from 'vitest';
import type { OptionValue } from '../../src/core/types.js';
import type { HookState, HookTurn } from '../../src/data/hooks.js';
import { parseTranscriptText, type TranscriptInfo } from '../../src/data/transcript.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

const line = (o: object) => JSON.stringify(o);
const at = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();
const usage = { input_tokens: 1, output_tokens: 1 };

const prompt = (s: number, text: string, promptId?: string) =>
  line({ type: 'user', timestamp: at(s), ...(promptId ? { promptId } : {}), message: { content: text } });

const use = (s: number, id: string, name: string, input: object, mid = `m_${id}`) =>
  line({
    type: 'assistant',
    timestamp: at(s),
    message: {
      id: mid,
      model: 'claude-opus-4',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name, input }],
      usage,
    },
  });

const result = (s: number, id: string, promptId?: string) =>
  line({
    type: 'user',
    timestamp: at(s),
    ...(promptId ? { promptId } : {}),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });

const turn = [
  prompt(-60, 'fix the tests', 'p1'),
  use(-58, 't1', 'Read', { file_path: '/repo/src/a.ts' }),
  result(-57, 't1', 'p1'),
  use(-56, 't2', 'Read', { file_path: '/repo/src/b.ts' }),
  result(-55, 't2', 'p1'),
  use(-54, 't3', 'Edit', { file_path: '/repo/src/a.ts' }),
  result(-53, 't3', 'p1'),
  use(-50, 't4', 'Bash', { command: 'npm test' }),
];

const ctxFor = (text: string) => ctxWith({ transcript: () => parseTranscriptText(text) });
const show = (text: string, options: Record<string, OptionValue> = {}) =>
  renderWidget('tool-activity', ctxFor(text), { options });

describe('tool-activity', () => {
  it('shows the running tool and the turn counts from the transcript', () => {
    expect(show(turn.join('\n'))).toBe('Bash npm test · Read 2, Edit 1, Bash 1');
  });

  it('shows only counts or only the running tool', () => {
    expect(show(turn.join('\n'), { mode: 'counts' })).toBe('Read 2, Edit 1, Bash 1');
    expect(show(turn.join('\n'), { mode: 'running' })).toBe('Bash npm test');
    expect(show(turn.join('\n'), { mode: 'running', showArgs: false })).toBe('Bash');
  });

  it('marks parallel running tools with +N', () => {
    const text = [
      prompt(-30, 'look', 'p1'),
      use(-20, 'b1', 'Bash', { command: 'npm test' }, 'm1'),
      use(-20, 'g1', 'Grep', { pattern: 'TODO' }, 'm1'),
    ].join('\n');
    expect(show(text, { mode: 'running' })).toBe('Bash npm test +1');
  });

  it('uses a plain separator for the text charset', () => {
    const ctx = ctxWith({
      config: { charset: 'text' },
      transcript: () => parseTranscriptText(turn.join('\n')),
    });
    expect(renderWidget('tool-activity', ctx)).toBe('Bash npm test | Read 2, Edit 1, Bash 1');
  });

  it('keeps session totals across prompts', () => {
    const text = [
      ...turn,
      result(-45, 't4', 'p1'),
      prompt(-40, 'again', 'p2'),
      use(-38, 't5', 'Read', { file_path: '/repo/c.ts' }),
      result(-37, 't5', 'p2'),
    ].join('\n');
    expect(show(text)).toBe('Read 1');
    expect(show(text, { scope: 'session' })).toBe('Read 3, Edit 1, Bash 1');
  });

  it('groups MCP tools by server unless groupMcp is off', () => {
    const text = [
      prompt(-30, 'issue', 'p1'),
      use(-29, 'm1', 'mcp__github__create_issue', {}),
      result(-28, 'm1', 'p1'),
      use(-27, 'm2', 'mcp__github__list', {}),
      result(-26, 'm2', 'p1'),
    ].join('\n');
    expect(show(text)).toBe('mcp:github 2');
    expect(show(text, { groupMcp: false })).toBe('mcp__github__create_issue 1, mcp__github__list 1');
  });

  it('caps the list at maxTools with +N', () => {
    const tools: [string, number][] = [
      ['Read', 4],
      ['Edit', 2],
      ['Bash', 1],
      ['Grep', 1],
    ];
    const lines = [prompt(-100, 'go', 'p1')];
    let n = 0;
    for (const [name, count] of tools) {
      for (let i = 0; i < count; i++) {
        n++;
        lines.push(use(-90 + n, `x${n}`, name, {}), result(-90 + n, `x${n}`, 'p1'));
      }
    }
    expect(show(lines.join('\n'), { maxTools: 2 })).toBe('Read 4, Edit 2 +2');
  });

  it('renders the sample data', () => {
    expect(renderWidget('tool-activity', ctxWith())).toBe('Bash npm test · Read 4, Edit 2, Bash 1');
  });

  it('is null without a transcript or without tools', () => {
    expect(renderWidget('tool-activity', ctxWith({ transcript: () => null }))).toBeNull();
    expect(show('')).toBeNull();
    expect(show(prompt(-5, 'hello', 'p1'))).toBeNull();
  });

  it('drops a running tool after the turn ends', () => {
    const t = parseTranscriptText(turn.join('\n'));
    const ended: TranscriptInfo = { ...t, turnEnd: NOW.getTime() - 40_000 };
    expect(renderWidget('tool-activity', ctxWith({ transcript: () => ended }))).toBe(
      'Read 2, Edit 1, Bash 1',
    );
  });
});

const hookState = (turn: Partial<HookTurn>): HookState => ({
  lastEventAt: NOW.getTime() - 1_000,
  lastSource: 'startup',
  turn: { promptId: null, start: null, end: null, durationMs: null, ...turn },
  pendingPermission: null,
  agents: Object.create(null),
});
const transcriptAt = (over: Partial<TranscriptInfo>): TranscriptInfo => ({
  ...parseTranscriptText(''),
  ...over,
});
const timer = (
  h: HookState | null,
  t: TranscriptInfo | null = null,
  options: Record<string, OptionValue> = {},
) => renderWidget('turn-timer', ctxWith({ hooks: () => h, transcript: () => t }), { options });

describe('turn-timer', () => {
  const now = NOW.getTime();

  it('shows the running turn from hooks', () => {
    expect(timer(hookState({ start: now - 134_000 }))).toBe('2m14s');
  });

  it('shows the last turn after Stop, or hides it', () => {
    const ended = hookState({ start: now - 200_000, end: now - 18_000, durationMs: 182_000 });
    expect(timer(ended)).toBe('last 3m02s');
    expect(timer(ended, null, { afterStop: 'hide' })).toBeNull();
  });

  it('falls back to the transcript without hooks', () => {
    expect(timer(null, transcriptAt({ promptStart: now - 75_000, turnEnd: null }))).toBe('1m15s');
    expect(timer(null, transcriptAt({ promptStart: now - 90_000, turnEnd: now - 50_000 }))).toBe('last 40s');
  });

  it('is null without hooks and without a prompt', () => {
    expect(timer(null, null)).toBeNull();
    expect(timer(null, transcriptAt({ promptStart: null }))).toBeNull();
  });

  it('renders the sample data', () => {
    expect(renderWidget('turn-timer', ctxWith())).toBe('2m14s');
  });
});

describe('tool-activity with hooks', () => {
  it('drops a running tool that started before a trusted hook Stop', () => {
    const now = NOW.getTime();
    const ctx = ctxWith({
      transcript: () => parseTranscriptText(turn.join('\n')),
      hooks: () => hookState({ promptId: 'p1', start: now - 60_000, end: now - 30_000, durationMs: 30_000 }),
    });
    expect(renderWidget('tool-activity', ctx)).toBe('Read 2, Edit 1, Bash 1');
  });

  it('keeps it while the hook turn runs', () => {
    const ctx = ctxWith({
      transcript: () => parseTranscriptText(turn.join('\n')),
      hooks: () => hookState({ promptId: 'p1', start: NOW.getTime() - 60_000 }),
    });
    expect(renderWidget('tool-activity', ctx)).toBe('Bash npm test · Read 2, Edit 1, Bash 1');
  });
});
