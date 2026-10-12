import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTranscriptText, readTranscript } from '../../src/data/transcript.js';

const fixture = path.resolve(__dirname, '../fixtures/transcript.jsonl');
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-tr-'));
  env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('transcript parser', () => {
  it('dedupes streamed entries and sums usage', () => {
    const t = parseTranscriptText(fs.readFileSync(fixture, 'utf8'));
    expect(t.inputTokens).toBe(15);
    expect(t.outputTokens).toBe(150);
    expect(t.cacheWriteTokens).toBe(100);
    expect(t.cacheReadTokens).toBe(1000);
    expect(t.totalTokens).toBe(1265);
    expect(t.messageCount).toBe(2);
    expect(t.contextLength).toBe(1005);
  });

  it('reads commands, compactions, title and task', () => {
    const t = parseTranscriptText(fs.readFileSync(fixture, 'utf8'));
    expect(t.lastCommand).toBe('gsd-progress');
    expect(t.compactions).toBe(1);
    expect(t.sessionName).toBe('My session');
    expect(t.currentTask).toBe('Shipping it');
    expect(t.userMessageCount).toBe(3);
    expect(t.firstTimestamp).toBe(Date.parse('2026-10-12T10:00:00.000Z'));
  });

  it('computes output speed from timestamp deltas', () => {
    const t = parseTranscriptText(fs.readFileSync(fixture, 'utf8'));
    expect(t.outputSpeed).toBeGreaterThan(0);
  });

  it('returns null for missing files', () => {
    expect(readTranscript(undefined, env)).toBeNull();
    expect(readTranscript(path.join(dir, 'nope.jsonl'), env)).toBeNull();
  });

  it('parses incrementally when the file grows', () => {
    const file = path.join(dir, 't.jsonl');
    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    fs.writeFileSync(file, `${lines.slice(0, 4).join('\n')}\n`);
    const a = readTranscript(file, env)!;
    expect(a.messageCount).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'cache')).length).toBe(1);
    const half = lines[4]!.slice(0, 40);
    fs.appendFileSync(file, half);
    expect(readTranscript(file, env)!.messageCount).toBe(1);
    fs.appendFileSync(file, `${lines[4]!.slice(40)}\n${lines.slice(5).join('\n')}`);
    const b = readTranscript(file, env)!;
    expect(b).toEqual(parseTranscriptText(fs.readFileSync(fixture, 'utf8')));
  });

  it('reparses when the file shrinks', () => {
    const file = path.join(dir, 't.jsonl');
    fs.copyFileSync(fixture, file);
    expect(readTranscript(file, env)!.messageCount).toBe(2);
    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    fs.writeFileSync(file, `${lines.slice(0, 4).join('\n')}\n`);
    expect(readTranscript(file, env)!.messageCount).toBe(1);
  });
});

describe('built-in commands', () => {
  it('tracks local commands and remembers the last GSD command', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-tr-'));
    const file = path.join(dir, 't.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: '<command-name>/gsd-plan-phase</command-name>' } },
      { type: 'system', subtype: 'local_command', content: '<command-name>/compact</command-name>' },
    ];
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const info = readTranscript(file, { ...process.env, CCINFOBAR_CACHE_DIR: dir });
    expect(info?.lastCommand).toBe('compact');
    expect(info?.lastGsdCommand).toBe('gsd-plan-phase');
  });
});
