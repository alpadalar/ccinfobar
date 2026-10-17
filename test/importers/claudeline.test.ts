import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { PromptIo } from '../../src/commands/io.js';
import { runImportCommand } from '../../src/commands/manage.js';
import { commandArgs } from '../../src/importers/args.js';
import { importClaudeline, TARGETS } from '../../src/importers/claudeline.js';
import { detectTool, importFrom } from '../../src/importers/index.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

type R = ReturnType<typeof importClaudeline>;
const types = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);
const run = (command: string) => importClaudeline(commandArgs(command));

const TAIL = [
  'context-bar',
  'cache-miss-cause',
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
];
const LOGIN = 'claudeline "login type" is approximated by the provider widget';
const UPDATE = 'claudeline segment "update" was dropped: ccinfobar updates itself';

describe('importClaudeline', () => {
  it('maps the flags in claudeline order on one line', () => {
    const r = run('claudeline -cwd -git-branch -cost');
    expect(r.source).toBe('claudeline');
    expect(types(r)).toEqual([
      ['provider', 'model', 'cwd', 'git-branch', ...TAIL, 'session-cost', 'spend-limit', 'service-status'],
    ]);
    expect(r.config).toMatchObject({ style: 'text', separator: ' │ ' });
    expect(item(r, 'five-hour-usage')!.options).toEqual({ display: 'bar', width: 5 });
    expect(item(r, 'weekly-usage')!.options).toEqual({ display: 'bar', width: 5 });
    expect(item(r, 'context-bar')!.options).toEqual({ width: 5 });
    expect(item(r, 'cwd')).toEqual({ id: 'claudeline-cwd', type: 'cwd', options: { style: 'basename' } });
    expect(r.notes).toEqual([
      { kind: 'approx', text: LOGIN },
      { kind: 'drop', text: UPDATE },
    ]);
  });

  it('imports the bare command with its fixed segments', () => {
    expect(types(run('claudeline'))).toEqual([
      ['provider', 'model', ...TAIL, 'spend-limit', 'service-status'],
    ]);
  });

  it('reads double dashes, =false and the effort flag', () => {
    const r = run('claudeline --cost=false -effort --cwd=true -git-branch=0');
    expect(types(r)[0]!.slice(0, 4)).toEqual(['provider', 'model', 'effort', 'cwd']);
    expect(item(r, 'session-cost')).toBeUndefined();
    expect(item(r, 'git-branch')).toBeUndefined();
  });

  it('notes max lengths, skips debug inputs and stops at the first argument', () => {
    const r = run('claudeline -cwd -cwd-max-len 20 -usage-file x.json -status-file=y -debug stop -cost');
    expect(item(r, 'cwd')).toBeDefined();
    expect(item(r, 'session-cost')).toBeUndefined();
    expect(r.notes).toContainEqual({
      kind: 'approx',
      text: 'claudeline settings not imported: -cwd-max-len',
    });
    expect(texts(r)).toHaveLength(3);
    expect(texts(run('claudeline -cwd-max-len 20'))).toHaveLength(2);
    const both = run('claudeline -cwd -git-branch --cwd-max-len=9 -git-branch-max-len 5');
    expect(texts(both)).toContain('claudeline settings not imported: -cwd-max-len, -git-branch-max-len');
  });

  it('parses Windows and go install paths', () => {
    expect(item(run('C:\\Users\\u\\go\\bin\\claudeline.exe -cwd'), 'cwd')).toBeDefined();
    expect(item(run('"C:\\Program Files\\claudeline\\claudeline.exe" -cost'), 'session-cost')).toBeDefined();
    expect(item(run('~/go/bin/claudeline -git-branch'), 'git-branch')).toBeDefined();
    expect(item(run('-effort'), 'effort')).toBeDefined();
  });

  it('drops unknown flags and sanitizes their names', () => {
    const r = run('claudeline -cwd -x\u001b[31my -x\u001b[31my --theme=dark');
    expect(types(r)[0]).toContain('cwd');
    expect(texts(r)).toContain('claudeline settings not imported: -xy, -theme');
    expect(texts(r).join('')).not.toMatch(/\u001b/);
    for (const i of r.config.lines!.flat()) expect(TARGETS).toContain(i.type);
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      expect(texts(run('claudeline -cwd -cwd-max-len 4 -nope'))).toEqual([
        'claudeline "login type", provider bileşeniyle yaklaşık olarak gösteriliyor',
        'claudeline bölümü "update" atlandı: ccinfobar kendini günceller',
        'claudeline ayarları içe aktarılmadı: -cwd-max-len',
        'claudeline ayarları içe aktarılmadı: -nope',
      ]);
    });
  });
});

describe('claudeline importer', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-claudeline-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
  });

  afterEach(() => {
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps the status line command', () => {
    const r = importFrom('claudeline', { command: 'claudeline -effort', env, cwd: dir });
    expect(r.file).toBeNull();
    expect(types(r)[0]!.slice(0, 3)).toEqual(['provider', 'model', 'effort']);
  });

  it('ignores --file and still maps the command', () => {
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, '{"cost": true}');
    const r = importFrom('claudeline', { file, command: 'claudeline -cwd', env, cwd: dir });
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: 'claudeline reads its settings from the status line command, --file was ignored',
    });
    expect(item(r, 'cwd')).toBeDefined();
    expect(item(r, 'session-cost')).toBeUndefined();
    expect(r.file).toBeNull();
  });

  it('dry-runs from --command', async () => {
    const lines: string[] = [];
    const io: PromptIo = {
      tty: false,
      ask: async (_q, fallback) => fallback,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
      columns: 100,
    };
    const cfgFile = path.join(dir, 'config', 'config.json');
    const argv = ['import', 'claudeline', '--dry-run', '--command', 'claudeline -cost'];
    await runImportCommand(parseArgs(argv), cfgFile, io);
    expect(process.exitCode ?? 0, lines.join('\n')).toBe(0);
    expect(lines.at(-1)).toBe('Dry run: nothing was written.');
    expect(fs.existsSync(cfgFile)).toBe(false);
  });

  it('is detected from its command', () => {
    for (const cmd of [
      'claudeline -cwd',
      '~/go/bin/claudeline',
      'C:\\Users\\u\\go\\bin\\claudeline.exe -cost',
    ]) {
      expect(detectTool(cmd), cmd).toMatchObject({
        tool: 'claudeline',
        name: 'claudeline',
        importable: true,
      });
    }
    expect(detectTool('claudelines')?.tool).toBe('unknown');
  });
});
