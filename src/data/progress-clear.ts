import fs from 'node:fs';
import path from 'node:path';
import { hooksDir } from './hook-line.js';
import { readSent, readWant } from './progress.js';
import { writeSmall } from './store.js';

const WANT_RE = /^[A-Za-z0-9_-]{1,128}\.progress\.json$/;

// D-36: every live bar wants state 0; returns hook-channel bars still showing
export function requestClear(env: NodeJS.ProcessEnv, max = 500): number {
  const dir = hooksDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let pending = 0;
  for (const name of names.filter((n) => WANT_RE.test(n)).slice(0, max)) {
    const file = path.join(dir, name);
    const want = readWant(file);
    if (!want || want.state === 0) continue;
    if (!writeSmall(file, JSON.stringify({ ...want, state: 0, pct: 0 }))) continue;
    const sent = readSent(file.replace(/\.progress\.json$/, '.progress-sent.json'));
    if (want.channel === 'hook' && sent && sent.state !== 0) pending++;
  }
  return pending;
}
