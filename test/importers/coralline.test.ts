import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importCoralline, TARGETS } from '../../src/importers/coralline.js';
import { detectTool, importFrom } from '../../src/importers/index.js';
import { parseShellEnv } from '../../src/importers/shell-env.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const CONF = path.join(FIXTURES, 'coralline.conf');
const THEME = path.join(FIXTURES, 'coralline-theme.conf');

type R = ReturnType<typeof importCoralline>;
const types = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);
const run = (text: string, extra: Partial<Parameters<typeof importCoralline>[1]> = {}) => {
  const parsed = parseShellEnv(text);
  return importCoralline(parsed.vars, {
    theme: parsed.includes.at(-1)?.name ?? null,
    themeVars: null,
    themeFile: null,
    skipped: parsed.skipped,
    ...extra,
  });
};

const CTX_NOTE = 'coralline "ctx" is approximated by the context-bar widget';
const CORAL_NOTE = 'coralline theme "claude-coral" is approximated by the classic theme';

describe('importCoralline', () => {
  it('maps the configure.sh fixture: two lines, lean style, nord and the main-file color', () => {
    const r = run(fs.readFileSync(CONF, 'utf8'));
    expect(r.source).toBe('coralline');
    expect(types(r)).toEqual([
      ['cwd', 'git-branch', 'git-status', 'git-ahead-behind', 'model', 'context-bar'],
      ['five-hour-usage', 'five-hour-reset', 'weekly-usage', 'weekly-reset', 'session-cost', 'clock'],
    ]);
    expect(item(r, 'cwd')).toEqual({
      id: 'coralline-dir-cwd',
      type: 'cwd',
      options: { style: 'tilde' },
      color: '#88c0d0',
      bold: true,
    });
    expect(item(r, 'git-branch')!.color).toBeUndefined();
    expect(item(r, 'context-bar')!.options).toEqual({ width: 5, style: 'geometric' });
    expect(item(r, 'five-hour-usage')!.options).toEqual({ display: 'bar', width: 5, style: 'geometric' });
    expect(item(r, 'weekly-usage')!.options).toEqual({ display: 'bar', width: 5, style: 'geometric' });
    expect(item(r, 'session-cost')!.options).toEqual({ decimals: 2 });
    expect(item(r, 'clock')!.options).toEqual({ h12: true });
    expect(r.config).toMatchObject({ theme: 'nord', style: 'text', separator: ' · ', autoWrap: false });
    expect(r.config.charset).toBeUndefined();
    expect(r.notes).toEqual([
      { kind: 'approx', text: CTX_NOTE },
      {
        kind: 'drop',
        text: 'coralline: line 24 is not a plain assignment and was skipped; nothing in the file is run',
      },
    ]);
  });

  it('imports the statusline.sh defaults with the default note', () => {
    const r = importCoralline(
      {},
      { theme: null, themeVars: null, themeFile: null, skipped: [], defaulted: true },
    );
    expect(types(r)).toEqual([
      [
        'cwd',
        'git-branch',
        'git-status',
        'git-ahead-behind',
        'model',
        'context-bar',
        'five-hour-usage',
        'five-hour-reset',
        'weekly-usage',
        'weekly-reset',
        'session-cost',
        'clock',
      ],
    ]);
    expect(item(r, 'clock')!.options).toEqual({ h12: true, seconds: true });
    expect(r.config).toMatchObject({ theme: 'classic', style: 'capsule', autoWrap: false });
    expect(r.config.separator).toBeUndefined();
    expect(texts(r)).toEqual([
      'no coralline config file found, imported its default layout',
      CTX_NOTE,
      CORAL_NOTE,
    ]);
  });

  it('turns auto layout into one wrapping line and maps styles, ascii and the clock', () => {
    const auto = run('VL_LAYOUT=auto\nVL_SEGMENTS="model cost"\nVL_SEGMENTS2=clock\nVL_STYLE=pill\n');
    expect(types(auto)).toEqual([['model', 'session-cost']]);
    expect(auto.config).toMatchObject({ style: 'capsule', autoWrap: true });
    expect(texts(auto)).toContain('coralline layout "auto" became ccinfobar line wrapping (autoWrap)');

    const classic = run('VL_STYLE=classic\nVL_SEGMENTS=model\n');
    expect(classic.config).toMatchObject({ style: 'text', separator: '  ' });
    expect(classic.notes[0]).toEqual({
      kind: 'approx',
      text: 'coralline style "classic" is approximated by the text style',
    });

    const odd = run('VL_STYLE=fancy\nVL_SEGMENTS=model\n');
    expect(odd.config.style).toBe('capsule');
    expect(texts(odd)[0]).toBe('coralline style "fancy" is unknown, imported its default style (pill)');

    const ascii = run('VL_ASCII=1\nVL_BAR_WIDTH=8\nVL_SEGMENTS="ctx limit7d"\n');
    expect(ascii.config.charset).toBe('text');
    expect(item(ascii, 'context-bar')!.options).toEqual({ width: 8, style: 'ascii' });
    expect(item(ascii, 'weekly-usage')!.options).toEqual({ display: 'bar', width: 8, style: 'ascii' });

    const off = run('VL_CLOCK=off\nVL_SEGMENTS="model clock"\n');
    expect(types(off)).toEqual([['model']]);
    expect(off.notes).toContainEqual({
      kind: 'drop',
      text: 'coralline VL_CLOCK is "off", so the clock segment was skipped',
    });
    const h24 = run('VL_CLOCK=24h\nVL_CLOCK_SECONDS=1\nVL_COST_DECIMALS=4\nVL_SEGMENTS="cost clock"\n');
    expect(item(h24, 'clock')!.options).toEqual({ seconds: true });
    expect(item(h24, 'session-cost')!.options).toEqual({ decimals: 4 });
    const bad = run('VL_BAR_WIDTH=999\nVL_COST_DECIMALS=x\nVL_SEGMENTS="ctx cost"\n');
    expect(item(bad, 'context-bar')!.options).toEqual({ width: 5, style: 'geometric' });
    expect(item(bad, 'session-cost')!.options).toEqual({ decimals: 2 });
  });

  it('maps every segment', () => {
    const r = run(
      'VL_SEGMENTS="dir project git model effort ctx cache toks ttft limit5h limit7d burn lines cost style duration stash clock"\n',
    );
    expect(types(r)[0]).toEqual([
      'cwd',
      'git-repo',
      'git-branch',
      'git-status',
      'git-ahead-behind',
      'model',
      'effort',
      'context-bar',
      'cache-hit-rate',
      'cache-timer',
      'output-speed',
      'performance',
      'five-hour-usage',
      'five-hour-reset',
      'weekly-usage',
      'weekly-reset',
      'limit-eta',
      'lines-changed',
      'session-cost',
      'output-style',
      'session-duration',
      'git-stash',
      'clock',
    ]);
    expect(item(r, 'git-repo')!.options).toEqual({ nameOnly: true });
    expect(item(r, 'performance')!.options).toEqual({ show: 'time' });
    expect(item(r, 'limit-eta')!.options).toEqual({ pace: 'recent' });
    expect(item(r, 'lines-changed')!.options).toEqual({ hideZero: true });
    expect(texts(r).slice(0, 2)).toEqual([
      CTX_NOTE,
      'coralline "ttft" is approximated by the performance widget',
    ]);
  });

  it('puts pill colors on the background and the text color on text segments only', () => {
    const r = run(
      'VL_SEGMENTS="dir ctx cost stash"\nVL_BG_DIR="136,192,208"\nVL_BG_CTX=238\nVL_BG_GIT_OK=65\nVL_FG_TEXT=231\nVL_BG_COST=999\n',
    );
    expect(item(r, 'cwd')).toMatchObject({ background: '#88c0d0', color: 'ansi256:231' });
    expect(item(r, 'context-bar')!.background).toBe('ansi256:238');
    expect(item(r, 'context-bar')!.color).toBeUndefined();
    expect(item(r, 'session-cost')!.background).toBeUndefined();
    expect(item(r, 'git-stash')).toMatchObject({ background: 'ansi256:65', color: 'ansi256:231' });
  });

  it('copies the colors of a coralline-only theme file, with main-file colors winning', () => {
    const themeVars = parseShellEnv(fs.readFileSync(THEME, 'utf8')).vars;
    const r = run(
      '. ~/.claude/coralline/themes/claude-coral.conf\nVL_SEGMENTS="dir model cost"\nVL_BG_DIR=33\n',
      {
        themeVars,
        themeFile: '~/.claude/coralline/themes/claude-coral.conf',
      },
    );
    expect(r.config.theme).toBe('classic');
    expect(item(r, 'cwd')).toMatchObject({ background: 'ansi256:33', color: 'ansi256:231' });
    expect(item(r, 'model')).toMatchObject({ background: 'ansi256:173', color: 'ansi256:231' });
    expect(item(r, 'session-cost')).toMatchObject({ background: '#d47d91' });
    expect(r.notes).toContainEqual({
      kind: 'info',
      text: 'coralline theme "claude-coral" colors were read from ~/.claude/coralline/themes/claude-coral.conf',
    });
    expect(texts(r)).not.toContain(CORAL_NOTE);
  });

  it('maps theme names from the include line', () => {
    const themes: Record<string, string> = {
      'catppuccin-mocha': 'catppuccin-mocha',
      'gruvbox-dark': 'gruvbox',
      'tokyo-night': 'tokyo-night',
      nord: 'nord',
      dracula: 'dracula',
      mono: 'mono',
      reverie: 'classic',
      'morning-haze': 'classic',
      'lunar-pink': 'classic',
      'claude-coral': 'classic',
      other: 'classic',
    };
    for (const [name, theme] of Object.entries(themes)) {
      expect(run(`. "$HOME/.claude/coralline/themes/${name}.conf"\n`).config.theme, name).toBe(theme);
    }
    expect(texts(run('. /x/other.conf\n'))).toContain(
      'coralline theme "other" has no ccinfobar equivalent, used the classic theme',
    );
    expect(texts(run('. "/x/my theme.conf"\n'))).toContain(
      'coralline theme "my theme" included in the config is not a safe theme name and was ignored',
    );
  });

  it('drops unknown segments and notes subagent, float, burn and threshold settings', () => {
    const r = run(
      [
        'VL_SEGMENTS="model node python constructor toString model"',
        'VL_SUB_SEGMENTS="name model"',
        'VL_BG_SUB_MODEL=60',
        'VL_FLOAT=1',
        'CORALLINE_BURN_WINDOW=900',
        'VL_PATH_DEPTH=4',
        'VL_NAME_MAX=12',
        'VL_WARN_PCT=60',
        'VL_HOT_PCT=90',
        'EDITOR=vim',
        '',
      ].join('\n'),
    );
    expect(types(r)).toEqual([['model', 'model']]);
    expect(r.config.lines![0]!.map((i) => i.id)).toEqual([
      'coralline-model-model',
      'coralline-model-model-2',
    ]);
    expect(r.notes).toEqual([
      { kind: 'drop', text: 'coralline segment "node" has no ccinfobar equivalent and was skipped' },
      { kind: 'drop', text: 'coralline segment "python" has no ccinfobar equivalent and was skipped' },
      { kind: 'drop', text: 'coralline segment "constructor" has no ccinfobar equivalent and was skipped' },
      { kind: 'drop', text: 'coralline segment "toString" has no ccinfobar equivalent and was skipped' },
      {
        kind: 'approx',
        text: 'coralline bar thresholds 60%/90% became ccinfobar threshold colors (yellow from 50%, red from 80%)',
      },
      { kind: 'drop', text: 'coralline float readout was dropped: ccinfobar does not write a readout file' },
      {
        kind: 'drop',
        text: 'coralline settings not imported: VL_SUB_SEGMENTS, VL_BG_SUB_MODEL, CORALLINE_BURN_WINDOW, VL_NAME_MAX',
      },
      { kind: 'approx', text: CORAL_NOTE },
    ]);
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      const r = run('VL_CLOCK=off\nVL_SEGMENTS="model clock"\n. "/x/a b.conf"\n');
      expect(texts(r)).toEqual([
        'coralline VL_CLOCK değeri "off", bu yüzden saat bölümü atlandı',
        'yapılandırmada dahil edilen coralline teması "a b" güvenli bir tema adı değil, yok sayıldı',
      ]);
      const themed = run('. /x/reverie.conf\nVL_SEGMENTS=model\n', {
        themeVars: {},
        themeFile: '~/t/reverie.conf',
      });
      expect(texts(themed)).toEqual([
        'coralline teması "reverie" renkleri şu dosyadan okundu: ~/t/reverie.conf',
      ]);
    });
  });
});

describe('coralline importer', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-coralline-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const themes = (base = path.join(env.HOME!, '.claude')) => path.join(base, 'coralline', 'themes');
  const writeTheme = (name: string, text: string, base?: string) => {
    const file = path.join(themes(base), `${name}.conf`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const writeConf = (text: string, file = path.join(env.HOME!, '.claude', 'coralline.conf')) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };

  it('reads --file as assignments only', () => {
    const r = importFrom('coralline', { file: CONF, env, cwd: dir });
    expect(r.file).toBe(CONF);
    expect(r.config.theme).toBe('nord');
    expect(types(r)).toHaveLength(2);
  });

  it('finds $CORALLINE_CONFIG, else ~/.claude/coralline.conf, else imports the defaults', () => {
    const none = importFrom('coralline', { env, cwd: dir });
    expect(none.file).toBeNull();
    expect(texts(none)[0]).toBe('no coralline config file found, imported its default layout');

    const home = writeConf('VL_SEGMENTS=model\n');
    const fromHome = importFrom('coralline', { env, cwd: dir });
    expect(fromHome.file).toBe(home);
    expect(types(fromHome)).toEqual([['model']]);

    const own = writeConf('VL_SEGMENTS=cost\n', path.join(dir, 'c.conf'));
    const withEnv = importFrom('coralline', { env: { ...env, CORALLINE_CONFIG: own }, cwd: dir });
    expect(withEnv.file).toBe(own);
    expect(types(withEnv)).toEqual([['session-cost']]);
    const rel = importFrom('coralline', { env: { ...env, CORALLINE_CONFIG: 'c.conf' }, cwd: dir });
    expect(rel.file).toBe(own);
    const tilde = importFrom('coralline', {
      env: { ...env, CORALLINE_CONFIG: '~/.claude/coralline.conf' },
      cwd: dir,
    });
    expect(tilde.file).toBe(home);
  });

  it('takes the themes include over a later overrides include', () => {
    const conf = writeConf(
      '. ~/.claude/coralline/themes/nord.conf\n. ~/.claude/coralline-local.conf\nVL_SEGMENTS=model\n',
    );
    const r = importFrom('coralline', { file: conf, env, cwd: dir });
    expect(r.config.theme).toBe('nord');
    expect(texts(r).join('\n')).toMatch(/line 2\b/);
    expect(texts(r).join('\n')).not.toMatch(/coralline-local/);
  });

  it('reads colors from the themes dir by the include basename, never from the include path', () => {
    const outside = path.join(dir, 'outside', 'reverie.conf');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'VL_BG_MODEL="1,2,3"\n');
    const conf = writeConf(`. "${outside}"\nVL_SEGMENTS="dir model"\n`);
    const opened: string[] = [];
    const real = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((f: fs.PathLike, ...rest: never[]) => {
      opened.push(String(f));
      return (real as (...a: unknown[]) => number)(f, ...rest);
    }) as typeof fs.openSync);
    try {
      const missing = importFrom('coralline', { env, cwd: dir });
      expect(item(missing, 'model')!.background).toBeUndefined();
      expect(texts(missing)).toContain('coralline theme "reverie" is approximated by the classic theme');

      const theme = writeTheme('reverie', fs.readFileSync(THEME, 'utf8'));
      const r = importFrom('coralline', { env, cwd: dir });
      expect(r.file).toBe(conf);
      expect(item(r, 'model')!.background).toBe('ansi256:173');
      expect(item(r, 'cwd')!.background).toBe('#51a6c7');
      expect(r.config.theme).toBe('classic');
      expect(texts(r)).toContain(
        `coralline theme "reverie" colors were read from ${path.join('~', '.claude', 'coralline', 'themes', 'reverie.conf')}`,
      );
      expect(opened).toContain(theme);
      expect(opened).not.toContain(outside);
    } finally {
      spy.mockRestore();
    }
  });

  it('follows the include basename only, rejects unsafe names and skips non-files', () => {
    writeTheme('x', 'VL_BG_MODEL=99\n');
    const r = importFrom('coralline', {
      file: writeConf('. "$HOME/../../etc/x.conf"\nVL_SEGMENTS=model\n'),
      env,
      cwd: dir,
    });
    expect(item(r, 'model')!.background).toBe('ansi256:99');

    fs.writeFileSync(path.join(themes(), 'a..b.conf'), 'VL_BG_MODEL=98\n');
    const unsafe = importFrom('coralline', {
      file: writeConf('. /x/a..b.conf\nVL_SEGMENTS=model\n'),
      env,
      cwd: dir,
    });
    expect(item(unsafe, 'model')!.background).toBeUndefined();
    expect(texts(unsafe)).toContain(
      'coralline theme "a..b" included in the config is not a safe theme name and was ignored',
    );

    fs.mkdirSync(path.join(themes(), 'lunar-pink.conf'), { recursive: true });
    const isDir = importFrom('coralline', {
      file: writeConf('. /x/lunar-pink.conf\nVL_SEGMENTS=model\n'),
      env,
      cwd: dir,
    });
    expect(item(isDir, 'model')!.background).toBeUndefined();
    expect(texts(isDir)).toContain('coralline theme "lunar-pink" is approximated by the classic theme');
  });

  it('never reads a theme file for an exact built-in theme', () => {
    writeTheme('nord', 'VL_BG_MODEL=97\n');
    const r = importFrom('coralline', {
      file: writeConf('. /x/nord.conf\nVL_SEGMENTS=model\n'),
      env,
      cwd: dir,
    });
    expect(r.config.theme).toBe('nord');
    expect(item(r, 'model')!.background).toBeUndefined();
  });

  it('uses $CLAUDE_CONFIG_DIR/coralline/themes when set', () => {
    const cc = path.join(dir, 'cc');
    writeTheme('morning-haze', 'VL_BG_MODEL=96\n', cc);
    writeTheme('morning-haze', 'VL_BG_MODEL=95\n');
    const file = writeConf('. ~/.claude/coralline/themes/morning-haze.conf\nVL_SEGMENTS=model\n');
    expect(item(importFrom('coralline', { env, cwd: dir }), 'model')!.background).toBe('ansi256:95');
    const r = importFrom('coralline', { file, env: { ...env, CLAUDE_CONFIG_DIR: cc }, cwd: dir });
    expect(item(r, 'model')!.background).toBe('ansi256:96');
  });

  it('reports an unreadable config with the tilde path', () => {
    const file = path.join(env.HOME!, '.claude', 'dir.conf');
    fs.mkdirSync(file);
    expect(() => importFrom('coralline', { file, env, cwd: dir })).toThrow(
      `Cannot read coralline config at ${path.join('~', '.claude', 'dir.conf')}`,
    );
  });

  it('is detected from its status line command', () => {
    expect(detectTool('bash ~/.claude/coralline/statusline.sh')).toMatchObject({
      tool: 'coralline',
      name: 'coralline',
      importable: true,
    });
    expect(detectTool('pwsh -NoProfile -File C:\\Users\\u\\.claude\\coralline\\statusline.ps1')?.tool).toBe(
      'coralline',
    );
    expect(detectTool('bash ~/.claude/coralline/configure.sh')?.tool).toBe('unknown');
  });
});
