import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { help } from '../../src/cli/help.js';
import { importHelp } from '../../src/commands/import-help.js';
import type { PromptIo } from '../../src/commands/io.js';
import {
  type ImportFlags,
  rerunCommand,
  runImport,
  runImportCommand,
  shellArg,
} from '../../src/commands/manage.js';
import { t } from '../../src/core/i18n/index.js';
import { tildify } from '../../src/core/paths.js';
import type { Config } from '../../src/core/types.js';
import { visibleWidth } from '../../src/core/width.js';
import { dropTargets, importTargets, sanitizeImport, visibleTarget } from '../../src/importers/confirm.js';
import { IMPORT_SOURCES } from '../../src/importers/index.js';
import { withLang, withLangAsync } from '../helpers.js';

const root = path.join(process.env.CCINFOBAR_CONFIG_DIR!, 'confirm');

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

const write = (name: string, data: unknown): string => {
  const f = path.join(root, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
  return f;
};

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

const config = (lines: unknown[][]): Partial<Config> => ({ lines: lines as Config['lines'] });

describe('importTargets, dropTargets, sanitizeImport', () => {
  const lines = [
    [
      { id: 'c', type: 'command', options: { command: 'echo hi' } },
      { id: 't', type: 'text', options: { text: 'x' } },
    ],
    [
      { id: 'h', type: 'http', options: { url: 'https://example.com/api' } },
      { id: 'l1', type: 'link', options: { url: 'https://example.com', text: 'a' } },
      { id: 'l2', type: 'link', options: { url: 'javascript:alert(1)', text: 'b' } },
    ],
  ];

  it('lists commands, http and link urls with line and index', () => {
    expect(importTargets(config(lines))).toEqual([
      { kind: 'command', line: 0, index: 0, target: 'echo hi' },
      { kind: 'http', line: 1, index: 0, target: 'https://example.com/api' },
      { kind: 'link', line: 1, index: 1, target: 'https://example.com' },
      { kind: 'link', line: 1, index: 2, target: 'javascript:alert(1)' },
    ]);
    expect(importTargets({})).toEqual([]);
    expect(importTargets(config([[{ id: 'e', type: 'link', options: { url: '' } }]]))).toEqual([]);
  });

  it('lists env widgets with a name and drops them on request', () => {
    const cfg = config([
      [
        { id: 'e', type: 'env', options: { name: 'ANTHROPIC_API_KEY' } },
        { id: 'b', type: 'env', options: { name: '   ' } },
        { id: 'c', type: 'env', options: { name: '' } },
        { id: 'd', type: 'env' },
      ],
    ]);
    const targets = importTargets(cfg);
    expect(targets).toEqual([{ kind: 'env', line: 0, index: 0, target: 'ANTHROPIC_API_KEY' }]);
    expect(dropTargets(cfg, targets).lines![0]!.map((i) => i.id)).toEqual(['b', 'c', 'd']);
  });

  it('always drops a javascript: or data: link with a note', () => {
    const data = [{ id: 'd', type: 'link', options: { url: 'data:text/html,x' } }];
    const res = sanitizeImport({ config: config([...lines, data]), notes: [], source: 'ccstatusline' });
    expect(importTargets(res.config).map((x) => x.target)).toEqual([
      'echo hi',
      'https://example.com/api',
      'https://example.com',
    ]);
    expect(res.config.lines![2]).toEqual([]);
    expect(res.notes).toEqual([
      { kind: 'drop', text: t('import.note.unsafeLink', { url: 'javascript:alert(1)' }) },
      { kind: 'drop', text: t('import.note.unsafeLink', { url: 'data:text/html,x' }) },
    ]);
  });

  it('strips escapes, bidi controls and prototype keys', () => {
    const raw = JSON.parse(
      JSON.stringify({
        lines: [
          [
            { id: 'a', type: 'model', label: '\u001b]8;;http://evil\u0007x\u001b]8;;\u0007' },
            { id: 'b', type: 'text', options: { text: 'clear\u001b[2J' } },
            { id: 'c', type: 'separator', options: { char: '|‮' } },
          ],
        ],
      }).replace('{"lines"', '{"__proto__":{"polluted":true},"lines"'),
    );
    expect(Object.hasOwn(raw, '__proto__')).toBe(true);
    const res = sanitizeImport({
      config: raw,
      notes: [{ kind: 'info', text: 'note\u001b[31m red‮' }],
      source: 'ccstatusline',
    });
    expect(Object.hasOwn(res.config, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(res.config.lines![0]).toEqual([
      { id: 'a', type: 'model', label: 'x' },
      { id: 'b', type: 'text', options: { text: 'clear' } },
      { id: 'c', type: 'separator', options: { char: '|' } },
    ]);
    expect(res.notes).toEqual([{ kind: 'info', text: 'note red' }]);
  });

  it('drops exactly the listed items and keeps emptied lines', () => {
    const cfg = config(lines);
    const out = dropTargets(cfg, importTargets(cfg));
    expect(out.lines).toEqual([[lines[0]![1]], []]);
    const one = dropTargets(cfg, [{ kind: 'link', line: 1, index: 1, target: '' }]);
    expect(one.lines![1]!.map((i) => i.id)).toEqual(['h', 'l2']);
    expect(cfg.lines![1]).toHaveLength(3);
  });
});

describe('rerun hint quoting', () => {
  const posix = (s: string) => shellArg(s, 'linux');
  const win = (s: string) => shellArg(s, 'win32');

  it('leaves plain paths alone', () => {
    expect(posix('/home/a/.config/ccstatusline/settings.json')).toBe(
      '/home/a/.config/ccstatusline/settings.json',
    );
  });

  it('always double-quotes on Windows so Git Bash keeps backslashes and PowerShell commas', () => {
    expect(win('C:\\Users\\RUNNER~1\\cc.json')).toBe('"C:\\Users\\RUNNER~1\\cc.json"');
    expect(win('C:\\Users\\me\\.config\\cship.toml')).toBe('"C:\\Users\\me\\.config\\cship.toml"');
    expect(win('C:\\Users\\a,b\\x.json')).toBe('"C:\\Users\\a,b\\x.json"');
  });

  it('single-quotes anything else on POSIX so nothing expands', () => {
    expect(posix('/tmp/$(touch x)/cc.json')).toBe("'/tmp/$(touch x)/cc.json'");
    expect(posix('/tmp/a`id`b.json')).toBe("'/tmp/a`id`b.json'");
    expect(posix('/tmp/$HOME/a\\b.json')).toBe("'/tmp/$HOME/a\\b.json'");
    expect(posix("/tmp/it's here.json")).toBe("'/tmp/it'\\''s here.json'");
    expect(posix('/tmp/with space.json')).toBe("'/tmp/with space.json'");
    expect(posix('~/cc.json')).toBe("'~/cc.json'");
    expect(posix('-rf')).toBe("'-rf'");
  });

  it('double-quotes on Windows and refuses what cmd or PowerShell would expand', () => {
    expect(win('C:\\a b\\cc.json')).toBe('"C:\\a b\\cc.json"');
    expect(win("C:\\it's\\cc.json")).toBe('"C:\\it\'s\\cc.json"');
    for (const bad of [
      'C:\\$(touch x)\\cc.json',
      'C:\\a`b.json',
      'C:\\%PATH%.json',
      'C:\\a!b.json',
      'C:\\a"b.json',
    ])
      expect(win(bad), bad).toBeNull();
  });

  it('refuses paths that sanitizing would change', () => {
    expect(posix('/tmp/a\u001b[2Jb.json')).toBeNull();
    expect(win('C:\\a\u202eb.json')).toBeNull();
  });

  it('asks to add --file when the path is refused', () => {
    expect(rerunCommand('ccstatusline', { file: 'C:\\$(x).json' }, 'win32')).toEqual({
      command: 'ccinfobar import ccstatusline --allow-commands --force',
      addFile: true,
      addCommand: false,
    });
    expect(rerunCommand('ccstatusline', { file: '/tmp/$(touch x).json', dryRun: true }, 'linux')).toEqual({
      command: "ccinfobar import ccstatusline --allow-commands --file '/tmp/$(touch x).json' --dry-run",
      addFile: false,
      addCommand: false,
    });
    expect(rerunCommand('claude-powerline', { file: null }, 'linux')).toEqual({
      command: 'ccinfobar import claude-powerline --allow-commands --force',
      addFile: false,
      addCommand: false,
    });
  });

  it('names the program to run and adds --force only for a real import', () => {
    const npx = rerunCommand('cship', { program: 'npx ccinfobar@latest' }, 'linux').command;
    expect(npx).toBe('npx ccinfobar@latest import cship --allow-commands --force');
    expect(rerunCommand('cship', { dryRun: true }, 'linux').command).toBe(
      'ccinfobar import cship --allow-commands --dry-run',
    );
  });

  it('passes the status line command it read, or asks to add it', () => {
    const cmd = 'npx -y @owloops/claude-powerline --theme=nord';
    expect(rerunCommand('claude-powerline', { command: cmd }, 'linux')).toEqual({
      command: `ccinfobar import claude-powerline --allow-commands --force --command '${cmd}'`,
      addFile: false,
      addCommand: false,
    });
    expect(rerunCommand('claude-powerline', { command: cmd }, 'win32').command).toBe(
      `ccinfobar import claude-powerline --allow-commands --force --command "${cmd}"`,
    );
    const hud = 'node "C:\\hud\\index.js" --extra-cmd "echo hi"';
    expect(rerunCommand('claude-hud', { file: 'C:\\a%b.json', command: hud }, 'win32')).toEqual({
      command: 'ccinfobar import claude-hud --allow-commands --force',
      addFile: true,
      addCommand: true,
    });
    expect(rerunCommand('ccstatusline', { command: 'ccinfobar' }, 'linux').command).not.toContain(
      '--command',
    );
  });

  it('prints the add --file hint for a refused path', async () => {
    const dir = process.platform === 'win32' ? 'a%b' : 'a\u001bb';
    const f = fake(false);
    const ok = await runImport(
      'ccstatusline',
      { file: source(dir), command: '', flags: flags() },
      path.join(root, 'cfg.json'),
      f.io,
    );
    expect(ok).toBe(true);
    expect(f.lines).toContain(
      t('import.rerunAddFile', { command: 'ccinfobar import ccstatusline --allow-commands --force' }),
    );
  });
});

interface Fake {
  io: PromptIo;
  lines: string[];
  errors: string[];
  asked: string[];
}

const fake = (tty: boolean, answer?: boolean, columns = 100): Fake => {
  const lines: string[] = [];
  const errors: string[] = [];
  const asked: string[] = [];
  const io: PromptIo = {
    tty,
    columns,
    ask: async (q, fallback) => {
      asked.push(q);
      return answer ?? fallback;
    },
    log: (l) => lines.push(l),
    error: (l) => errors.push(l),
  };
  return { io, lines, errors, asked };
};

const flags = (f: Partial<ImportFlags> = {}): ImportFlags => ({
  allowCommands: false,
  yes: false,
  dryRun: false,
  ...f,
});

const source = (dir = 'src') =>
  write(`${dir}/cc.json`, {
    lines: [
      [
        { id: 'cmd', type: 'custom-command', commandPath: 'echo \u001b]0;evil\u0007hi' },
        { id: 'txt', type: 'custom-text', customText: 'hello' },
      ],
    ],
  });

const items = (f: string) => (read(f).lines as { type: string }[][]).flat().map((i) => i.type);

describe('runImport confirmation', () => {
  const run = (io: PromptIo, f: Partial<ImportFlags>, src = source(), cfg = path.join(root, 'cfg.json')) =>
    runImport('ccstatusline', { file: src, command: '', flags: flags(f) }, cfg, io).then((ok) => ({
      ok,
      cfg,
      src,
    }));

  it('asks on a TTY, defaults to no and drops the command with a hint', async () => {
    const f = fake(true);
    const { ok, cfg, src } = await run(f.io, {});
    expect(ok).toBe(true);
    expect(f.asked).toEqual([t('import.keepPrompt', { count: 1 })]);
    expect(f.lines.slice(0, 4)).toEqual([
      t('import.targetsHeader'),
      '  command: echo hi',
      t('import.targetsDropped', { count: 1 }),
      t('import.rerun', {
        command: `ccinfobar import ccstatusline --allow-commands --force --file ${shellArg(src)}`,
      }),
    ]);
    expect(f.lines[4]).toMatch(/^✓ Imported 1 widgets from ccstatusline \(/);
    expect(f.lines.slice(5)).toEqual([
      '  Approximated:',
      `    - ${t('import.note.targetChanged', { kind: 'command', target: 'echo hi' })}`,
      '  Dropped:',
      `    - ${t('import.note.targetDropped', { kind: 'command', target: 'echo hi' })}`,
    ]);
    expect(items(cfg)).toEqual(['text']);
    expect(f.lines.join('\n')).not.toMatch(/\u001b/);
  });

  it('lists a ccstatusline link and drops it without consent', async () => {
    const f = fake(false);
    const src = path.join(__dirname, '../fixtures/import/ccstatusline-link.json');
    const { cfg } = await run(f.io, {}, src);
    expect(f.lines).toContain('  link: https://example.com/docs');
    expect(f.lines).toContain(t('import.targetsDropped', { count: 1 }));
    expect(items(cfg)).toEqual(['model']);
  });

  it('says when cleaning changed a multi-line command', () => {
    const r = sanitizeImport({
      config: {
        lines: [
          [
            { id: 'a', type: 'command', options: { command: 'git fetch\ngit status' } },
            { id: 'b', type: 'command', options: { command: 'date' } },
          ],
        ],
      },
      notes: [],
      source: 'ccstatusline',
    });
    expect(r.config.lines![0]![0]!.options!.command).toBe('git fetch git status');
    expect(r.notes).toEqual([
      {
        kind: 'approx',
        text: t('import.note.targetChanged', { kind: 'command', target: 'git fetch git status' }),
      },
    ]);
  });

  it('names the target kind in Turkish', async () => {
    const f = fake(false);
    const { cfg } = await withLangAsync('tr', () => run(f.io, {}));
    expect(f.lines).toContain('  komut: echo hi');
    expect(f.lines).toContain(
      `    - ${withLang('tr', () => t('import.note.targetDropped', { kind: 'komut', target: 'echo hi' }))}`,
    );
    expect(f.lines.join('\n')).not.toMatch(/\bcommand\b(?! --)/);
    expect(items(cfg)).toEqual(['text']);
  });

  it('keeps the command when the TTY user says yes', async () => {
    const f = fake(true, true);
    const { cfg } = await run(f.io, {});
    expect(f.asked).toHaveLength(1);
    expect(items(cfg)).toEqual(['command', 'text']);
    expect(read(cfg).lines[0][0].options.command).toBe('echo hi');
    expect(f.lines).not.toContain(t('import.targetsDropped', { count: 1 }));
    expect(f.lines.find((l) => l.startsWith('✓'))).toMatch(/Imported 2 widgets/);
  });

  it('keeps with --allow-commands without asking but still lists', async () => {
    const f = fake(false);
    const { cfg } = await run(f.io, { allowCommands: true });
    expect(f.asked).toEqual([]);
    expect(f.lines.slice(0, 2)).toEqual([t('import.targetsHeader'), '  command: echo hi']);
    expect(items(cfg)).toEqual(['command', 'text']);
  });

  it('drops on --yes and off a TTY with the exact re-run command', async () => {
    for (const f of [fake(true, true), fake(false, true)]) {
      const { cfg } = await run(f.io, f.io.tty ? { yes: true } : {}, source(' with space'));
      expect(f.asked).toEqual([]);
      const src = path.join(root, ' with space', 'cc.json');
      expect(f.lines).toContain(
        t('import.rerun', {
          command: `ccinfobar import ccstatusline --allow-commands --force --file ${shellArg(src)}`,
        }),
      );
      expect(items(cfg)).toEqual(['text']);
    }
  });

  const cc = (name: string, ...commands: string[]) =>
    write(`${name}/cc.json`, {
      lines: [commands.map((c, i) => ({ id: `c${i}`, type: 'custom-command', commandPath: c }))],
    });
  const listed = (f: Fake) => {
    const end = f.lines.findIndex((l, i) => i > 0 && !l.startsWith('  '));
    return f.lines.slice(1, end < 0 ? undefined : end);
  };

  it('wraps a long target onto indented lines instead of cutting it', async () => {
    const f = fake(false, undefined, 40);
    await run(f.io, {}, cc('long', `echo ${'x'.repeat(200)} tail-end`));
    const lines = listed(f);
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(39);
    for (const l of lines.slice(1)) expect(l.startsWith('      ')).toBe(true);
    expect(lines.map((l, i) => (i ? l.slice(6) : l)).join('')).toBe(
      `  command: echo ${'x'.repeat(200)} tail-end`,
    );
  });

  it('shows a tail hidden behind padding and makes space runs visible', async () => {
    const f = fake(true, undefined, 80);
    await run(
      f.io,
      {},
      cc('pad', `git branch --show-current${' '.repeat(200)}; curl x | sh`, 'echo a\t   \tb'),
    );
    const text = listed(f).join('\n');
    expect(text).toContain('git branch --show-current\u27e8200 spaces\u27e9; curl x | sh');
    expect(text).toContain('echo a\u27e85 spaces\u27e9b');
    expect(text).not.toContain('   ');
  });

  it('shows zero-width, direction marks and other invisible characters as code points', async () => {
    expect(visibleTarget('a\u200bb\u200ec\u2066d\t\u00a0\ufeff\u001b\u034f\ufe0f')).toBe(
      'a\u27e8U+200B\u27e9b\u27e8U+200E\u27e9c\u27e8U+2066\u27e9d\u27e8U+0009\u27e9\u27e8U+00A0\u27e9\u27e8U+FEFF\u27e9\u27e8U+001B\u27e9\u27e8U+034F\u27e9\u27e8U+FE0F\u27e9',
    );
    const f = fake(true, true);
    const { cfg } = await run(f.io, {}, cc('zw', 'echo safe\u200b\u200e; rm x'));
    expect(listed(f)).toEqual(['  command: echo safe\u27e8U+200B\u27e9\u27e8U+200E\u27e9; rm x']);
    expect(read(cfg).lines[0][0].options.command).toBe('echo safe\u200b\u200e; rm x');
  });

  it('drops a target over 2000 characters even with consent, unless --allow-commands', async () => {
    const huge = `echo ${'y'.repeat(2100)}`;
    const f = fake(true, true);
    const { cfg } = await run(f.io, {}, cc('huge', huge, 'echo ok'));
    expect(f.asked).toEqual([t('import.keepPrompt', { count: 1 })]);
    expect(listed(f)).toEqual([
      t('import.targetLong', { kind: 'command', count: 2105 }),
      '  command: echo ok',
    ]);
    expect(read(cfg).lines[0].map((i: { options: { command: string } }) => i.options.command)).toEqual([
      'echo ok',
    ]);
    expect(f.lines).toContain(`    - ${t('import.note.targetTooLong', { kind: 'command', count: 2105 })}`);
    const g = fake(false);
    const kept = await run(g.io, { allowCommands: true }, cc('huge2', huge), path.join(root, 'cfg2.json'));
    expect(read(kept.cfg).lines[0][0].options.command).toBe(huge);
    expect(listed(g).join('').replace(/\s+/g, '')).toContain('y'.repeat(2100));
    const h = fake(true, true);
    await run(h.io, {}, cc('huge3', huge), path.join(root, 'cfg3.json'));
    expect(h.asked).toEqual([]);
  });

  it('prints nothing about targets when there are none', async () => {
    const plain = write('plain/cc.json', { lines: [[{ id: 'm', type: 'model' }]] });
    const f = fake(true);
    const { cfg } = await run(f.io, {}, plain);
    expect(f.asked).toEqual([]);
    expect(f.lines).toEqual([expect.stringMatching(/^✓ Imported 1 widgets from ccstatusline \(/)]);
    expect(items(cfg)).toEqual(['model']);
  });

  it('prints the prompt and report in Turkish', async () => {
    const f = fake(true);
    await withLangAsync('tr', () => run(f.io, {}));
    expect(f.lines[0]).toBe('Bu düzen komut çalıştırıyor veya URL açıyor:');
    expect(f.asked).toEqual(['Bu öğe korunsun mu?']);
    expect(f.lines).toContain('  Atlananlar:');
  });

  it('reports a read failure and returns false', async () => {
    const f = fake(false);
    const missing = path.join(root, 'none.json');
    expect(await run(f.io, {}, missing).then((r) => r.ok)).toBe(false);
    expect(f.errors).toEqual([t('cmd.import.failed', { error: t('import.cannotRead', { file: missing }) })]);
  });
});

describe('import --dry-run', () => {
  const cmd = (io: PromptIo, cfg: string, ...argv: string[]) =>
    runImportCommand(parseArgs(['import', 'ccstatusline', ...argv]), cfg, io);

  it('writes nothing over an existing config and prints report, preview and done', async () => {
    const src = source();
    const cfg = write('cfg/config.json', '{"lines":[[{"type":"model"}]]}\n');
    const f = fake(false);
    await cmd(f.io, cfg, '--file', src, '--dry-run');
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{"lines":[[{"type":"model"}]]}\n');
    expect(fs.readdirSync(path.dirname(cfg))).toEqual(['config.json']);
    expect(f.lines).toContain(
      t('import.rerun', {
        command: `ccinfobar import ccstatusline --allow-commands --file ${shellArg(src)} --dry-run`,
      }),
    );
    const head = f.lines.indexOf(t('import.dryRunHeader'));
    expect(head).toBeGreaterThan(0);
    expect(f.lines[head - 1]).toMatch(/^ {4}- /);
    expect(f.lines.slice(head + 1, -1).join('\n')).toContain('hello');
    expect(f.lines.at(-1)).toBe('Dry run: nothing was written.');
    expect(f.lines.join('\n')).not.toMatch(/\u001b/);
  });

  it('writes nothing without a config either and never runs a kept command', async () => {
    const marker = path.join(root, 'ran.txt');
    const src = write('run/cc.json', {
      lines: [[{ id: 'c', type: 'custom-command', commandPath: `echo ran > "${marker}"` }]],
    });
    const cfg = path.join(root, 'fresh', 'config.json');
    const f = fake(false);
    await cmd(f.io, cfg, '--file', src, '--dry-run', '--allow-commands');
    expect(fs.existsSync(cfg)).toBe(false);
    expect(fs.existsSync(path.dirname(cfg))).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    // the preview shows the sample instead of running it
    expect(f.lines.join('\n')).toContain('command output');
    expect(f.lines.at(-1)).toBe(t('import.dryRunDone'));
  });

  it('still needs --force without --dry-run', async () => {
    const cfg = write('cfg/config.json', '{}');
    const f = fake(false);
    await cmd(f.io, cfg, '--file', source());
    expect(process.exitCode).toBe(1);
    expect(f.errors).toEqual([t('cmd.import.exists', { file: tildify(cfg) })]);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{}');
  });
});

describe('help', () => {
  it('points to the import help, which names every import source', () => {
    const line = help()
      .split('\n')
      .find((l) => l.startsWith('  ccinfobar import <tool> '))!;
    expect(line).toContain('ccinfobar import --help');
    const list = importHelp();
    for (const s of IMPORT_SOURCES) expect(list).toContain(`  ${s}`);
  });
});
