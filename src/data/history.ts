import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../core/paths.js';

export interface HistorySample {
  t: number;
  tok?: number;
  ctx?: number;
  cost?: number;
  h5?: number;
  d7?: number;
}

const MAX = 360;
const GAP = 5000;
const STALE = 7 * 86_400_000;

function dir(env: NodeJS.ProcessEnv): string {
  return path.join(cacheDir(env), 'history');
}

function fileFor(session: string | undefined, env: NodeJS.ProcessEnv): string {
  const id = session && /^[\w-]{1,80}$/.test(session) ? session : 'default';
  return path.join(dir(env), `${id}.json`);
}

export function loadHistory(
  session: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HistorySample[] {
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(session, env), 'utf8')) as { samples?: HistorySample[] };
    return Array.isArray(data.samples) ? data.samples : [];
  } catch {
    return [];
  }
}

function prune(env: NodeJS.ProcessEnv, now: number): void {
  try {
    for (const f of fs.readdirSync(dir(env))) {
      const p = path.join(dir(env), f);
      if (now - fs.statSync(p).mtimeMs > STALE) fs.rmSync(p, { force: true });
    }
  } catch {}
}

// one sample per few seconds, newest last
export function recordHistory(
  session: string | undefined,
  sample: HistorySample,
  env: NodeJS.ProcessEnv = process.env,
): HistorySample[] {
  const file = fileFor(session, env);
  const samples = loadHistory(session, env);
  const last = samples[samples.length - 1];
  if (last && sample.t < last.t) return samples;
  if (last && sample.t - last.t < GAP) samples[samples.length - 1] = { ...sample, t: last.t };
  else samples.push(sample);
  const kept = samples.slice(-MAX);
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir(env), { recursive: true });
      prune(env, sample.t);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ samples: kept }));
    fs.renameSync(tmp, file);
  } catch {}
  return kept;
}
