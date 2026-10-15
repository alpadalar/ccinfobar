import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runRender } from '../../src/cli/render.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { cacheDir, configDir } from '../../src/core/paths.js';
import { envelopeFile, lockFile, okEnvelope, writeEnvelope } from '../../src/data/jobs/runner.js';
import { legacyDirtyFile, reposKey } from '../../src/data/repos.js';
import { useIdleEntry } from '../helpers.js';

const tmpRepo = fs.existsSync(path.join(os.tmpdir(), '.git'));
let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'render-repos-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const listed = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
const dirtyFiles = () =>
  [...listed(cacheDir()), ...listed(path.join(cacheDir(), 'jobs'))].filter((f) =>
    /^repos-dirty-.*\.json$/.test(f),
  );

async function renderAt(ws: string, options: Record<string, unknown>): Promise<string> {
  const file = path.join(dir, 'p.json');
  fs.writeFileSync(file, JSON.stringify({ session_id: 'render-repos', workspace: { current_dir: ws } }));
  fs.mkdirSync(configDir(), { recursive: true });
  const cfg = path.join(configDir(), 'render-repos.json');
  fs.writeFileSync(cfg, JSON.stringify({ lines: [[{ id: 'r', type: 'workspace-repos', options }]] }));
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s);
    return true;
  });
  await runRender(parseArgs(['--payload', file]), cfg);
  vi.restoreAllMocks();
  return stripAnsi(out).replace(/\u00a0/g, ' ');
}

describe.skipIf(tmpRepo)('render with the dirty marker', () => {
  useIdleEntry();
  it('reads the cache, schedules after output and never writes the cache itself', async () => {
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(path.join(ws, 'api', '.git'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'api', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const key = reposKey(ws);
    const lock = lockFile(key);
    expect(await renderAt(ws, { dirty: true })).toContain('repos: api (main)');
    expect(dirtyFiles()).toEqual([]);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(`${legacyDirtyFile(ws)}.lock`)).toBe(false);
    fs.rmSync(lock);

    writeEnvelope(okEnvelope(key, { dirty: { api: true } }, Date.now()));
    expect(await renderAt(ws, { dirty: true })).toContain('repos: api (main*)');
    expect(fs.existsSync(lock)).toBe(false);
    fs.rmSync(envelopeFile(key));
  });

  it('falls back to the legacy dirty file', async () => {
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(path.join(ws, 'api', '.git'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'api', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(legacyDirtyFile(ws), JSON.stringify({ v: 1, at: Date.now(), dirty: { api: true } }));
    expect(await renderAt(ws, { dirty: true })).toContain('repos: api (main*)');
    expect(fs.existsSync(lockFile(reposKey(ws)))).toBe(false);
    fs.rmSync(legacyDirtyFile(ws));
  });

  it('never schedules with dirty off', async () => {
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(path.join(ws, 'api', '.git'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'api', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(await renderAt(ws, {})).toContain('repos: api (main)');
    expect(fs.existsSync(lockFile(reposKey(ws)))).toBe(false);
  });
});
