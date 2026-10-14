import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  hashBytes,
  patchSettings,
  readSettings,
  SettingsParseError,
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
      expect(() => readSettings(fx.file)).toThrow(/Cannot parse/);
      expect(fs.readFileSync(fx.file).equals(before)).toBe(true);
    }
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

  it('hashes bytes with a sha256 prefix', () => {
    expect(hashBytes(Buffer.from('x'))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashBytes('x')).toBe(hashBytes(Buffer.from('x')));
  });
});
