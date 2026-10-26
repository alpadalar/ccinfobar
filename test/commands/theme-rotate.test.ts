import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { runTheme } from '../../src/commands/manage.js';
import { SCHEMA_URL } from '../../src/core/config.js';
import { withEnvLang } from '../helpers.js';

const root = path.join(process.env.CCINFOBAR_CONFIG_DIR!, 'theme-rotate');

const file = (name: string, body: object): string => {
  fs.mkdirSync(root, { recursive: true });
  const f = path.join(root, name);
  fs.writeFileSync(f, JSON.stringify(body));
  return f;
};

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

const run = (f: string, ...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const error = vi
    .spyOn(console, 'error')
    .mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  let code: typeof process.exitCode;
  try {
    runTheme(parseArgs(['theme', ...argv, '--config', f]), f);
    code = process.exitCode;
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = undefined;
  }
  return { out, err, code };
};

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('theme rotate', () => {
  it('writes a rotation and keeps other keys', () => {
    const f = file('a.json', { theme: 'classic', icons: 'emoji', lines: [[{ type: 'model' }]] });
    const r = run(f, 'rotate', 'nord', 'dracula', '--every', 'hour', '--shuffle');
    expect(r.code).toBeUndefined();
    expect(r.out[0]).toBe('✓ Theme rotation saved');
    expect(r.out[1]).toMatch(
      /^Theme rotation: 2 themes, every hour, shuffled; now (Nord|Dracula), next change /,
    );
    const cfg = read(f);
    expect(cfg.$schema).toBe(SCHEMA_URL);
    expect(cfg.themeRotation).toEqual({ themes: ['nord', 'dracula'], every: 'hour', order: 'shuffle' });
    expect(cfg.icons).toBe('emoji');
    expect(cfg.theme).toBe('classic');
  });

  it('patches an existing rotation with flags', () => {
    const f = file('b.json', {
      themeRotation: { themes: ['nord', 'dracula'], every: 'hour', order: 'shuffle' },
    });
    run(f, 'rotate', '--every', '45');
    expect(read(f).themeRotation).toEqual({ themes: ['nord', 'dracula'], every: 45, order: 'shuffle' });
    run(f, 'rotate', '--cycle');
    expect(read(f).themeRotation).toEqual({ themes: ['nord', 'dracula'], every: 45 });
    run(f, 'rotate', '--weekdays', 'mon=nord,fri=dracula');
    expect(read(f).themeRotation.weekdays).toEqual({ mon: 'nord', fri: 'dracula' });
    const s = run(f, 'rotate');
    expect(s.out[0]).toContain(', weekdays mon=nord,fri=dracula;');
    run(f, 'rotate', '--weekdays', 'off');
    expect(read(f).themeRotation).toEqual({ themes: ['nord', 'dracula'], every: 45 });
    run(f, 'rotate', '--every', 'day');
    expect(read(f).themeRotation).toEqual({ themes: ['nord', 'dracula'] });
  });

  it('rejects bad input without writing', () => {
    const f = file('c.json', { themeRotation: { themes: ['nord'] } });
    const before = fs.readFileSync(f, 'utf8');
    for (const argv of [
      ['rotate', 'ghost'],
      ['rotate', '../nord'],
      ['rotate', '--every', '0x'],
      ['rotate', '--weekdays', 'xyz=nord'],
      ['rotate', '--weekdays', 'mon=ghost'],
      ['rotate', '--weekdays'],
    ]) {
      const r = run(f, ...argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err[0]?.startsWith('✗ '), argv.join(' ')).toBe(true);
      expect(fs.readFileSync(f, 'utf8')).toBe(before);
    }
    expect(run(f, 'rotate', 'ghost').err[0]).toBe(
      '✗ Unknown theme "ghost". Run `ccinfobar themes` to list them.',
    );
  });

  it('needs a theme before flags alone can start a rotation', () => {
    const f = file('d.json', {});
    const r = run(f, 'rotate', '--every', 'week');
    expect(r.code).toBe(1);
    expect(read(f)).toEqual({});
  });

  it('turns rotation off', () => {
    const f = file('e.json', { theme: 'nord', themeRotation: { themes: ['dracula'] } });
    expect(run(f, 'rotate', 'off').out).toEqual(['✓ Theme rotation turned off']);
    expect('themeRotation' in read(f)).toBe(false);
    expect(read(f).theme).toBe('nord');
    expect(run(f, 'rotate', 'off').out).toEqual(['Theme rotation is already off']);
  });

  it('shows the status in theme output', () => {
    const f = file('f.json', { theme: 'nord', themeRotation: { themes: ['dracula'] } });
    const r = run(f);
    expect(r.out[0]).toBe('Nord (nord), style powerline');
    expect(r.out[1]).toMatch(/^Theme rotation: 1 theme, every day, in order; now Dracula, next change /);
    const plain = file('g.json', { theme: 'nord' });
    expect(run(plain).out).toEqual([
      'Nord (nord), style powerline',
      'Run `ccinfobar themes` to see all themes.',
    ]);
    expect(run(plain, 'rotate').out).toEqual([
      'Theme rotation is off. Start it with `ccinfobar theme rotate <id...>`.',
    ]);
    const tr = withEnvLang('tr', () => run(f));
    expect(tr.out[1]).toMatch(/^Tema döngüsü: 1 tema, her gün, sırayla; şu an Dracula, sonraki değişim /);
  });

  it('says rotation is active after picking a theme', () => {
    const f = file('h.json', { themeRotation: { themes: ['dracula'] } });
    const r = run(f, 'nord');
    expect(r.out[0]).toBe('✓ Theme set to Nord');
    expect(r.out[1]).toContain('`ccinfobar theme rotate off`');
    expect(read(f).themeRotation).toEqual({ themes: ['dracula'] });
  });
});

describe('doctor theme rotation', () => {
  it('prints the rotation and missing ids', () => {
    const f = file('doc.json', { themeRotation: { themes: ['nord', 'ghost'], weekdays: { mon: 'gone' } } });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let out: string[];
    try {
      runDoctor(f);
      out = spy.mock.calls.map((c) => c.map(String).join(' '));
    } finally {
      spy.mockRestore();
    }
    expect(out.some((l) => l.startsWith('  Theme rotation: 2 themes'))).toBe(true);
    expect(out).toContain('  ⚠ Theme rotation lists themes that do not exist and are skipped: ghost, gone');
  });
});
