import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'dist');
const SID = 'sess_start-1';
const DAY = 86_400_000;

// renamed copy: spawnSelf only spawns an entry named ccinfobar(.js), so no worker and no network
let entry = '';

beforeAll(() => {
  if (!fs.existsSync(path.join(dist, 'ccinfobar.js'))) return;
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hook-ss-app-')), 'app');
  fs.cpSync(dist, app, { recursive: true });
  entry = path.join(app, 'entry.js');
  fs.renameSync(path.join(app, 'ccinfobar.js'), entry);
});

function sandbox() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hook-ss-')));
  const cache = path.join(dir, 'cache');
  const config = path.join(dir, 'config');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(dir, 'home'),
    USERPROFILE: path.join(dir, 'home'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CONFIG_DIR: config,
    CCINFOBAR_CACHE_DIR: cache,
    CCINFOBAR_NO_USAGE_API: '1',
  };
  for (const k of [
    'CI',
    'CCINFOBAR_NO_UPDATE',
    'CCINFOBAR_CONFIG',
    'CCINFOBAR_DEBUG',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  ]) {
    delete env[k];
  }
  const lock = path.join(cache, 'jobs', 'update.lock');
  const state = path.join(cache, 'jobs', 'update.json');
  const checked = () => fs.existsSync(lock) || fs.existsSync(state);
  const hooks = path.join(cache, 'hooks');
  const run = (source: unknown, extra: NodeJS.ProcessEnv = {}, pre: string[] = []) => {
    const r = spawnSync(process.execPath, [entry, ...pre, 'hook', 'SessionStart'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, ...extra },
      input: JSON.stringify({ session_id: SID, hook_event_name: 'SessionStart', source }),
      timeout: 10_000,
    });
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    return r;
  };
  const writeConfig = (text: string, file = path.join(config, 'config.json')) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const aged = (name: string, days: number) => {
    fs.mkdirSync(hooks, { recursive: true });
    const file = path.join(hooks, name);
    fs.writeFileSync(file, '{}\n');
    const t = (Date.now() - days * DAY) / 1000;
    fs.utimesSync(file, t, t);
    return file;
  };
  return { dir, cache, hooks, env, checked, run, writeConfig, aged };
}

describe.skipIf(!fs.existsSync(path.join(dist, 'ccinfobar.js')))('hook SessionStart (built cli)', () => {
  it('source startup runs the update check', () => {
    const s = sandbox();
    s.run('startup');
    expect(s.checked()).toBe(true);
  });

  it('source resume, clear, compact, fork or a missing source never checks', () => {
    for (const source of ['resume', 'clear', 'compact', 'fork', undefined, 7]) {
      const s = sandbox();
      s.run(source);
      expect(s.checked(), String(source)).toBe(false);
    }
  });

  it('never checks when nonessential traffic is off', () => {
    const s = sandbox();
    s.run('startup', { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    expect(s.checked()).toBe(false);
  });

  it('never checks under CI or CCINFOBAR_NO_UPDATE', () => {
    for (const extra of [{ CI: '1' }, { CCINFOBAR_NO_UPDATE: '1' }]) {
      const s = sandbox();
      s.run('startup', extra);
      expect(s.checked()).toBe(false);
    }
  });

  it('never checks with update off or a config that does not parse', () => {
    for (const text of ['{"update":"off"}', '﻿{"update":"off"}', 'not json {']) {
      const s = sandbox();
      s.writeConfig(text);
      s.run('startup');
      expect(s.checked(), text).toBe(false);
    }
  });

  it('reads the --config file given before hook', () => {
    const s = sandbox();
    const file = s.writeConfig('{"update":"off"}', path.join(s.dir, 'custom.json'));
    s.run('startup', {}, ['--config', file]);
    expect(s.checked()).toBe(false);
    const t = sandbox();
    t.writeConfig('{"update":"off"}');
    t.run('startup', {}, ['--config', t.writeConfig('{"update":"notify"}', path.join(t.dir, 'n.json'))]);
    expect(t.checked()).toBe(true);
  });

  it('prunes hook logs older than 7 days on startup', () => {
    const s = sandbox();
    const old = s.aged('old-session.jsonl', 10);
    const oldFold = s.aged('old-session.fold.json', 10);
    const fresh = s.aged('fresh-session.jsonl', 1);
    const other = s.aged('notes.txt', 30);
    s.run('startup');
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(oldFold)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(path.join(s.hooks, `${SID}.jsonl`))).toBe(true);
  });

  it('keeps old logs on resume', () => {
    const s = sandbox();
    const old = s.aged('old-session.jsonl', 10);
    s.run('resume');
    expect(fs.existsSync(old)).toBe(true);
  });

  it('writes reason lines to debug.log only under CCINFOBAR_DEBUG', () => {
    const s = sandbox();
    s.aged('old-session.jsonl', 10);
    s.run('startup', { CCINFOBAR_DEBUG: '1' });
    const log = fs.readFileSync(path.join(s.hooks, 'debug.log'), 'utf8');
    expect(log).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z pruned:1$/m);
    expect(log).toMatch(/ scheduled$/m);
    expect(log).not.toContain(SID);
    const t = sandbox();
    t.run('startup');
    expect(fs.existsSync(path.join(t.hooks, 'debug.log'))).toBe(false);
  });
});
