import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipDist } from '../dist.js';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const SID = 'sess-parallel';

describe.skipIf(skipDist)('ccinfobar hook parallel appends', () => {
  it(
    'keeps every line from 16 concurrent processes',
    async () => {
      const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hook-par-')));
      const cache = path.join(dir, 'cache');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: path.join(dir, 'home'),
        USERPROFILE: path.join(dir, 'home'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
        CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
        CCINFOBAR_CACHE_DIR: cache,
        CCINFOBAR_NO_UPDATE: '1',
        CCINFOBAR_NO_USAGE_API: '1',
        CCINFOBAR_NO_JOBS: '1',
      };
      const one = (i: number) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const child = spawn(process.execPath, [bin, 'hook', 'SubagentStart'], {
            cwd: dir,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let out = '';
          child.stdout.on('data', (c) => {
            out += c;
          });
          child.stderr.on('data', (c) => {
            out += c;
          });
          child.on('exit', (code) => resolve({ code, out }));
          child.stdin.end(
            JSON.stringify({
              session_id: SID,
              hook_event_name: 'SubagentStart',
              agent_id: `agent-${i}`,
              agent_type: 'Explore',
            }),
          );
        });
      const ids = Array.from({ length: 16 }, (_, i) => i);
      const results = [
        ...(await Promise.all(ids.slice(0, 8).map(one))),
        ...(await Promise.all(ids.slice(8).map(one))),
      ];
      for (const r of results) {
        expect(r.code).toBe(0);
        expect(r.out).toBe('');
      }
      const text = fs.readFileSync(path.join(cache, 'hooks', `${SID}.jsonl`), 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const lines = text.split('\n').filter(Boolean);
      expect(lines).toHaveLength(16);
      const agents = lines.map((l) => (JSON.parse(l) as { a: string }).a).sort();
      expect(agents).toEqual(ids.map((i) => `agent-${i}`).sort());
    },
    process.platform === 'win32' ? 60000 : 30000,
  );
});
