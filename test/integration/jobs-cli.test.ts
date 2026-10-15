import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const stub = path.join(root, 'test/fixtures/jobs/fetch-stub.mjs');
const USAGE = /^usage-[0-9a-f]{16}\.json$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sandbox(extra: NodeJS.ProcessEnv = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-jobs-cli-')));
  const cache = path.join(dir, 'cache');
  const config = path.join(dir, 'config');
  const log = path.join(dir, 'stub.log');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(dir, 'home'),
    USERPROFILE: path.join(dir, 'home'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(dir, 'secure'),
    CCINFOBAR_CONFIG_DIR: config,
    CCINFOBAR_CACHE_DIR: cache,
    NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`,
    CCIB_STUB_LOG: log,
  };
  for (const k of [
    'CI',
    'CCINFOBAR_CONFIG',
    'CCINFOBAR_DEBUG',
    'CCINFOBAR_NO_UPDATE',
    'CCINFOBAR_NO_USAGE_API',
    'CCINFOBAR_NO_JOBS',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  ]) {
    delete env[k];
  }
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(k)) delete env[k];
  Object.assign(env, extra);
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(
    path.join(config, 'config.json'),
    JSON.stringify({ lines: [[{ id: 'l', type: 'five-hour-usage' }]] }),
  );
  const jobs = path.join(cache, 'jobs');
  const list = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
  const logLines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  const render = () =>
    spawnSync(process.execPath, [bin], {
      cwd: dir,
      encoding: 'utf8',
      env,
      input: JSON.stringify({ session_id: 'sess-jobs-1', workspace: { current_dir: dir } }),
      timeout: 10_000,
    });
  return { dir, cache, jobs, list, logLines, render };
}

describe.skipIf(!fs.existsSync(bin))('background jobs (built cli)', () => {
  it('one render spawns one worker that writes both envelopes', async () => {
    const s = sandbox();
    const r = s.render();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const done = () => {
      const names = s.list(s.jobs);
      return names.includes('update.json') && names.some((n) => USAGE.test(n));
    };
    for (let i = 0; i < 150 && !done(); i++) await sleep(100);
    expect(done()).toBe(true);
    const lines = s.logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/(^| )update(=| |$)/);
    expect(lines[0]).toMatch(/(^| )usage-[0-9a-f]{16}( |$)/);
    expect(lines[0]).toContain(`--cwd=${s.dir}`);
    const usage = s.list(s.jobs).find((n) => USAGE.test(n))!;
    const env = JSON.parse(fs.readFileSync(path.join(s.jobs, usage), 'utf8'));
    expect(env.ok).toBe(false);
    const update = JSON.parse(fs.readFileSync(path.join(s.jobs, 'update.json'), 'utf8'));
    expect(update.value?.latest).toBe('0.0.1');
    const rootFiles = s.list(s.cache);
    expect(rootFiles).not.toContain('update.json');
    expect(rootFiles.filter((n) => /^usage(-[0-9a-f]{16})?\.json$/.test(n))).toEqual([]);
  }, 20_000);

  it('spawns nothing when nonessential traffic is off', async () => {
    const s = sandbox({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    const r = s.render();
    expect(r.status).toBe(0);
    await sleep(3000);
    expect(s.list(s.jobs)).toEqual([]);
    expect(s.logLines()).toEqual([]);
  }, 20_000);
});
