import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectTool, importFrom } from '../../src/importers/index.js';
import { importTokenTracker, TARGETS } from '../../src/importers/token-tracker.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FILE = path.join(__dirname, '../fixtures/import/token-tracker.json');
const fixture = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

type R = ReturnType<typeof importTokenTracker>;
const types = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);

const LAYOUT = [
  ['project-dir', 'git-branch', 'git-changes', 'tokens-total', 'session-cost', 'lines-changed'],
  ['five-hour-usage', 'five-hour-reset', 'weekly-usage', 'weekly-reset', 'context-bar'],
  ['tokens-input', 'tokens-output', 'tokens-cached', 'output-speed'],
  ['model', 'effort', 'fast-mode', 'session-duration', 'git-repo'],
];
const APPROX = [
  'token-tracker "Total" is approximated by the tokens-total widget',
  'token-tracker "cache" is approximated by the tokens-cached widget',
  'token-tracker "Remote" is approximated by the git-repo widget',
];

describe('importTokenTracker', () => {
  it('maps the fixture onto the four fixed rows with its theme', () => {
    const r = importTokenTracker(fixture());
    expect(r.source).toBe('token-tracker');
    expect(types(r)).toEqual(LAYOUT);
    expect(r.config).toMatchObject({ theme: 'nord', style: 'text', separator: ' | ' });
    expect(item(r, 'five-hour-usage')!.options).toEqual({ display: 'bar', width: 8 });
    expect(item(r, 'weekly-usage')!.options).toEqual({ display: 'bar', width: 8 });
    expect(item(r, 'context-bar')!.options).toEqual({ width: 8 });
    expect(item(r, 'fast-mode')!.options).toEqual({ showOff: true });
    expect(item(r, 'lines-changed')!.options).toEqual({ hideZero: true });
    expect(r.notes).toEqual([
      ...APPROX.map((text) => ({ kind: 'approx', text })),
      {
        kind: 'info',
        text: 'token-tracker language "en" was not imported: ccinfobar keeps its own language setting',
      },
    ]);
  });

  it('maps the themes and falls back to mocha', () => {
    const theme = (name: unknown) => importTokenTracker({ theme: name });
    expect(theme('latte').config.theme).toBe('catppuccin-latte');
    expect(theme('frappe').config.theme).toBe('catppuccin-frappe');
    expect(theme(' Macchiato ').config.theme).toBe('catppuccin-macchiato');
    expect(theme('dracula').config.theme).toBe('dracula');
    expect(theme('light').config.theme).toBe('catppuccin-latte');
    const auto = theme('auto');
    expect(auto.config.theme).toBe('catppuccin-mocha');
    expect(texts(auto)[0]).toBe('token-tracker theme "auto" is approximated by the catppuccin-mocha theme');
    const neon = theme('neon');
    expect(neon.config.theme).toBe('catppuccin-mocha');
    expect(texts(neon)[0]).toBe(
      'token-tracker theme "neon" has no ccinfobar equivalent, used the catppuccin-mocha theme',
    );
    expect(texts(theme(3))[0]).toContain('theme "3" has no ccinfobar equivalent');
  });

  it('imports the mocha default with the default layout note', () => {
    const r = importTokenTracker({}, { defaulted: true });
    expect(types(r)).toEqual(LAYOUT);
    expect(r.config.theme).toBe('catppuccin-mocha');
    expect(texts(r)).toEqual(['no token-tracker config file found, imported its default layout', ...APPROX]);
  });

  it('ignores a file that is not a JSON object', () => {
    const r = importTokenTracker([1], { file: '~/.config/token-tracker/config.json' });
    expect(r.config.theme).toBe('catppuccin-mocha');
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: '~/.config/token-tracker/config.json is not a JSON object and was ignored',
    });
  });

  it('ignores prototype keys', () => {
    const r = importTokenTracker(JSON.parse('{"__proto__": {"theme": "nord"}, "toString": "x"}'));
    expect(r.config.theme).toBe('catppuccin-mocha');
    expect(texts(r)).toEqual(APPROX);
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      const r = importTokenTracker({ theme: 'auto', lang: 'zh' });
      expect(texts(r)[0]).toBe(
        'token-tracker teması "auto", catppuccin-mocha temasıyla yaklaşık olarak gösteriliyor',
      );
      expect(texts(r).at(-1)).toBe(
        'token-tracker dili "zh" içe aktarılmadı: ccinfobar kendi dil ayarını korur',
      );
    });
  });
});

describe('token-tracker importer', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-tt-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.config', 'token-tracker'), { recursive: true });
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const homeFile = () => path.join(env.HOME!, '.config', 'token-tracker', 'config.json');

  it('reads --file', () => {
    const r = importFrom('token-tracker', { file: FILE, env, cwd: dir });
    expect(r.file).toBe(FILE);
    expect(r.config.theme).toBe('nord');
  });

  it('reads ~/.config/token-tracker/config.json, else imports the default', () => {
    const none = importFrom('token-tracker', { env, cwd: dir });
    expect(none.file).toBeNull();
    expect(none.config.theme).toBe('catppuccin-mocha');
    expect(texts(none)[0]).toBe('no token-tracker config file found, imported its default layout');
    fs.writeFileSync(homeFile(), '{"theme": "latte"}');
    const r = importFrom('token-tracker', { env, cwd: dir });
    expect(r.file).toBe(homeFile());
    expect(r.config.theme).toBe('catppuccin-latte');
    fs.writeFileSync(homeFile(), '{"theme": ');
    expect(() => importFrom('token-tracker', { env, cwd: dir })).toThrow(/Cannot parse token-tracker config/);
  });

  it('never reads XDG_CONFIG_HOME', () => {
    const xdg = path.join(dir, 'xdg');
    fs.mkdirSync(path.join(xdg, 'token-tracker'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'token-tracker', 'config.json'), '{"theme": "dracula"}');
    fs.writeFileSync(homeFile(), '{"theme": "frappe"}');
    const r = importFrom('token-tracker', { env: { ...env, XDG_CONFIG_HOME: xdg }, cwd: dir });
    expect(r.file).toBe(homeFile());
    expect(r.config.theme).toBe('catppuccin-frappe');
  });

  it('is detected from the commands tt setup writes', () => {
    for (const cmd of [
      '"/usr/bin/python3" "/home/u/.config/token-tracker/claude-statusline.py"',
      '"C:/Users/u/AppData/Local/Programs/Python/python.exe" "C:/Users/u/.config/token-tracker/claude-statusline.py"',
      'python3 ~/.claude/tt-statusline.py',
    ]) {
      expect(detectTool(cmd), cmd).toMatchObject({ tool: 'token-tracker', importable: true });
    }
    expect(detectTool('python3 ~/.config/token-tracker/codex-statusline.py')?.tool).not.toBe('token-tracker');
    expect(detectTool('claude-statusline')?.tool).not.toBe('token-tracker');
  });
});
