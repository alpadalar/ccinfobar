import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { PromptIo } from '../../src/commands/io.js';
import { runImportCommand } from '../../src/commands/manage.js';
import { detectTool, importFrom, resolveSource } from '../../src/importers/index.js';
import { ENV_VARS, importStarshipClaude, TARGETS } from '../../src/importers/starship-claude.js';
import { parseToml } from '../../src/importers/toml.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const fixture = (f: string) => parseToml(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
type R = ReturnType<typeof importStarshipClaude>;
const types = (r: R) => r.config.lines!.flat().map((i) => i.type);
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);
const toml = (lines: string[]) => parseToml(`${lines.join('\n')}\n`);
const TOOL = 'starship-claude';

describe('importStarshipClaude', () => {
  it('maps the minimal template with its palette', () => {
    const r = importStarshipClaude(fixture('starship-claude-minimal.toml'));
    expect(r.source).toBe('starship-claude');
    expect(types(r)).toEqual([
      'cwd',
      'git-branch',
      'git-status',
      'model',
      'context-percentage',
      'session-cost',
    ]);
    expect(r.config.style).toBeUndefined();
    expect(r.config.separator).toBe(' ');
    expect(item(r, 'cwd')).toMatchObject({ color: '#89dceb', options: { style: 'segments', segments: 2 } });
    expect(item(r, 'git-branch')).toMatchObject({ color: '#eba0ac', label: '', merge: true });
    expect(item(r, 'model')).toMatchObject({ color: '#b4befe', label: '' });
    expect(item(r, 'context-percentage')).toMatchObject({ color: '#fab387' });
    expect(item(r, 'session-cost')).toMatchObject({ color: '#a6e3a1' });
    expect(r.notes).toEqual([]);
  });

  it('turns the powerline template into the powerline style', () => {
    const r = importStarshipClaude(fixture('starship-claude-powerline.toml'));
    expect(r.config.style).toBe('powerline');
    expect(types(r)).toEqual([
      'cwd',
      'git-branch',
      'git-status',
      'model',
      'context-percentage',
      'session-cost',
    ]);
    expect(item(r, 'cwd')).toMatchObject({ color: '#88c0d0', background: '#2e3440' });
    expect(item(r, 'git-branch')).toMatchObject({ label: '\uf418', color: '#b48ead', background: '#3b4252' });
    expect(item(r, 'session-cost')).toMatchObject({ color: '#a3be8c', background: '#434c5e' });
    expect(r.notes).toEqual([
      {
        kind: 'approx',
        text: `${TOOL}: 8 powerline glyph spans were dropped; the powerline style draws its own`,
      },
    ]);
  });

  it('keeps glyph spans as text without powerline arrows', () => {
    const r = importStarshipClaude(toml(['format = "[\\ue0b6](fg:red)$directory[\\ue0b4](fg:red)"']));
    expect(types(r)).toEqual(['text', 'cwd', 'text']);
    expect(r.config.lines![0]![0]).toMatchObject({ options: { text: '\ue0b6' }, color: 'red' });
    expect(r.config.style).toBeUndefined();
  });

  it('reports palette names when there is no palette', () => {
    const r = importStarshipClaude(
      toml(['format = "${env_var.CLAUDE_COST}"', '[env_var.CLAUDE_COST]', 'style = "fg:cost bold"']),
    );
    expect(item(r, 'session-cost')).toMatchObject({ bold: true });
    expect(item(r, 'session-cost')!.color).toBeUndefined();
    expect(texts(r)).toEqual([`${TOOL} style of "env_var.CLAUDE_COST": fg:cost not supported, ignored`]);
  });

  it('maps env vars by variable or name and drops the rest', () => {
    const r = importStarshipClaude(
      toml([
        'format = "${env_var.CLAUDE_STAR} $battery ${env_var.CLAUDE_CWD} ${env_var.mine} $env_var.CLAUDE_SUMMARY"',
        '[env_var.mine]',
        'variable = "CLAUDE_RATE_5H"',
        'description = "rate"',
      ]),
    );
    expect(types(r)).toEqual(['cwd', 'five-hour-usage', 'five-hour-reset', 'session-name']);
    expect(item(r, 'cwd')!.options).toEqual({ style: 'full' });
    expect(texts(r)).toEqual([
      'Starship module "env_var.CLAUDE_STAR" has no ccinfobar equivalent and was dropped; a command widget running "starship module env_var.CLAUDE_STAR" could show it (none was created)',
      'Starship module "battery" has no ccinfobar equivalent and was dropped; a command widget running "starship module battery" could show it (none was created)',
      `${TOOL} module "env_var.CLAUDE_SUMMARY" is approximated by the session-name widget`,
    ]);
  });

  it('skips disabled modules and reads truncation_length', () => {
    const r = importStarshipClaude(
      toml([
        'format = "$directory ${env_var.CLAUDE_MODEL} $git_branch"',
        '[directory]',
        'truncation_length = 4',
        '[env_var.CLAUDE_MODEL]',
        'disabled = true',
        '[git_branch]',
        'disabled = true',
      ]),
    );
    expect(types(r)).toEqual(['cwd']);
    expect(item(r, 'cwd')!.options).toEqual({ style: 'segments', segments: 4 });
  });

  it('reads palette strings only and never through the prototype', () => {
    const r = importStarshipClaude(
      toml([
        'palette = "p"',
        'format = "${env_var.CLAUDE_COST} ${env_var.constructor} ${env_var.toString}"',
        '[env_var.CLAUDE_COST]',
        'style = "fg:a bg:b fg:constructor"',
        '[palettes.p]',
        'a = "#112233"',
        'b = 4',
      ]),
    );
    expect(types(r)).toEqual(['session-cost']);
    expect(item(r, 'session-cost')).toMatchObject({ color: '#112233' });
    expect(texts(r)[0]).toBe(
      `${TOOL} style of "env_var.CLAUDE_COST": bg:b, fg:constructor not supported, ignored`,
    );
    const missing = importStarshipClaude(toml(['palette = "constructor"', 'format = "$directory"']));
    expect(types(missing)).toEqual(['cwd']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('writes Turkish notes', () => {
    const r = withLang('tr', () => importStarshipClaude(fixture('starship-claude-powerline.toml')));
    expect(texts(r)).toEqual([
      `${TOOL}: 8 powerline simge parçası atlandı; powerline stili kendi simgelerini çizer`,
    ]);
  });

  it('targets only existing widgets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
    for (const m of Object.values(ENV_VARS)) for (const [type] of m.uses) expect(TARGETS).toContain(type);
  });
});

describe('starship-claude discovery', () => {
  let dir: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  const MINI = 'format = "${env_var.CLAUDE_MODEL}"\n';
  const write = (file: string, text = MINI) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-sc-')));
    home = path.join(dir, 'home');
    fs.mkdirSync(home);
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads <home>/.claude/starship.toml', () => {
    const file = write(path.join(home, '.claude', 'starship.toml'));
    const r = importFrom('starship-claude', { env, cwd: dir });
    expect(r.file).toBe(file);
    expect(types(r)).toEqual(['model']);
  });

  it('reads --config from the status line command', () => {
    write(path.join(home, '.claude', 'starship.toml'), 'format = "$directory"\n');
    const file = write(path.join(home, 'sc.toml'));
    const r = importFrom('starship-claude', {
      command: '~/.local/bin/starship-claude --config ~/sc.toml',
      env,
      cwd: dir,
    });
    expect(r.file).toBe(file);
    expect(types(r)).toEqual(['model']);
    const rel = write(path.join(dir, 'rel.toml'));
    const command = 'starship-claude --no-progress --config rel.toml';
    expect(importFrom('starship-claude', { command, env, cwd: dir }).file).toBe(rel);
  });

  it('fails when the file is missing or has no format', async () => {
    expect(() => importFrom('starship-claude', { env, cwd: dir })).toThrow(
      `no starship-claude config found (${path.join('~', '.claude', 'starship.toml')}); pass its path with --file`,
    );
    expect(() =>
      importFrom('starship-claude', { command: 'starship-claude --config ~/none.toml', env, cwd: dir }),
    ).toThrow(`no starship-claude config found (${path.join('~', 'none.toml')})`);
    const bare = write(path.join(dir, 'bare.toml'), 'palette = "x"\n');
    expect(() => importFrom('starship-claude', { file: bare, env, cwd: dir })).toThrow(
      'starship-claude config has no format (',
    );
    const lines: string[] = [];
    const io: PromptIo = {
      tty: false,
      ask: async (_q, fallback) => fallback,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
      columns: 100,
    };
    const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      await runImportCommand(
        parseArgs(['import', 'starship-claude', '--dry-run']),
        path.join(dir, 'c.json'),
        io,
      );
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(process.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('no starship-claude config found');
  });

  it('shows TOML errors with their position', () => {
    const bad = write(path.join(dir, 'bad.toml'), 'format = "$directory"\npalette = = 1\n');
    expect(() => importFrom('starship-claude', { file: bad, env, cwd: dir })).toThrow(/bad\.toml:2:\d+ /);
  });

  it('is detected before cship', () => {
    expect(resolveSource('Starship-Claude')).toBe('starship-claude');
    for (const command of [
      '~/.local/bin/starship-claude',
      '~/.local/bin/starship-claude --config ~/.claude/cship.toml',
      'C:\\Users\\me\\.local\\bin\\starship-claude',
    ]) {
      expect(detectTool(command), command).toMatchObject({
        tool: 'starship-claude',
        name: 'starship-claude',
        importable: true,
      });
    }
    expect(detectTool('cship')!.tool).toBe('cship');
    expect(detectTool('starship prompt')!.tool).toBe('unknown');
  });
});
