import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importGlauberlima, TARGETS } from '../../src/importers/glauberlima-statusline.js';
import { detectTool, importFrom, resolveSource } from '../../src/importers/index.js';
import { parseToml } from '../../src/importers/toml.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FILE = path.join(__dirname, '../fixtures/import/glauberlima-statusline.toml');
const fixture = () => parseToml(fs.readFileSync(FILE, 'utf8'));

type R = ReturnType<typeof importGlauberlima>;
const types = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);

const FIXED = ['cwd', 'git-branch', 'git-status', 'model', 'context-bar', 'context-length'];
const FILES = 'glauberlima-statusline "files" is approximated by the git-status widget';

describe('importGlauberlima', () => {
  it('maps the fixture onto the fixed layout with its theme and bar style', () => {
    const r = importGlauberlima(fixture());
    expect(r.source).toBe('glauberlima-statusline');
    expect(types(r)).toEqual([FIXED]);
    expect(item(r, 'context-bar')!.options).toEqual({ width: 15, barColor: 'gradient' });
    expect(item(r, 'context-length')!.options).toEqual({ showMax: true });
    expect(r.config).toMatchObject({ theme: 'tokyo-night', style: 'text', separator: ' | ', icons: 'emoji' });
    expect(r.notes).toEqual([
      { kind: 'approx', text: FILES },
      {
        kind: 'drop',
        text: 'glauberlima-statusline messages was not imported: ccinfobar shows no context messages',
      },
    ]);
  });

  it('imports the defaults with cost and the classic theme', () => {
    const r = importGlauberlima({}, { defaulted: true });
    expect(types(r)).toEqual([[...FIXED, 'session-cost']]);
    expect(item(r, 'context-bar')!.options).toEqual({ width: 15 });
    expect(r.config.theme).toBe('classic');
    expect(texts(r)).toEqual([
      'no glauberlima-statusline config file found, imported its default layout',
      FILES,
    ]);
  });

  it('maps every theme', () => {
    const theme = (name: string) => importGlauberlima({ theme: name }).config.theme;
    expect(theme('default')).toBe('classic');
    expect(theme('dracula')).toBe('dracula');
    expect(theme('one-dark')).toBe('one-dark');
    expect(theme('solarized-dark')).toBe('solarized');
    const phosphor = importGlauberlima({ theme: 'phosphor' });
    expect(phosphor.config.theme).toBe('matrix');
    expect(phosphor.notes).toContainEqual({
      kind: 'approx',
      text: 'glauberlima-statusline theme "phosphor" is approximated by the matrix theme',
    });
    const neon = importGlauberlima({ theme: 'neon' });
    expect(neon.config.theme).toBe('classic');
    expect(texts(neon)).toContain(
      'glauberlima-statusline theme "neon" has no ccinfobar equivalent, used the classic theme',
    );
  });

  it('notes approximate and unknown bar styles', () => {
    const bar = (s: string) => importGlauberlima({ usage_bar_style: s });
    expect(item(bar('plain'), 'context-bar')!.options).toEqual({ width: 15 });
    const rainbow = bar('rainbow');
    expect(item(rainbow, 'context-bar')!.options).toEqual({ width: 15, barColor: 'gradient' });
    expect(texts(rainbow)[0]).toBe(
      'glauberlima-statusline bar style "rainbow" is approximated by the gradient bar color',
    );
    const gsd = bar('gsd');
    expect(item(gsd, 'context-bar')!.options).toEqual({ width: 15 });
    expect(texts(gsd)[0]).toBe(
      'glauberlima-statusline bar style "gsd" is approximated by the solid bar color',
    );
    expect(texts(bar('dracula'))[0]).toContain('"dracula" is approximated by the gradient bar color');
    const neon = bar('neon');
    expect(item(neon, 'context-bar')!.options).toEqual({ width: 15 });
    expect(texts(neon)[0]).toBe(
      'glauberlima-statusline style "neon" is unknown, imported its default style (plain)',
    );
  });

  it('keeps the defaults for wrong types and names unknown keys', () => {
    const r = importGlauberlima({ cost: 'no', messages: 1, extra: true, toString: 1 });
    expect(types(r)[0]).toContain('session-cost');
    expect(texts(r)).toEqual([FILES, 'glauberlima-statusline settings not imported: extra, toString']);
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      const r = importGlauberlima({ messages: true, usage_bar_style: 'rainbow' });
      expect(texts(r)).toEqual([
        'glauberlima-statusline çubuk stili "rainbow", gradient çubuk rengiyle yaklaşık olarak gösteriliyor',
        'glauberlima-statusline "files", git-status bileşeniyle yaklaşık olarak gösteriliyor',
        'glauberlima-statusline messages içe aktarılmadı: ccinfobar bağlam mesajları göstermez',
      ]);
    });
  });
});

describe('glauberlima-statusline importer', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-glauberlima-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const homeFile = () => path.join(env.HOME!, '.claude', 'statusline.toml');

  it('reads --file and resolves its alias', () => {
    const r = importFrom('glauberlima-statusline', { file: FILE, env, cwd: dir });
    expect(r.file).toBe(FILE);
    expect(r.config.theme).toBe('tokyo-night');
    expect(resolveSource('glauberlima')).toBe('glauberlima-statusline');
  });

  it('reads statusline.toml next to the binary, else ~/.claude/statusline.toml, else the defaults', () => {
    const bin = path.join(dir, 'bin', 'statusline');
    fs.mkdirSync(path.dirname(bin));
    const command = `"${bin}"`;
    const none = importFrom('glauberlima-statusline', { command, env, cwd: dir });
    expect(none.file).toBeNull();
    expect(texts(none)[0]).toBe('no glauberlima-statusline config file found, imported its default layout');
    fs.writeFileSync(homeFile(), 'theme = "dracula"\n');
    const home = importFrom('glauberlima-statusline', { command, env, cwd: dir });
    expect(home.file).toBe(homeFile());
    expect(home.config.theme).toBe('dracula');
    const beside = path.join(dir, 'bin', 'statusline.toml');
    fs.writeFileSync(beside, 'theme = "one-dark"\n');
    const r = importFrom('glauberlima-statusline', { command, env, cwd: dir });
    expect(r.file).toBe(beside);
    expect(r.config.theme).toBe('one-dark');
    const tilde = importFrom('glauberlima-statusline', { command: '~/.claude/statusline', env, cwd: dir });
    expect(tilde.file).toBe(homeFile());
  });

  it('never reads statusline.toml next to another binary', () => {
    fs.mkdirSync(path.join(dir, 'other'));
    fs.writeFileSync(path.join(dir, 'other', 'statusline.toml'), 'theme = "one-dark"\n');
    const command = `node "${path.join(dir, 'other', 'run.js')}"`;
    const r = importFrom('glauberlima-statusline', { command, env, cwd: dir });
    expect(r.file).toBeNull();
  });

  it('reports a TOML error with the line', () => {
    fs.writeFileSync(homeFile(), 'theme = \n');
    expect(() => importFrom('glauberlima-statusline', { env, cwd: dir })).toThrow(/statusline\.toml:1:/);
  });

  it('is detected from the bare binary path only', () => {
    for (const cmd of [
      '/home/u/.claude/statusline',
      '~/.claude/statusline',
      '~/.claude/statusline.exe',
      '"C:\\Users\\u\\.claude\\statusline.exe"',
    ]) {
      expect(detectTool(cmd), cmd).toMatchObject({ tool: 'glauberlima-statusline', importable: true });
    }
    for (const cmd of [
      'bash ~/.claude/statusline.sh',
      'bash ~/.claude/statusline/statusline.sh',
      '~/.claude/statusline --print-defaults',
    ]) {
      expect(detectTool(cmd)?.tool, cmd).not.toBe('glauberlima-statusline');
    }
  });
});
