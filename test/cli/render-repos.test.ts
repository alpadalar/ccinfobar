import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runRender } from '../../src/cli/render.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { cacheDir, configDir } from '../../src/core/paths.js';
import { dirtyFile } from '../../src/data/repos.js';

const tmpRepo = fs.existsSync(path.join(os.tmpdir(), '.git'));
let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'render-repos-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const dirtyFiles = () =>
  fs.existsSync(cacheDir()) ? fs.readdirSync(cacheDir()).filter((f) => /^repos-dirty-.*\.json$/.test(f)) : [];

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
  it('reads the cache, schedules after output and never writes the cache itself', async () => {
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(path.join(ws, 'api', '.git'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'api', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const lock = `${dirtyFile(ws)}.lock`;
    expect(await renderAt(ws, { dirty: true })).toContain('repos: api (main)');
    expect(dirtyFiles()).toEqual([]);
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(lock);

    fs.writeFileSync(dirtyFile(ws), JSON.stringify({ v: 1, at: Date.now(), dirty: { api: true } }));
    expect(await renderAt(ws, { dirty: true })).toContain('repos: api (main*)');
    expect(fs.existsSync(lock)).toBe(false);
    fs.rmSync(dirtyFile(ws));
  });

  it('never schedules with dirty off', async () => {
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(path.join(ws, 'api', '.git'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'api', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(await renderAt(ws, {})).toContain('repos: api (main)');
    expect(fs.existsSync(`${dirtyFile(ws)}.lock`)).toBe(false);
  });
});
