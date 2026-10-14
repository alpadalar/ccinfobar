import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyOwner,
  dropEntry,
  findStatusLineEntry,
  isLegacyCcinfobarCommand,
  type Manifest,
  manifestFile,
  owns,
  readManifest,
  recordGitExclude,
  recordStatusLine,
  writeManifest,
} from '../../src/commands/manifest.js';

const tmpEnv = () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-manifest-')));
  return { dir, env: { ...process.env, CCINFOBAR_CONFIG_DIR: path.join(dir, 'config') } };
};
const sl = (command: string, extra: object = {}) => ({ type: 'command' as const, command, ...extra });
const entryFor = (file: string, value = sl('ccinfobar', { padding: 0 })) => ({
  file,
  value,
  previous: null,
  fileExisted: true,
  restore: null,
  writtenHash: 'sha256:x',
});

describe('manifest file', () => {
  it('starts empty when missing', () => {
    const { env } = tmpEnv();
    expect(readManifest(env)).toEqual({ version: 1, entries: [] });
  });

  it('fails closed on a newer or malformed manifest', () => {
    for (const text of ['{"version":2,"entries":[]}', '{"version":1', '[]', '{"version":1,"entries":[1]}']) {
      const { dir, env } = tmpEnv();
      const file = path.join(dir, 'settings.json');
      fs.mkdirSync(path.dirname(manifestFile(env)), { recursive: true });
      fs.writeFileSync(manifestFile(env), text);
      const m = readManifest(env);
      expect(m.readOnly).toBe(true);
      expect(m.entries).toEqual([]);
      expect(owns(m, file, sl('ccinfobar'))).toBe(false);
      expect(() => writeManifest(recordStatusLine(m, entryFor(file)), env)).toThrow(/newer ccinfobar/);
      expect(fs.readFileSync(manifestFile(env), 'utf8')).toBe(text);
    }
  });

  it('round-trips with mode 0600 and keeps unknown kinds', () => {
    const { dir, env } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    const hook = { kind: 'hook', file: '/x/settings.json', event: 'Stop', command: 'ccinfobar hook' };
    let m: Manifest = { version: 1, entries: [hook] };
    m = recordStatusLine(m, entryFor(file));
    writeManifest(m, env);
    const back = readManifest(env);
    expect(back).toEqual(m);
    expect(back.entries[0]).toEqual(hook);
    if (process.platform !== 'win32') expect(fs.statSync(manifestFile(env)).mode & 0o777).toBe(0o600);
    expect(findStatusLineEntry(back, file)?.version).toEqual(expect.any(String));
  });

  it('replaces the entry for the same file and dedupes git excludes', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    let m: Manifest = { version: 1, entries: [] };
    m = recordStatusLine(m, entryFor(file));
    m = recordStatusLine(m, entryFor(file, sl('/bin/ccinfobar')));
    expect(m.entries).toHaveLength(1);
    expect(findStatusLineEntry(m, file)?.value).toEqual(sl('/bin/ccinfobar'));
    const exclude = path.join(dir, '.git', 'info', 'exclude');
    m = recordGitExclude(m, exclude, '/.claude/settings.local.json');
    m = recordGitExclude(m, exclude, '/.claude/settings.local.json');
    expect(m.entries.filter((e) => e.kind === 'gitExclude')).toHaveLength(1);
    m = dropEntry(m, file, 'statusLine');
    expect(findStatusLineEntry(m, file)).toBeNull();
    expect(m.entries).toHaveLength(1);
  });
});

describe('ownership', () => {
  it('compares values structurally, ignoring key order', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    const m = recordStatusLine({ version: 1, entries: [] }, entryFor(file));
    expect(owns(m, file, { command: 'ccinfobar', padding: 0, type: 'command' })).toBe(true);
    expect(owns(m, file, sl('ccinfobar', { padding: 1 }))).toBe(false);
    expect(owns(m, file, sl('bash -c "ccinfobar | tee x"'))).toBe(false);
    expect(owns(m, path.join(dir, 'other.json'), sl('ccinfobar', { padding: 0 }))).toBe(false);
    expect(owns(m, file, null)).toBe(false);
  });

  it('matches a symlinked settings path through its target', () => {
    const { dir } = tmpEnv();
    const target = path.join(dir, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}');
    const link = path.join(dir, 'settings.json');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return;
    }
    const m = recordStatusLine({ version: 1, entries: [] }, entryFor(target));
    expect(owns(m, link, sl('ccinfobar', { padding: 0 }))).toBe(true);
    expect(findStatusLineEntry(recordStatusLine(m, entryFor(link)), target)?.file).toBe(target);
  });

  it('classifies existing status lines', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    const empty: Manifest = { version: 1, entries: [] };
    const m = recordStatusLine(empty, entryFor(file));
    const c = (mm: Manifest, cmd: string | null, expected: string | null = '/opt/x/ccinfobar') =>
      classifyOwner(mm, file, cmd === null ? null : sl(cmd), expected);
    expect(c(empty, null)).toBe('none');
    expect(classifyOwner(m, file, sl('ccinfobar', { padding: 0 }), null)).toBe('ours');
    expect(c(m, 'npx ccstatusline')).toBe('foreign');
    expect(c(m, '/usr/bin/ccinfobar')).toBe('foreign');
    expect(c(empty, '/opt/x/ccinfobar')).toBe('legacy-ours');
    expect(c(empty, "'/opt/my dir/ccinfobar'")).toBe('legacy-ours');
    expect(c(empty, '"C:\\Users\\u\\AppData\\Roaming\\npm\\ccinfobar.cmd"')).toBe('legacy-ours');
    expect(c(empty, 'C:\\Users\\u\\npm\\ccinfobar.ps1')).toBe('legacy-ours');
    expect(c(empty, 'node "C:\\x\\ccinfobar\\dist\\ccinfobar.js"')).toBe('legacy-ours');
    expect(c(empty, '/usr/bin/node /home/u/src/ccinfobar/dist/ccinfobar.js')).toBe('legacy-ours');
    expect(c(empty, 'npx ccinfobar@latest | other')).toBe('legacy-ask');
    expect(c(empty, 'bash -c "ccinfobar && other"')).toBe('legacy-ask');
    expect(c(empty, 'ccinfobar | tee x')).toBe('legacy-ask');
    expect(c(empty, 'npx ccstatusline')).toBe('foreign');
    expect(c({ ...empty, readOnly: true }, 'ccinfobar')).toBe('foreign');
  });

  it('recognises only the plain legacy command forms', () => {
    expect(isLegacyCcinfobarCommand('ccinfobar')).toBe(true);
    expect(isLegacyCcinfobarCommand('ccinfobar.exe')).toBe(true);
    expect(isLegacyCcinfobarCommand('/x/notccinfobar')).toBe(false);
    expect(isLegacyCcinfobarCommand('ccinfobar --x')).toBe(false);
    expect(isLegacyCcinfobarCommand('python /x/dist/ccinfobar.js')).toBe(false);
    expect(isLegacyCcinfobarCommand('node /x/dist/ccinfobar.js; rm -rf ~')).toBe(false);
    expect(isLegacyCcinfobarCommand('"ccinfobar')).toBe(false);
    expect(isLegacyCcinfobarCommand('')).toBe(false);
  });
});
