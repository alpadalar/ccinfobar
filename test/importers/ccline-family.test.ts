import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { PromptIo } from '../../src/commands/io.js';
import { runImport, runImportCommand } from '../../src/commands/manage.js';
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
  process.exitCode = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});

const fakeIo = () => {
  const lines: string[] = [];
  const io: PromptIo = {
    tty: false,
    ask: async (_q, fallback) => fallback,
    log: (l) => lines.push(l),
    error: (l) => lines.push(l),
    columns: 100,
  };
  return { io, lines };
};

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

describe('byebyecode', () => {
  const config = () => path.join(home, '.claude', 'byebyecode', 'config.toml');
  const FILE = path.join(FIXTURES, 'byebyecode.toml');
  const SECRET = 'REDACTED-TEST';
  const types = (lines: { type: string }[][] | undefined) => (lines ?? []).map((l) => l.map((i) => i.type));
  const withBreak = (n: string) =>
    fixture('byebyecode.toml').replace('line_break_after = 3', n ? `line_break_after = ${n}` : '');

  it('splits after line_break_after mapped segments and drops the 88code segment by name', () => {
    const file = write(config(), fixture('byebyecode.toml'));
    const r = importFrom('byebyecode', { env });
    expect(r.source).toBe('byebyecode');
    expect(r.file).toBe(file);
    expect(types(r.config.lines)).toEqual([
      ['model', 'cwd', 'git-branch', 'git-status'],
      ['context-percentage', 'session-cost'],
    ]);
    expect(r.notes).toEqual([
      {
        kind: 'drop',
        text: 'byebyecode segment "bye_bye_code_usage" has no ccinfobar equivalent and was skipped',
      },
      {
        kind: 'approx',
        text: 'byebyecode breaks the line after 3 segments: the remaining widgets start a second line (byebyecode counts only segments that show something, so the split can differ)',
      },
    ]);
  });

  it('drops every 88code segment by id only', () => {
    const extra = ['bye_bye_code_subscription', 'bye_bye_code_status']
      .map(
        (id) => `\n[[segments]]\nid = "${id}"\nenabled = true\n[segments.options]\napi_key = "${SECRET}"\n`,
      )
      .join('');
    write(config(), `${MINI}${extra}`);
    const r = importFrom('byebyecode', { env });
    expect(r.notes.map((n) => n.text)).toEqual([
      'byebyecode segment "bye_bye_code_subscription" has no ccinfobar equivalent and was skipped',
      'byebyecode segment "bye_bye_code_status" has no ccinfobar equivalent and was skipped',
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('keeps one line for a missing, zero, negative, fractional or too large break', () => {
    for (const n of ['', '0', '-2', '2.5', '5', '9', '"3"']) {
      write(config(), withBreak(n));
      const r = importFrom('byebyecode', { env });
      expect(r.config.lines!.length, n).toBe(1);
      expect(
        r.notes.some((x) => x.kind === 'approx'),
        n,
      ).toBe(false);
    }
    write(config(), withBreak('4'));
    expect(types(importFrom('byebyecode', { env }).config.lines)[1]).toEqual(['session-cost']);
  });

  it('ignores line_break_after for CCometixLine and best-claude-hud', () => {
    const file = path.join(FIXTURES, 'byebyecode.toml');
    expect(importFrom('best-claude-hud', { env, file }).config.lines!.length).toBe(1);
    expect(importFrom('ccometixline', { file }).config.lines!.length).toBe(1);
  });

  it('never prints the api key', async () => {
    const r = importFrom('byebyecode', { env, file: FILE });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const cfgFile = path.join(home, 'cfg', 'config.json');
    const dry = fakeIo();
    await runImportCommand(parseArgs(['import', 'byebyecode', '--dry-run', '--file', FILE]), cfgFile, dry.io);
    expect(process.exitCode ?? 0, dry.lines.join('\n')).toBe(0);
    expect(dry.lines.join('\n')).toContain('bye_bye_code_usage');
    expect(dry.lines.join('\n')).not.toContain(SECRET);
    const real = fakeIo();
    const flags = { allowCommands: false, yes: true, dryRun: false };
    expect(await runImport('byebyecode', { file: FILE, command: '', flags }, cfgFile, real.io)).toBe(true);
    expect(real.lines.join('\n')).not.toContain(SECRET);
    const saved = fs.readFileSync(cfgFile, 'utf8');
    expect(saved).not.toContain(SECRET);
    expect(JSON.parse(saved).lines).toHaveLength(2);
  });

  it('imports the CCometixLine default layout when there is no config', () => {
    const r = importFrom('byebyecode', { env });
    expect(r.file).toBeNull();
    expect(r.source).toBe('byebyecode');
    expect(r.config).toEqual(importCcometixline(CCLINE_THEMES.default).config);
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: 'no byebyecode config file found, imported its default layout',
    });
  });

  it('reads -t from its own themes folder', () => {
    const file = write(path.join(home, '.claude', 'byebyecode', 'themes', 'mine.toml'), withBreak('1'));
    const r = importFrom('byebyecode', { env, command: 'byebyecode -t mine' });
    expect(r.file).toBe(file);
    expect(r.config.lines!.length).toBe(2);
  });

  it('is detected as byebyecode', () => {
    expect(detectTool('byebyecode')).toMatchObject({
      tool: 'byebyecode',
      name: 'byebyecode',
      importable: true,
    });
    expect(detectTool('npx -y byebyecode@latest')!.tool).toBe('byebyecode');
    expect(resolveSource('ByeByeCode')).toBe('byebyecode');
  });

  it('writes the line break note in Turkish', () => {
    write(config(), withBreak('1'));
    withLang('tr', () => {
      expect(importFrom('byebyecode', { env }).notes.at(-1)!.text).toBe(
        'byebyecode 1 bölümden sonra yeni satıra geçiyor: kalan bileşenler ikinci satıra taşındı (byebyecode yalnızca bir şey gösteren bölümleri saydığından ayrım farklı olabilir)',
      );
    });
  });
});
