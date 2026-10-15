import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkTranscripts } from '../../src/data/report-index.js';
import { assistantLine, scratch, writeTranscript } from '../fixtures/report/build.js';

const one = [assistantLine({ id: 'm1', requestId: 'r1', ts: '2026-10-12T10:00:00.000Z', in: 1, out: 1 })];

describe('walkTranscripts', () => {
  it('lists main, aside and agent files and nothing else', () => {
    const root = scratch('walk');
    for (const rel of [
      'projects/-w-a/S1.jsonl',
      'projects/-w-a/S1/subagents/agent-x.jsonl',
      'projects/-w-a/S1/subagents/workflows/wf_1/agent-y.jsonl',
      'projects/-w-a/S1/subagents/workflows/wf_1/journal.jsonl',
      'projects/-w-a/S1/subagents/agent-x.meta.json',
      'projects/-w-a/S1/tool-results/t.jsonl',
      'projects/-w-a/S1/workflows/w.jsonl',
      'projects/-w-a/S2.orphaned-123-abc.jsonl',
      'projects/-w-a/S3.jsonl.superseded-456',
      'projects/-w-a/memory/m.jsonl',
      'projects/-w-a/sessions-index.json',
      'projects/-w-a/bad name.jsonl',
      'projects/loose.jsonl',
    ]) {
      writeTranscript(rel, one, root);
    }
    const { files, capped } = walkTranscripts(root);
    expect(capped).toBe(false);
    const got = files.map((f) => [f.rel, f.kind, f.sid, f.enc]).sort();
    expect(got).toEqual(
      [
        ['projects/-w-a/S1.jsonl', 'main', 'S1', '-w-a'],
        ['projects/-w-a/S1/subagents/agent-x.jsonl', 'agent', 'S1', '-w-a'],
        ['projects/-w-a/S1/subagents/workflows/wf_1/agent-y.jsonl', 'agent', 'S1', '-w-a'],
        ['projects/-w-a/S2.orphaned-123-abc.jsonl', 'aside', 'S2', '-w-a'],
        ['projects/-w-a/S3.jsonl.superseded-456', 'aside', 'S3', '-w-a'],
      ].sort(),
    );
    for (const f of files) {
      expect(f.rel).not.toContain('\\');
      expect(f.abs).toBe(path.join(root, ...f.rel.split('/')));
    }
  });

  it('skips symlinked project dirs and files', (ctx) => {
    const root = scratch('walk-link');
    const real = writeTranscript('elsewhere/T1.jsonl', one, root);
    writeTranscript('projects/-w-a/S1.jsonl', one, root);
    try {
      fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'projects', '-w-link'), 'dir');
      fs.symlinkSync(real, path.join(root, 'projects', '-w-a', 'S5.jsonl'), 'file');
    } catch {
      ctx.skip();
    }
    expect(walkTranscripts(root).files.map((f) => f.rel)).toEqual(['projects/-w-a/S1.jsonl']);
  });

  it('stops at depth 4 below subagents', () => {
    const root = scratch('walk-depth');
    writeTranscript('projects/-w-a/S1/subagents/a/b/c/agent-4.jsonl', one, root);
    writeTranscript('projects/-w-a/S1/subagents/a/b/c/d/agent-5.jsonl', one, root);
    expect(walkTranscripts(root).files.map((f) => f.rel)).toEqual([
      'projects/-w-a/S1/subagents/a/b/c/agent-4.jsonl',
    ]);
  });

  it('caps the file count', () => {
    const root = scratch('walk-cap');
    for (const s of ['S1', 'S2', 'S3']) writeTranscript(`projects/-w-a/${s}.jsonl`, one, root);
    const { files, capped } = walkTranscripts(root, 2);
    expect(files).toHaveLength(2);
    expect(capped).toBe(true);
    expect(walkTranscripts(root, 3).capped).toBe(false);
  });

  it('returns nothing without a projects dir', () => {
    const root = scratch('walk-none');
    expect(walkTranscripts(root)).toEqual({ files: [], capped: false });
    expect(walkTranscripts(path.join(root, 'missing'))).toEqual({ files: [], capped: false });
  });
});
