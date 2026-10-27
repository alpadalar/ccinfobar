import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentsCacheName, readAgents } from '../../src/data/agents.js';
import { cacheFile } from '../../src/data/cache.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function run(name: string, input: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-agents-inc-'));
  dirs.push(dir);
  const transcript = path.join(dir, 'session.jsonl');
  const sub = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(
    path.join(sub, 'a1.meta.json'),
    JSON.stringify({ agentType: 'Bash', description: 'd', toolUseId: 't1' }),
  );
  const jsonl = path.join(sub, 'a1.jsonl');
  const now = Date.now();
  fs.writeFileSync(
    jsonl,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now).toISOString(),
      message: {
        id: 'm1',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'tool_use', name, input }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`,
  );
  const env = { ...process.env, CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
  const rows = readAgents(transcript, null, now, env);
  return { rows, jsonl, env };
}

describe('agents argument masking', () => {
  it('masks secrets in the row and the cache file', () => {
    const { rows, jsonl, env } = run('Bash', {
      command: "curl -H 'Authorization: Bearer sk-abcdef123456' https://u:pw@host/x?token=abc",
    });
    expect(rows).toHaveLength(1);
    const tool = rows[0]!.tool!;
    expect(tool.startsWith('Bash[')).toBe(true);
    for (const bad of ['sk-abcdef', 'pw@', 'token=abc']) expect(tool).not.toContain(bad);
    expect(tool).toContain('Bearer …');
    const file = cacheFile(agentsCacheName(jsonl), env);
    expect(path.basename(file).startsWith('agent3-')).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    for (const bad of ['sk-abcdef', 'pw@', 'token=abc']) expect(text).not.toContain(bad);
  });

  it('shows the basename of file_path', () => {
    const { rows } = run('Read', { file_path: '/home/u/secret/dir/file.ts' });
    expect(rows[0]!.tool).toBe('Read[file.ts]');
  });

  it('hides URL credentials', () => {
    const { rows } = run('WebFetch', { url: 'https://user:secret@example.com/path' });
    expect(rows[0]!.tool).not.toContain('secret@');
  });
});
