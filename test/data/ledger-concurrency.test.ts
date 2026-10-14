import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// same primitive as appendLine: one appendFileSync with flag 'a' per line
const SCRIPT = `
const fs = require('node:fs');
const [file, id, n, start] = process.argv.slice(1);
const pad = 'x'.repeat(160);
while (Date.now() < Number(start)) {}
for (let i = 0; i < Number(n); i++) {
  const line = JSON.stringify({ v: 1, t: Date.now(), a: 'acct', s: id, p: pad, tp: '', c: i / 100 });
  fs.appendFileSync(file, line + '\\n', { flag: 'a', mode: 0o600 });
}
`;

const WRITERS = 8;
const LINES = 500;

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ledger-conc-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writer(file: string, id: string, start: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', SCRIPT, file, id, String(LINES), String(start)], {
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

describe('concurrent ledger appends', () => {
  it('leave every complete line parseable', async () => {
    const file = path.join(dir, '2026-10.jsonl');
    const start = Date.now() + 1000;
    const codes = await Promise.all(Array.from({ length: WRITERS }, (_, i) => writer(file, `w${i}`, start)));
    expect(codes).toEqual(Array(WRITERS).fill(0));
    const text = fs.readFileSync(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.slice(0, -1).split('\n');
    expect(lines).toHaveLength(WRITERS * LINES);
    const per: Record<string, number> = {};
    for (const l of lines) {
      const e = JSON.parse(l) as { s: string };
      per[e.s] = (per[e.s] ?? 0) + 1;
    }
    expect(Object.values(per)).toEqual(Array(WRITERS).fill(LINES));
  }, 30_000);
});
