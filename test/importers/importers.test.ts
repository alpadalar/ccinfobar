import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { createContext } from '../../src/core/context.js';
import { t } from '../../src/core/i18n/index.js';
import { render } from '../../src/core/renderer.js';
import { sampleGit, sampleGsd, samplePayload, sampleTranscript } from '../../src/core/sample.js';
import type { Config } from '../../src/core/types.js';
import { TARGETS as CC_TARGETS, convertColor, importCcstatusline } from '../../src/importers/ccstatusline.js';
import {
  importClaudePowerline,
  TARGETS as PL_TARGETS,
  parsePowerlineArgs,
} from '../../src/importers/claude-powerline.js';
import { importTargets, sanitizeImport } from '../../src/importers/confirm.js';
import {
  detectTool,
  IMPORT_SOURCES,
  importFrom,
  MAX_SOURCE_BYTES,
  readSource,
  resolveSource,
  sniffTool,
  toConfig,
} from '../../src/importers/index.js';
import type { ImportCtx, ImporterDef } from '../../src/importers/registry.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const fixture = (f: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/import', f), 'utf8'));
const NOW = new Date('2026-10-12T12:00:00Z');
const show = (config: Config) =>
  render(
    createContext({
      payload: samplePayload(NOW.getTime()),
      config: { ...config, colorLevel: 0, maxWidth: 200 },
      env: {},
      now: NOW,
      data: { git: sampleGit, gsd: sampleGsd, transcript: () => sampleTranscript(NOW.getTime()) },
    }),
  ).map(stripAnsi);

describe('ccstatusline import', () => {
  it('reproduces a real four-line layout without notes', () => {
    const r = importCcstatusline(fixture('ccstatusline-settings.json'));
    expect(r.notes).toEqual([]);
    const cfg = toConfig(r);
    expect(cfg.widthOffset).toBe(40);
    expect(show(cfg)).toEqual([
      'acme-app | feat/statusline | +148 -37',
      'Opus 5.5 | Effort high | Elapsed: 45m | Skill frontend-design',
      'Ctx ███░░░░░░░ 34% | Hit 94% | Tokens 450k | 72 t/s',
      '5h Limit: 42% | Resets 2h 14m | Weekly Limit: 61% | Resets 1d 5h',
    ]);
  });

  it('imports link items with their URL and text, so the consent step sees them', () => {
    const r = importCcstatusline(fixture('ccstatusline-link.json'));
    expect(r.config.lines![0]![1]).toEqual({
      id: 'docs',
      type: 'link',
      color: 'blue',
      options: { url: 'https://example.com/docs', text: 'docs' },
    });
    const safe = sanitizeImport(r);
    expect(importTargets(safe.config)).toEqual([
      { kind: 'link', line: 0, index: 1, target: 'https://example.com/docs' },
    ]);
    expect(safe.config.lines![0]!.map((i) => i.id)).toEqual(['m', 'docs']);
    expect(safe.notes.map((n) => n.text)).toContain(
      t('import.note.unsafeLink', { url: 'javascript:alert(1)' }),
    );
  });

  it('imports the usable context widget as basis usable', () => {
    const r = importCcstatusline({ lines: [[{ id: '1', type: 'context-percentage-usable' }]] });
    expect(r.config.lines![0]).toEqual([
      { id: '1', type: 'context-percentage', options: { basis: 'usable' } },
    ]);
  });

  it('maps powerline mode, colors and unknown widgets', () => {
    const r = importCcstatusline({
      powerline: { enabled: true, separators: [''], theme: 'nord' },
      lines: [
        [
          { id: '1', type: 'model', color: 'hex:FF8800', backgroundColor: 'bgBlue', bold: true },
          { id: '2', type: 'separator' },
          { id: '3', type: 'jj-revision' },
          { id: '4', type: 'custom-command', commandPath: 'echo hi', timeout: 500 },
        ],
      ],
    });
    expect(r.config.style).toBe('powerline');
    expect(r.config.theme).toBe('nord');
    expect(r.config.glyphs?.separator).toBe('');
    expect(r.config.lines![0]).toEqual([
      { id: '1', type: 'model', color: '#FF8800', background: 'blue', bold: true },
      { id: '4', type: 'command', options: { command: 'echo hi', timeout: 500 } },
    ]);
    expect(r.notes).toEqual([
      {
        kind: 'drop',
        text: 'ccstatusline widget "jj-revision" has no ccinfobar equivalent and was skipped',
      },
    ]);
    expect(convertColor('ansi256:208')).toBe('ansi256:208');
    expect(convertColor('nonsense')).toBeUndefined();
  });
});

describe('claude-powerline import', () => {
  it('converts segments, style, theme and custom colors', () => {
    const r = importClaudePowerline(fixture('claude-powerline.json'));
    expect(r.config.theme).toBe('nord');
    expect(r.config.style).toBe('powerline');
    expect(r.config.autoWrap).toBe(false);
    expect(r.config.widthOffset).toBe(30);
    expect(r.config.lines!.map((l) => l.map((i) => i.type))).toEqual([
      ['cwd', 'git-branch', 'git-status', 'git-ahead-behind', 'model', 'context-bar'],
      ['five-hour-usage', 'five-hour-reset', 'weekly-usage', 'weekly-reset'],
    ]);
    expect(r.config.lines![0]![1]).toMatchObject({ background: '#0066cc', color: '#ffffff', bold: true });
    expect(r.config.lines![1]![0]!.options).toEqual({ display: 'bar', style: 'capped', showPace: true });
    expect(r.notes).toContainEqual({
      kind: 'drop',
      text: 'claude-powerline segment "tmux" has no ccinfobar equivalent and was skipped',
    });
  });

  it('uses the default layout and command flags when there is no file', () => {
    const r = importClaudePowerline(
      {},
      parsePowerlineArgs('npx -y @owloops/claude-powerline@latest --style=capsule --theme rose-pine'),
    );
    expect(r.config.style).toBe('capsule');
    expect(r.config.theme).toBe('rose-pine');
    expect(r.config.autoWrap).toBe(true);
    expect(r.config.lines![0]!.map((i) => i.type)).toEqual([
      'cwd',
      'git-branch',
      'model',
      'tokens-total',
      'context-percentage',
      'agent-name',
    ]);
  });
});

describe('detectTool', () => {
  it('recognises known status lines', () => {
    expect(detectTool('/home/u/.npm-global/bin/ccstatusline')).toMatchObject({
      tool: 'ccstatusline',
      importable: true,
    });
    expect(detectTool('npx -y @owloops/claude-powerline@latest')).toMatchObject({
      tool: 'claude-powerline',
      importable: true,
    });
    expect(detectTool('ccline')).toMatchObject({ tool: 'ccometixline', importable: true });
    expect(detectTool('~/.claude/ccline/ccline')).toMatchObject({ tool: 'ccometixline', importable: true });
    expect(detectTool('node ~/.claude/hooks/gsd-statusline.js')).toMatchObject({
      tool: 'gsd',
      importable: false,
    });
    expect(detectTool('/usr/local/bin/ccinfobar')).toBeNull();
    expect(detectTool(undefined)).toBeNull();
    expect(detectTool('bash ~/my-line.sh')).toMatchObject({ tool: 'unknown' });
  });

  const legacy: [string, string][] = [
    ['/home/u/.npm-global/bin/ccstatusline', 'ccstatusline'],
    ['npx -y ccstatusline@latest', 'ccstatusline'],
    ['npx -y @owloops/claude-powerline@latest', 'claude-powerline'],
    ['npx -y @owloops/claude-powerline@latest --style=powerline', 'claude-powerline'],
    ['ccline', 'ccometixline'],
    ['~/.claude/ccline/ccline', 'ccometixline'],
    ['C:\\Users\\u\\.claude\\ccline\\ccline.exe', 'ccometixline'],
    ['/usr/local/bin/cship', 'cship'],
    ['node ~/.claude/plugins/claude-hud/dist/index.js', 'claude-hud'],
    ['bun x ccusage statusline', 'ccusage'],
    ['node ~/.claude/hooks/gsd-statusline.js', 'gsd'],
  ];

  it.each(legacy)('keeps %s on %s', (command, tool) => {
    expect(detectTool(command)?.tool).toBe(tool);
  });

  it('names recognised tools that cannot be imported', () => {
    const other = (command: string, name: string) =>
      expect(detectTool(command)).toEqual({ tool: 'other', name, importable: false, command });
    other('~/.claude/arcade-statusline --theme pacman', 'arcade-statusline');
    other('~/.claude/arcade-statusline --theme pikmin --buddy-padding', 'arcade-statusline');
    other(
      'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/u/.claude/awesome-statusline.ps1 -Size large',
      'awesome-statusline',
    );
    other('/usr/bin/bash --login -i C:\\Users\\u\\.claude\\awesome-statusline.sh', 'awesome-statusline');
    other('bash ~/.claude/awesome-statusline.sh', 'awesome-statusline');
    other('python3 "/path/to/yet-another-statusline/claude/statusline_command.py"', 'yet-another-statusline');
    other(
      '/home/u/.claude/plugins/cache/x/yas/1.0/.python/bin/python3 /home/u/.claude/plugins/cache/x/yas/1.0/claude/statusline_command.py',
      'yet-another-statusline',
    );
    other(
      'pwsh -NoProfile -ExecutionPolicy Bypass -File ~/.claude/statusline/statusline.ps1',
      'ClaudeCodeStatusLine',
    );
  });

  it('leaves generic script paths to the importers and the sniff', () => {
    for (const command of [
      '~/.claude/statusline.sh',
      'bash "$HOME/.claude/statusline.sh"',
      'bash ~/.claude/statusline/statusline.sh',
      '~/.claude/statusline',
      'node ${CLAUDE_PLUGIN_ROOT}/statusline.js',
    ]) {
      expect(detectTool(command)?.tool, command).not.toBe('other');
    }
  });

  it('checks registry patterns before the built-in ones', () => {
    const def = {
      source: 'claude-hud',
      name: 'Specific',
      repo: 'x/specific',
      shown: null,
      detect: [/ccstatusline-zh/i],
      hasDefault: false,
      discover: () => null,
      load: () => ({ config: {}, notes: [], source: 'claude-hud' }),
    } satisfies ImporterDef;
    expect(detectTool('npx ccstatusline-zh')?.tool).toBe('ccstatusline');
    expect(detectTool('npx ccstatusline-zh', [def])).toEqual({
      tool: 'claude-hud',
      name: 'Specific',
      importable: true,
      command: 'npx ccstatusline-zh',
    });
    expect(detectTool('npx ccstatusline', [def])?.tool).toBe('ccstatusline');
    expect(detectTool('/usr/local/bin/ccinfobar', [def])).toBeNull();
  });
});

describe('sniffTool', () => {
  const temp = () => {
    const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-sniff-')));
    onTestFinished(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  };
  const dummy = (file: (ctx: ImportCtx) => string | null) =>
    ({
      source: 'cship',
      name: 'dummy',
      repo: 'x/dummy',
      shown: null,
      hasDefault: false,
      discover: () => null,
      load: () => ({ config: {}, notes: [], source: 'cship' }),
      sniff: { file, marker: /Generated by dummy/ },
    }) satisfies ImporterDef;
  const header = '#!/bin/bash\n# Generated by dummy v1\necho hi\n';

  it('reports the tool when the file header matches', () => {
    const d = temp();
    const file = path.join(d, 'statusline.sh');
    fs.writeFileSync(file, header);
    const seen: ImportCtx[] = [];
    const def = dummy((ctx) => {
      seen.push(ctx);
      return file;
    });
    const env = { HOME: d, USERPROFILE: d };
    expect(sniffTool(`bash ${file}`, { env, cwd: d, defs: [def] })).toEqual({
      tool: 'cship',
      name: 'dummy',
      importable: true,
      command: `bash ${file}`,
    });
    expect(seen[0]).toMatchObject({ command: `bash ${file}`, cwd: d, home: d, env });
    expect(sniffTool('x', { env, cwd: d, defs: [dummy(() => file), def] })?.name).toBe('dummy');
  });

  it('ignores symlinks, directories, missing files and other headers', () => {
    const d = temp();
    const env = { HOME: d, USERPROFILE: d };
    const real = path.join(d, 'real.sh');
    fs.writeFileSync(real, header);
    const other = path.join(d, 'other.sh');
    fs.writeFileSync(other, '#!/bin/bash\n# Generated by someone else\n');
    const sniff = (file: string | null) => sniffTool('x', { env, cwd: d, defs: [dummy(() => file)] });
    expect(sniff(d)).toBeNull();
    expect(sniff(path.join(d, 'none.sh'))).toBeNull();
    expect(sniff(other)).toBeNull();
    expect(sniff(null)).toBeNull();
    expect(
      sniffTool('x', {
        env,
        cwd: d,
        defs: [
          dummy(() => {
            throw new Error('boom');
          }),
        ],
      }),
    ).toBeNull();
    expect(sniffTool('x', { env, cwd: d, defs: [] })).toBeNull();
    const link = path.join(d, 'link.sh');
    try {
      fs.symlinkSync(real, link);
    } catch {
      return; // no symlink rights on this Windows runner
    }
    expect(sniff(real)?.name).toBe('dummy');
    expect(sniff(link)).toBeNull();
  });

  it('reads only the first 512 bytes', () => {
    const d = temp();
    const env = { HOME: d, USERPROFILE: d };
    const late = path.join(d, 'late.sh');
    fs.writeFileSync(late, `#!/bin/bash\n# ${'x'.repeat(600)}\n# Generated by dummy v1\n`);
    const edge = path.join(d, 'edge.sh');
    fs.writeFileSync(edge, `${'#'.repeat(512 - 'Generated by dummy'.length)}Generated by dummy`);
    expect(sniffTool('x', { env, cwd: d, defs: [dummy(() => late)] })).toBeNull();
    expect(sniffTool('x', { env, cwd: d, defs: [dummy(() => edge)] })?.name).toBe('dummy');
  });
});

describe('import text', () => {
  const missing = path.join(__dirname, '../fixtures/import/no-such-file.json');

  it('names tools in English', () => {
    expect(detectTool('node ~/.claude/hooks/gsd-statusline.js')?.name).toBe('GSD status line');
    expect(detectTool('bash ~/my-line.sh')?.name).toBe('a custom status line');
    expect(() => importFrom('ccstatusline', { file: missing })).toThrow(
      `Cannot read ccstatusline settings at ${missing}`,
    );
    expect(importFrom('claude-powerline', { file: missing }).notes[0]).toEqual({
      kind: 'info',
      text: 'no claude-powerline config file found, imported its default layout',
    });
  });

  it('follows the active language and keeps names', () => {
    withLang('tr', () => {
      const cc = importCcstatusline({ lines: [[{ id: '1', type: 'jj-revision' }]] });
      expect(cc.notes.map((n) => n.text)).toEqual([
        'ccstatusline bileşeni "jj-revision" için ccinfobar karşılığı yok, atlandı',
      ]);
      const pl = importClaudePowerline({ theme: 'custom', display: { lines: [{ segments: { tmux: {} } }] } });
      expect(pl.notes.map((n) => n.text)).toEqual([
        'claude-powerline bölümü "tmux" için ccinfobar karşılığı yok, atlandı',
        'özel claude-powerline renkleri her bileşene ayrı ayrı kopyalandı',
      ]);
      expect(() => importFrom('ccstatusline', { file: missing })).toThrow(
        `${missing} konumundaki ccstatusline ayarları okunamıyor`,
      );
      expect(importFrom('claude-powerline', { file: missing }).notes[0]?.text).toBe(
        'claude-powerline yapılandırma dosyası bulunamadı, varsayılan düzeni içe aktarıldı',
      );
      expect(detectTool('node ~/.claude/hooks/gsd-statusline.js')?.name).toBe('GSD durum satırı');
      expect(detectTool('bash ~/my-line.sh')?.name).toBe('özel bir durum satırı');
      expect(detectTool('ccline')?.name).toBe('CCometixLine');
    });
  });
});

describe('import notes', () => {
  it('sanitizes foreign names in notes', () => {
    const r = importCcstatusline({
      lines: [[{ id: '1', type: 'evil\u001b]8;;https://example.com\u0007x\u001b[31m' }]],
    });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]!.kind).toBe('drop');
    expect(r.notes[0]!.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const pl = importClaudePowerline({ display: { lines: [{ segments: { 'a\u001b[2Jb': {} } }] } });
    expect(pl.notes[0]!.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('notes ccstatusline hide states it cannot reproduce', () => {
    const hide = (value: unknown) =>
      importCcstatusline({ lines: [[{ id: '1', type: 'git-branch', metadata: { hide: value } }]] });
    const r = hide('no-git,zero');
    expect(r.notes).toEqual([
      { kind: 'approx', text: 'git-branch: hiding when "zero" is not supported, it stays visible' },
    ]);
    expect(r.config.lines![0]).toEqual([{ id: '1', type: 'git-branch' }]);
    expect(hide('no-data').notes).toEqual([]);
    expect(hide(' no-git , no-jj,no-remote,no-upstream,empty,, ').notes).toEqual([]);
    expect(hide('zero,default-value,zero').notes.map((n) => n.text)).toEqual([
      'git-branch: hiding when "zero" is not supported, it stays visible',
      'git-branch: hiding when "default-value" is not supported, it stays visible',
    ]);
    expect(hide(['zero']).notes).toEqual([]);
    expect(hide('a\u001b[31mb').notes[0]!.text).toBe(
      'git-branch: hiding when "ab" is not supported, it stays visible',
    );
    withLang('tr', () => {
      expect(hide('zero').notes[0]!.text).toBe(
        'git-branch: "zero" durumunda gizleme desteklenmiyor, bileşen görünür kalır',
      );
    });
  });

  it('marks custom powerline colors as approximated', () => {
    const r = importClaudePowerline({ theme: 'custom', display: { lines: [{ segments: { model: {} } }] } });
    expect(r.notes).toEqual([
      { kind: 'approx', text: 'custom claude-powerline colors were copied onto each widget' },
    ]);
  });
});

describe('import sources', () => {
  it('resolves tool names case-insensitively', () => {
    expect(IMPORT_SOURCES).toEqual([
      'ccstatusline',
      'claude-powerline',
      'ccometixline',
      'cship',
      'claude-hud',
      'best-claude-hud',
      'byebyecode',
    ]);
    expect(resolveSource('ccstatusline')).toBe('ccstatusline');
    expect(resolveSource('CLAUDE-POWERLINE')).toBe('claude-powerline');
    for (const bad of ['nope', '', undefined, 'constructor', '__proto__', 'toString', ' ccstatusline']) {
      expect(resolveSource(bad), String(bad)).toBeNull();
    }
  });

  it('lists every emitted widget type as a target and every target exists', () => {
    const types = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const t of [...CC_TARGETS, ...PL_TARGETS]) expect(types.has(t), t).toBe(true);
    const emitted = (lines: { type: string }[][] | undefined) => (lines ?? []).flat().map((i) => i.type);
    const cc = emitted(importCcstatusline(fixture('ccstatusline-settings.json')).config.lines);
    for (const t of cc) expect(CC_TARGETS, t).toContain(t);
    const allSegments = Object.fromEntries(
      [
        'directory',
        'git',
        'model',
        'session',
        'context',
        'block',
        'weekly',
        'metrics',
        'version',
        'agent',
        'thinking',
        'cacheTimer',
        'outputStyle',
        'sessionId',
      ].map((n) => [n, {}]),
    );
    const full = {
      display: {
        lines: [
          {
            segments: {
              ...allSegments,
              git: { showSha: true, showWorkingTree: true, showUpstream: true, showStashCount: true },
              env: { variable: 'HOME' },
            },
          },
          { segments: { git: { showOperation: true, showRepoName: true }, session: { type: 'tokens' } } },
          { segments: { context: { displayStyle: 'bar' } } },
        ],
      },
    };
    for (const raw of [fixture('claude-powerline.json'), full, {}]) {
      for (const t of emitted(importClaudePowerline(raw).config.lines)) expect(PL_TARGETS, t).toContain(t);
    }
    expect(new Set(emitted(importClaudePowerline(full).config.lines))).toEqual(new Set(PL_TARGETS));
  });
});

describe('readSource', () => {
  const dir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-import-'));
    onTestFinished(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  };

  it('refuses files over 1 MB for every importer', () => {
    const d = dir();
    const big = path.join(d, 'big.json');
    fs.writeFileSync(big, `{"lines":[]}${' '.repeat(MAX_SOURCE_BYTES + 1 - 12)}`);
    expect(fs.statSync(big).size).toBe(MAX_SOURCE_BYTES + 1);
    expect(() => readSource(big)).toThrow(`${big} is larger than 1 MB and was not read`);
    expect(() => importFrom('ccstatusline', { file: big })).toThrow('is larger than 1 MB');
    expect(() => importFrom('claude-powerline', { file: big })).toThrow('is larger than 1 MB');
    withLang('tr', () => expect(() => readSource(big)).toThrow(`${big} 1 MB sınırından büyük, okunmadı`));
    const edge = path.join(d, 'edge.json');
    fs.writeFileSync(edge, `{"lines":[]}${' '.repeat(MAX_SOURCE_BYTES - 12)}`);
    expect(readSource(edge)).toHaveLength(MAX_SOURCE_BYTES);
  });

  it('strips one BOM and reports read errors', () => {
    const d = dir();
    const f = path.join(d, 'bom.json');
    fs.writeFileSync(f, `﻿${JSON.stringify({ lines: [[{ id: '1', type: 'model' }]] })}`);
    expect(readSource(f).startsWith('{')).toBe(true);
    expect(importFrom('ccstatusline', { file: f }).config.lines).toEqual([[{ id: '1', type: 'model' }]]);
    const pl = path.join(d, 'pl.json');
    fs.writeFileSync(pl, `﻿${JSON.stringify({ theme: 'nord' })}`);
    expect(importFrom('claude-powerline', { file: pl }).config.theme).toBe('nord');
    fs.writeFileSync(f, '﻿﻿x');
    expect(readSource(f)).toBe('﻿x');
    expect(() => readSource(path.join(d, 'none.json'))).toThrow();
    fs.writeFileSync(pl, '{nope');
    expect(() => importFrom('claude-powerline', { file: pl })).toThrow(
      `Cannot parse claude-powerline config at ${pl}`,
    );
  });
});
