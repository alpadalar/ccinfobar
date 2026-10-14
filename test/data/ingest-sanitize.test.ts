import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAgents } from '../../src/data/agents.js';
import { finishGit, type GitInfo, parseStatus } from '../../src/data/git.js';
import { readGsd } from '../../src/data/gsd.js';
import { parseTranscriptText, readTranscript } from '../../src/data/transcript.js';
import { ctxWith, renderWidget } from '../helpers.js';

const ESC = '\u001b';
const line = (o: object) => JSON.stringify(o);
const BAD = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}

const clean = (v: unknown) => strings(v).every((s) => !BAD.test(s));

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ingest-'));
  env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function hostileGit(): GitInfo {
  const status = parseStatus(
    '# branch.oid abc1234def\n' +
      '# branch.head feat/\u001b]52;c;ZXZpbA==\u0007x\n' +
      '# branch.upstream origin/\u001b[2Jm\n',
  );
  return {
    ...status,
    root: '/r',
    insertions: 0,
    deletions: 0,
    operation: 'MERGING\u009b31m',
    remoteUrl: 'git@h:\u001b]0;t\u0007o/r.git',
    isWorktree: false,
  };
}

describe('git ingest (mocked porcelain output)', () => {
  it('parseStatus stays raw and finishGit strips escapes', () => {
    const raw = hostileGit();
    expect(raw.branch).toContain(ESC);
    const g = finishGit(raw);
    expect(g.branch).toBe('feat/x');
    expect(g.upstream).toBe('origin/m');
    expect(g.remoteUrl).toBe('git@h:o/r.git');
    expect(g.operation).toBe('MERGING');
    expect(g.sha).toBe('abc1234');
    expect(g.detached).toBe(false);
  });

  it('git-branch renders the hostile branch as plain text', () => {
    const out = renderWidget('git-branch', ctxWith({ git: () => finishGit(hostileGit()) }));
    expect(out).toBe('feat/x');
    expect(out).not.toContain('\u001b]52');
  });
});

describe('transcript ingest', () => {
  const text = [
    line({ type: 'custom-title', customTitle: 'evil\u202etxt.exe' }),
    line({
      type: 'assistant',
      timestamp: '2026-10-12T10:00:06.000Z',
      requestId: 'req_1',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5-5',
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'do \u001b[2Jit', status: 'in_progress', activeForm: 'Doing\rit\u001b]0;t\u0007' },
              ],
            },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  ].join('\n');

  it('readTranscript returns sanitized todos, task and session name', () => {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, `${text}\n`);
    const t = readTranscript(file, env)!;
    expect(t.sessionName).toBe('eviltxt.exe');
    expect(t.todos[0]).toMatchObject({ content: 'do it', activeForm: 'Doing it' });
    expect(t.currentTask).toBe('Doing it');
    expect(clean(t)).toBe(true);
  });

  it('keeps the cached state raw so later reads still sanitize', () => {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, `${text}\n`);
    readTranscript(file, env);
    const again = readTranscript(file, env)!;
    expect(again.todos[0]?.content).toBe('do it');
    expect(parseTranscriptText(text).sessionName).toBe('eviltxt.exe');
  });
});

describe('subagent ingest', () => {
  it('sanitizes type, description, model and tool', () => {
    const transcript = path.join(dir, 'sess.jsonl');
    const sub = path.join(dir, 'sess', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, 'agent-a1.meta.json'),
      line({ agentType: 'Ex\u001b[31mplore', description: 'x\ry' }),
    );
    fs.writeFileSync(
      path.join(sub, 'agent-a1.jsonl'),
      `${line({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          id: 'm1',
          model: 'claude-\u001b]0;t\u0007sonnet',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls\u001b[2J' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n`,
    );
    const [a] = readAgents(transcript, null, Date.now(), env);
    expect(a?.description).toBe('x y');
    expect(a?.type).toBe('Explore');
    expect(a?.model ?? '').not.toContain(ESC);
    expect(a?.tool ?? '').not.toContain(ESC);
  });
});

describe('gsd ingest', () => {
  it('readGsd strips escapes from STATE.md text', () => {
    const planning = path.join(dir, 'proj', '.planning');
    fs.mkdirSync(planning, { recursive: true });
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 2 (core)\nStatus: In progress \u001b]0;pwn\u0007\n\n### Blockers/Concerns\n\n- bad \u202eblocker\n',
    );
    const info = readGsd(path.join(dir, 'proj'), {})!;
    expect(info).not.toBeNull();
    expect(info.statusText).toBe('In progress ');
    expect(clean(info)).toBe(true);
  });
});
