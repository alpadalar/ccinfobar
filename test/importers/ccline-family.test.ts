import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importCcometixline } from '../../src/importers/ccometixline.js';
import { CCLINE_THEMES } from '../../src/importers/ccometixline-themes.js';
import { detectTool, importFrom, resolveSource } from '../../src/importers/index.js';
import { parseToml } from '../../src/importers/toml.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const fixture = (f: string) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-family-')));
  env = { HOME: home, USERPROFILE: home };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

const MINI = '[style]\nmode = "plain"\nseparator = " / "\n\n[[segments]]\nid = "model"\nenabled = true\n';

describe('best-claude-hud', () => {
  const config = () => path.join(home, '.claude', 'best-claude-hud', 'config.toml');
  const theme = (name: string) => path.join(home, '.claude', 'best-claude-hud', 'themes', `${name}.toml`);

  it('maps its config.toml exactly like CCometixLine', () => {
    const file = write(config(), fixture('best-claude-hud.toml'));
    const r = importFrom('best-claude-hud', { env });
    const same = importCcometixline(parseToml(fixture('best-claude-hud.toml')));
    expect(r.source).toBe('best-claude-hud');
    expect(r.file).toBe(file);
    expect(r.config).toEqual(same.config);
    expect(r.notes).toEqual([]);
    expect(r.config.style).toBe('powerline');
    expect(r.config.lines![0]!.map((i) => i.type)).toEqual([
      'cwd',
      'model',
      'git-branch',
      'git-status',
      'context-percentage',
      'session-duration',
      'lines-changed',
    ]);
  });

  it('names best-claude-hud in its notes', () => {
    write(config(), `${MINI}\n[[segments]]\nid = "update"\nenabled = true\n`);
    expect(importFrom('best-claude-hud', { env }).notes).toEqual([
      { kind: 'drop', text: 'best-claude-hud segment "update" was dropped: ccinfobar updates itself' },
    ]);
  });

  it('imports the default layout when there is no config', () => {
    const r = importFrom('best-claude-hud', { env });
    expect(r.file).toBeNull();
    expect(r.source).toBe('best-claude-hud');
    expect(r.config).toEqual(importCcometixline(CCLINE_THEMES.default).config);
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: 'no best-claude-hud config file found, imported its default layout',
    });
  });

  it('never reads the CCometixLine config', () => {
    write(path.join(home, '.claude', 'ccline', 'config.toml'), MINI);
    expect(importFrom('best-claude-hud', { env }).file).toBeNull();
  });

  it('reads -t from the built-in themes or its themes folder', () => {
    write(config(), MINI);
    const nord = importFrom('best-claude-hud', { env, command: 'best-claude-hud -t nord' });
    expect(nord.file).toBeNull();
    expect(nord.config).toEqual(importCcometixline(CCLINE_THEMES.nord).config);
    expect(nord.notes[0]).toEqual({
      kind: 'info',
      text: 'best-claude-hud theme "nord" is set in the status line command, imported its built-in theme',
    });
    const file = write(theme('nord'), fixture('ccline-theme.toml'));
    const own = importFrom('best-claude-hud', { env, command: 'best-claude-hud --theme nord' });
    expect(own.file).toBe(file);
    expect(own.config.separator).toBe(' » ');
    expect(own.notes[0]!.text).toBe(
      `best-claude-hud theme "nord" is set in the status line command, read from ${path.join('~', '.claude', 'best-claude-hud', 'themes', 'nord.toml')}`,
    );
  });

  it('ignores an unsafe theme name and reads config.toml', () => {
    const file = write(config(), MINI);
    const r = importFrom('best-claude-hud', { env, command: 'best-claude-hud -t ../x' });
    expect(r.file).toBe(file);
    expect(r.config.separator).toBe(' / ');
    expect(r.notes).toEqual([
      {
        kind: 'info',
        text: 'best-claude-hud theme "../x" in the status line command is not a safe theme name and was ignored',
      },
    ]);
  });

  it('lets --file win over the theme flag', () => {
    const file = path.join(FIXTURES, 'best-claude-hud.toml');
    const r = importFrom('best-claude-hud', { env, file, command: 'best-claude-hud -t nord' });
    expect(r.file).toBe(file);
    expect(r.config.style).toBe('powerline');
    expect(r.notes).toEqual([]);
  });

  it('is detected as best-claude-hud, never as claude-hud', () => {
    const cmd = '~/.claude/best-claude-hud/best-claude-hud';
    expect(detectTool(cmd)).toMatchObject({
      tool: 'best-claude-hud',
      name: 'best-claude-hud',
      importable: true,
    });
    expect(detectTool('best-claude-hud -t nord')!.tool).toBe('best-claude-hud');
    expect(detectTool('claude-hud')!.tool).toBe('claude-hud');
    expect(detectTool('node ~/.claude/plugins/claude-hud/dist/index.js')!.tool).toBe('claude-hud');
    expect(resolveSource('best-claude-hud')).toBe('best-claude-hud');
  });

  it('writes notes in Turkish', () => {
    withLang('tr', () => {
      expect(importFrom('best-claude-hud', { env }).notes[0]!.text).toBe(
        'best-claude-hud yapılandırma dosyası bulunamadı, varsayılan düzeni içe aktarıldı',
      );
    });
  });
});
