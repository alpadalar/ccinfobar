import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backupSettings,
  backupsDir,
  deleteSettingsFile,
  detectFormat,
  ensureOriginal,
  hashBytes,
  patchSettings,
  readSettings,
  SettingsParseError,
  writeSettingsBytes,
} from '../../src/commands/settings-file.js';
import { formatJson, settingsFixture } from './fixtures.js';

const posix = process.platform !== 'win32';
const sl = { type: 'command', command: 'ccinfobar', padding: 0 };
const base = { model: 'opus', env: { A: '1' }, nested: { list: [1, 2], deep: { k: 'v' } } };
const setLine = (d: Record<string, unknown>) => {
  d.statusLine = sl;
};

describe('settings file format', () => {
  it('keeps BOM, CRLF, 4-space indent and no final newline', () => {
    const fmt = { bom: true, eol: '\r\n' as const, indent: '    ', finalNewline: false };
    const fx = settingsFixture({ data: base, ...fmt });
    const res = patchSettings(fx.file, setLine, { env: fx.env });
    expect(res.changed).toBe(true);
    const text = fs.readFileSync(fx.file, 'utf8');
    expect(text).toBe(formatJson({ ...base, statusLine: sl }, fmt));
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
    expect(text.endsWith('}')).toBe(true);
  });

  it('keeps tabs and 2-space LF with final newline', () => {
    for (const fmt of [{ indent: '\t' }, { indent: '  ', eol: '\n' as const, finalNewline: true }]) {
      const fx = settingsFixture({ data: base, ...fmt });
      patchSettings(fx.file, setLine, { env: fx.env });
      expect(fs.readFileSync(fx.file, 'utf8')).toBe(formatJson({ ...base, statusLine: sl }, fmt));
    }
  });

  it('detects the default format for an empty text', () => {
    expect(detectFormat('')).toEqual({ bom: false, eol: '\n', indent: '  ', finalNewline: true });
  });

  it.skipIf(!posix)('keeps mode 0600', () => {
    const fx = settingsFixture({ data: base, mode: 0o600 });
    patchSettings(fx.file, setLine, { env: fx.env });
    expect(fs.statSync(fx.file).mode & 0o777).toBe(0o600);
  });

  it('writes through a symlink and keeps it', () => {
    const fx = settingsFixture({ data: base, symlink: true });
    if (!fx.linked) return;
    const res = patchSettings(fx.file, setLine, { env: fx.env });
    expect(res.real).toBe(fx.real);
    expect(fs.lstatSync(fx.file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(fx.real, 'utf8')).statusLine).toEqual(sl);
  });

  it('creates the target of a dangling symlink', () => {
    const fx = settingsFixture({ symlink: true });
    if (!fx.linked) return;
    const res = patchSettings(fx.file, setLine, { env: fx.env });
    expect(res.real).toBe(fx.real);
    expect(fs.lstatSync(fx.file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(fx.real, 'utf8'))).toEqual({ statusLine: sl });
  });

  it('refuses to write a file that does not parse', () => {
    for (const text of ['{"a": 1,', '[1, 2]', 'null', '']) {
      const fx = settingsFixture({ text });
      const before = fs.readFileSync(fx.file);
      expect(() => patchSettings(fx.file, setLine, { env: fx.env })).toThrow(SettingsParseError);
      expect(() => readSettings(fx.file)).toThrow(/Cannot parse|strict JSON/);
      expect(fs.readFileSync(fx.file).equals(before)).toBe(true);
    }
  });

  it('names the line and column of a non-strict file', () => {
    const msg = (text: string) => {
      const fx = settingsFixture({ text });
      try {
        readSettings(fx.file);
      } catch (e) {
        expect(e).toBeInstanceOf(SettingsParseError);
        return (e as Error).message;
      }
      return '';
    };
    expect(msg('{\n  // comment\n  "a": 1\n}')).toMatch(/strict JSON.*line 2, column 3/);
    expect(msg('{"a":1,}')).toMatch(/strict JSON.*line 1, column 8/);
    expect(msg('{\r\n  "a": 1,\r\n  // c\r\n}')).toMatch(/line 3, column 3/);
    expect(msg('\ufeff{"a":1,}')).toMatch(/line 1, column 8/);
    expect(msg('{"a":1,}')).not.toMatch(/Cannot parse/);
  });

  it('writes nothing when the bytes would not change', () => {
    const fx = settingsFixture({ data: { ...base, statusLine: sl } });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(fx.file, past, past);
    const mtime = fs.statSync(fx.file).mtimeMs;
    const res = patchSettings(fx.file, setLine, { env: fx.env });
    expect(res.changed).toBe(false);
    expect(res.backup).toBeNull();
    expect(fs.statSync(fx.file).mtimeMs).toBe(mtime);
    expect(fs.existsSync(path.join(fx.dir, 'config', 'backups'))).toBe(false);
  });

  it('creates a missing file and its parent dir', () => {
    const fx = settingsFixture();
    const file = path.join(fx.dir, 'new', 'settings.json');
    const res = patchSettings(file, setLine, { env: fx.env });
    expect(res).toMatchObject({ changed: true, existed: false, backup: null, beforeHash: null });
    expect(fs.readFileSync(file, 'utf8')).toBe(formatJson({ statusLine: sl }));
    if (posix) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readSettings(path.join(fx.dir, 'none.json'))).toMatchObject({ exists: false, data: {} });
  });

  it('re-merges when the file changes before rename', () => {
    const fx = settingsFixture({ data: base });
    let hits = 0;
    const res = patchSettings(fx.file, setLine, {
      env: fx.env,
      beforeRename: () => {
        if (hits++ === 0) fs.writeFileSync(fx.file, JSON.stringify({ ...base, other: true }));
      },
    });
    expect(res.attempts).toBe(2);
    expect(JSON.parse(fs.readFileSync(fx.file, 'utf8'))).toEqual({ ...base, other: true, statusLine: sl });
    expect(res.afterHash).toBe(hashBytes(fs.readFileSync(fx.file)));
    expect(fs.readdirSync(fx.dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('gives up after three changed reads', () => {
    const fx = settingsFixture({ data: base });
    let n = 0;
    const touch = () => fs.writeFileSync(fx.file, JSON.stringify({ ...base, n: n++ }));
    expect(() => patchSettings(fx.file, setLine, { env: fx.env, beforeRename: touch })).toThrow(/changed/);
    expect(JSON.parse(fs.readFileSync(fx.file, 'utf8')).statusLine).toBeUndefined();
  });

  const stamped = (env: NodeJS.ProcessEnv) => {
    try {
      return fs.readdirSync(backupsDir(env)).filter((n) => !n.endsWith('-original.json'));
    } catch {
      return [];
    }
  };
  const seed = (env: NodeJS.ProcessEnv, prefix = 'settings') => {
    fs.mkdirSync(backupsDir(env), { recursive: true });
    const names: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const name = `${prefix}-202001${String(i).padStart(2, '0')}T000000Z.json`;
      fs.writeFileSync(path.join(backupsDir(env), name), '{}');
      names.push(name);
    }
    return names;
  };

  it('one backup from the bytes that were read when a concurrent write forces a retry', () => {
    const fx = settingsFixture({ data: base });
    const before = stamped(fx.env).length;
    let hits = 0;
    const res = patchSettings(fx.file, setLine, {
      env: fx.env,
      beforeRename: () => {
        if (hits++ === 0) fs.writeFileSync(fx.file, JSON.stringify({ ...base, other: true }));
      },
    });
    expect(res.attempts).toBe(2);
    const after = stamped(fx.env);
    expect(after.length - before).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(backupsDir(fx.env), after[0]!), 'utf8'))).toEqual({
      ...base,
      other: true,
    });
    expect(JSON.parse(fs.readFileSync(fx.file, 'utf8'))).toEqual({ ...base, other: true, statusLine: sl });
  });

  it('a failed CAS leaves no backup behind and rotates nothing', () => {
    const fx = settingsFixture({ data: base });
    const names = seed(fx.env);
    let n = 0;
    const touch = () => fs.writeFileSync(fx.file, JSON.stringify({ ...base, n: n++ }));
    expect(() => patchSettings(fx.file, setLine, { env: fx.env, beforeRename: touch })).toThrow(/changed/);
    expect(stamped(fx.env).sort()).toEqual([...names].sort());
  });

  it('rotation happens only after a successful rename', () => {
    const fx = settingsFixture({ data: base });
    const names = seed(fx.env);
    patchSettings(fx.file, setLine, { env: fx.env });
    const after = stamped(fx.env).sort();
    expect(after.length).toBe(10);
    expect(after).not.toContain(names[0]);
    expect(after.filter((x) => !names.includes(x)).length).toBe(1);
  });

  it('deleteSettingsFile leaves no backup when the file changes before the delete', () => {
    const fx = settingsFixture({ data: base });
    const before = stamped(fx.env).length;
    const res = deleteSettingsFile(fx.file, {
      env: fx.env,
      beforeRename: () => fs.writeFileSync(fx.file, JSON.stringify({ changed: true })),
    });
    expect(res).toBeNull();
    expect(JSON.parse(fs.readFileSync(fx.file, 'utf8'))).toEqual({ changed: true });
    expect(stamped(fx.env).length).toBe(before);
  });

  it('hashes bytes with a sha256 prefix', () => {
    expect(hashBytes(Buffer.from('x'))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashBytes('x')).toBe(hashBytes(Buffer.from('x')));
  });
});

describe('settings backups', () => {
  const now = new Date('2026-10-14T15:30:12.345Z');
  const at = (sec: number) => new Date(now.getTime() + sec * 1000);
  const list = (env: NodeJS.ProcessEnv) => fs.readdirSync(backupsDir(env)).sort();

  it('writes a private timestamped backup with a collision suffix', () => {
    const fx = settingsFixture({ data: base });
    const bytes = fs.readFileSync(fx.real);
    const first = backupSettings(fx.real, bytes, { env: fx.env, now });
    expect(first).toBe(path.join(fx.dir, 'config', 'backups', 'settings-20261014T153012Z.json'));
    expect(fs.readFileSync(first).equals(bytes)).toBe(true);
    if (posix) expect(fs.statSync(first).mode & 0o777).toBe(0o600);
    const second = backupSettings(fx.real, bytes, { env: fx.env, now });
    expect(path.basename(second)).toBe('settings-20261014T153012Z-2.json');
  });

  it('uses a hashed prefix for project files', () => {
    const fx = settingsFixture({ data: base });
    const other = path.join(fx.dir, 'proj', '.claude', 'settings.local.json');
    const name = path.basename(backupSettings(other, Buffer.from('{}'), { env: fx.env, now }));
    expect(name).toMatch(/^project-[0-9a-f]{8}-20261014T153012Z\.json$/);
  });

  it('keeps the newest 10 per prefix and never rotates the original', () => {
    const fx = settingsFixture({ data: base });
    const other = path.join(fx.dir, 'proj', 'settings.json');
    ensureOriginal(fx.real, Buffer.from('{}'), { env: fx.env });
    const project = backupSettings(other, Buffer.from('{}'), { env: fx.env, now: at(-100) });
    for (let i = 0; i < 11; i++) backupSettings(fx.real, Buffer.from(`${i}`), { env: fx.env, now: at(i) });
    const last = backupSettings(fx.real, Buffer.from('dup'), { env: fx.env, now: at(10) });
    expect(path.basename(last)).toBe('settings-20261014T153022Z-2.json');
    const names = list(fx.env);
    const stamped = names.filter((n) => /^settings-\d{8}T/.test(n));
    expect(stamped).toHaveLength(10);
    expect(stamped).not.toContain('settings-20261014T153012Z.json');
    expect(stamped).not.toContain('settings-20261014T153013Z.json');
    expect(stamped).toContain('settings-20261014T153022Z.json');
    expect(stamped).toContain('settings-20261014T153022Z-2.json');
    expect(names).toContain('settings-original.json');
    expect(names).toContain(path.basename(project));
  });

  it('never rotates a backup the manifest restores from', () => {
    const fx = settingsFixture({ data: base });
    const pinned = backupSettings(fx.real, Buffer.from('pinned'), { env: fx.env, now: at(-50) });
    const manifest = path.join(fx.env.CCINFOBAR_CONFIG_DIR ?? '', 'manifest.json');
    const backup = path.relative(fx.env.CCINFOBAR_CONFIG_DIR ?? '', pinned);
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, entries: [{ restore: { backup, hash: 'x' } }] }));
    for (let i = 0; i < 12; i++) backupSettings(fx.real, Buffer.from(`${i}`), { env: fx.env, now: at(i) });
    expect(fs.readFileSync(pinned, 'utf8')).toBe('pinned');
    expect(list(fx.env).filter((n) => /^settings-\d{8}T/.test(n))).toHaveLength(11);
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, entries: [] }));
    backupSettings(fx.real, Buffer.from('next'), { env: fx.env, now: at(20) });
    expect(fs.existsSync(pinned)).toBe(false);
  });

  it('writes the original once and prefers the legacy backup', () => {
    const fx = settingsFixture({ data: base });
    const legacy = `${fx.file}.ccinfobar-backup`;
    fs.writeFileSync(legacy, '{"legacy":true}');
    const orig = ensureOriginal(fx.real, Buffer.from('{"now":1}'), { env: fx.env, legacyFile: legacy });
    expect(orig).toBe(path.join(backupsDir(fx.env), 'settings-original.json'));
    expect(fs.readFileSync(orig ?? '', 'utf8')).toBe('{"legacy":true}');
    if (posix) expect(fs.statSync(orig ?? '').mode & 0o777).toBe(0o600);
    expect(ensureOriginal(fx.real, Buffer.from('{"later":1}'), { env: fx.env })).toBeNull();
    expect(fs.readFileSync(orig ?? '', 'utf8')).toBe('{"legacy":true}');
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('backs up once per changing patch and never for a no-op', () => {
    const fx = settingsFixture({ data: base });
    const before = fs.readFileSync(fx.real);
    const res = patchSettings(fx.file, setLine, { env: fx.env });
    expect(res.backup).not.toBeNull();
    expect(fs.readFileSync(res.backup ?? '').equals(before)).toBe(true);
    expect(list(fx.env).filter((n) => n !== 'settings-original.json')).toEqual([
      path.basename(res.backup ?? ''),
    ]);
    expect(fs.readFileSync(path.join(backupsDir(fx.env), 'settings-original.json')).equals(before)).toBe(
      true,
    );
    expect(patchSettings(fx.file, setLine, { env: fx.env }).backup).toBeNull();
    expect(list(fx.env)).toHaveLength(2);
    expect(patchSettings(fx.file, (d) => ({ ...d, x: 1 }), { env: fx.env, backup: false }).backup).toBeNull();
    expect(list(fx.env)).toHaveLength(2);
  });

  it('restores bytes and deletes with a backup first', () => {
    const fx = settingsFixture({ data: base, mode: 0o600 });
    const old = fs.readFileSync(fx.real);
    const res = writeSettingsBytes(fx.file, Buffer.from('{"x":1}'), { env: fx.env });
    expect(res.changed).toBe(true);
    expect(fs.readFileSync(res.backup ?? '').equals(old)).toBe(true);
    expect(fs.readFileSync(fx.file, 'utf8')).toBe('{"x":1}');
    if (posix) expect(fs.statSync(fx.file).mode & 0o777).toBe(0o600);
    expect(writeSettingsBytes(fx.file, Buffer.from('{"x":1}'), { env: fx.env }).changed).toBe(false);
    const del = deleteSettingsFile(fx.file, { env: fx.env });
    expect(fs.readFileSync(del?.backup ?? '', 'utf8')).toBe('{"x":1}');
    expect(fs.existsSync(fx.file)).toBe(false);
  });

  it('does not delete a file that changed since it was read', () => {
    const fx = settingsFixture({ data: { x: 1 } });
    const read = readSettings(fx.file);
    fs.writeFileSync(fx.file, '{"x":1,"added":true}');
    expect(deleteSettingsFile(fx.file, { env: fx.env, ifHash: read.hash })).toBeNull();
    expect(JSON.parse(fs.readFileSync(fx.file, 'utf8'))).toEqual({ x: 1, added: true });
    const late = deleteSettingsFile(fx.file, {
      env: fx.env,
      beforeRename: () => fs.writeFileSync(fx.file, '{"late":true}'),
    });
    expect(late).toBeNull();
    expect(JSON.parse(fs.readFileSync(fx.file, 'utf8'))).toEqual({ late: true });
  });
});
