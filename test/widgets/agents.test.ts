import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitAnsiLines, stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { dashboardConfig } from '../../src/core/presets.js';
import { gradientColor, render } from '../../src/core/renderer.js';
import { readAgents } from '../../src/data/agents.js';
import { parseTranscriptText } from '../../src/data/transcript.js';
import { shortModel } from '../../src/widgets/agents.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

const line = (o: object) => JSON.stringify(o);
const at = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();

describe('ansi lines', () => {
  it('reopens colors on every line', () => {
    const [a, b] = splitAnsiLines('\x1b[31mred\nstill red\x1b[0m');
    expect(a).toBe('\x1b[31mred\x1b[0m');
    expect(b).toBe('\x1b[31mstill red\x1b[0m');
  });

  it('runs green to red to violet', () => {
    expect(gradientColor(0)).toBe('#4ccf92');
    expect(gradientColor(100)).toBe('#c678dd');
  });
});

describe('transcript tasks and agents', () => {
  it('reads todos, task tools, agent calls and the turn start', () => {
    const text = [
      line({ type: 'user', timestamp: at(0), message: { content: 'go' } }),
      line({
        type: 'assistant',
        timestamp: at(1),
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'A', status: 'completed' },
                  { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
                ],
              },
            },
            { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'x' } },
          ],
        },
      }),
      line({
        type: 'user',
        timestamp: at(5),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
      }),
    ].join('\n');
    const t = parseTranscriptText(text);
    expect(t.todos.map((x) => x.status)).toEqual(['completed', 'in_progress']);
    expect(t.agentCalls).toEqual([
      { id: 'toolu_1', start: NOW.getTime() + 1000, done: NOW.getTime() + 5000 },
    ]);
    expect(t.turnStart).toBe(NOW.getTime());

    const tasks = parseTranscriptText(
      [
        line({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'One' } }] },
        }),
        line({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'Two' } }] },
        }),
        line({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }],
          },
        }),
      ].join('\n'),
    );
    expect(tasks.todos).toEqual([
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'pending' },
    ]);
  });

  it('reads subagent files of the current turn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-agents-'));
    const transcript = path.join(dir, 'session.jsonl');
    const sub = path.join(dir, 'session', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, 'agent-a1.meta.json'),
      line({ agentType: 'Explore', description: 'Look', toolUseId: 'toolu_1' }),
    );
    fs.writeFileSync(
      path.join(sub, 'agent-a1.jsonl'),
      [
        line({ type: 'user', timestamp: at(0), message: { content: 'look' } }),
        line({
          type: 'assistant',
          timestamp: at(60),
          message: {
            id: 'm1',
            model: 'claude-sonnet-5-5',
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls  -la' } }],
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000 },
          },
        }),
      ].join('\n'),
    );
    const info = {
      ...parseTranscriptText(''),
      agentCalls: [{ id: 'toolu_1', start: 0, done: null }],
      turnStart: 0,
    };
    const env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
    const [a] = readAgents(transcript, info, NOW.getTime() + 90_000, env);
    expect(a).toMatchObject({
      type: 'Explore',
      running: true,
      total: 1120,
      output: 20,
      tool: 'Bash[ls -la]',
    });
    expect(shortModel(a!.model)).toBe('sonnet');
  });
});

describe('task and agent widgets', () => {
  it('lists tasks and summarises them', () => {
    const c = ctxWith();
    const list = renderWidget('todo-list', c)!.split('\n');
    expect(list[0]).toBe('2/5');
    expect(list[3]).toContain('▸ 3. Wiring GSD widgets into renderer');
    expect(renderWidget('todo-list', c, { options: { display: 'current' } })).toBe(
      '2/5 ▸ Wiring GSD widgets into renderer',
    );
  });

  it('draws an aligned agent table', () => {
    const rows = renderWidget('agents', ctxWith())!.split('\n');
    expect(rows).toHaveLength(6);
    expect(rows[1]).toContain('└ Bash[grep');
    const widths = [rows[0]!, rows[2]!, rows[4]!].map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
    expect(renderWidget('agent-count', ctxWith())).toBe('2 running · 1 done');
  });
});

describe('dashboard', () => {
  it('renders a boxed panel with the model at the top right and a full-width bar', () => {
    const out = render(ctxWith({ width: 140, config: { ...dashboardConfig(), colorLevel: 0 } })).map(
      stripAnsi,
    );
    expect(out[0]).toMatch(/^╭─ 3f2a9c1e ─+ +Opus 5\.5 high ─╮$/);
    expect(new Set(out.map(visibleWidth)).size).toBe(1);
    const bar = out.find((l) => l.startsWith('│ Ctx █'))!;
    expect(bar.match(/[█░]/g)!.length).toBeGreaterThan(100);
    expect(out.some((l) => l.includes('└ Edit[src/widgets/charts.ts]'))).toBe(true);
  });

  it('puts block widget lines under the line in other styles', () => {
    const lines = [
      [
        { id: 'm', type: 'model' },
        { id: 't', type: 'todo-list' },
      ],
    ];
    const out = render(ctxWith({ config: { ...defaultConfig(), colorLevel: 0, lines } })).map(stripAnsi);
    expect(out[0]).toBe('Opus 5.5 │ Tasks 2/5');
    expect(out).toHaveLength(6);
  });
});
