import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { createContext } from '../../src/core/context.js';
import { render } from '../../src/core/renderer.js';
import { sampleGit, sampleGsd, samplePayload, sampleTranscript } from '../../src/core/sample.js';
import type { Config } from '../../src/core/types.js';
import { convertColor, importCcstatusline } from '../../src/importers/ccstatusline.js';
import { importClaudePowerline, parsePowerlineArgs } from '../../src/importers/claude-powerline.js';
import { detectTool, importFrom, toConfig } from '../../src/importers/index.js';
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
  it('reproduces a real four-line layout without warnings', () => {
    const r = importCcstatusline(fixture('ccstatusline-settings.json'));
    expect(r.warnings).toEqual([]);
    const cfg = toConfig(r);
    expect(cfg.widthOffset).toBe(40);
    expect(show(cfg)).toEqual([
      'acme-app | feat/statusline | +148 -37',
      'Opus 5.5 | Effort high | Elapsed: 45m | Skill frontend-design',
      'Ctx ███░░░░░░░ 34% | Hit 94% | Tokens 450k | 72 t/s',
      '5h Limit: 42% | Resets 2h 14m | Weekly Limit: 61% | Resets 1d 5h',
    ]);
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
    expect(r.warnings).toEqual([
      'ccstatusline widget "jj-revision" has no ccinfobar equivalent and was skipped',
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
    expect(r.warnings).toContain(
      'claude-powerline segment "tmux" has no ccinfobar equivalent and was skipped',
    );
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
    expect(detectTool('ccline')).toMatchObject({ tool: 'ccometixline', importable: false });
    expect(detectTool('node ~/.claude/hooks/gsd-statusline.js')).toMatchObject({
      tool: 'gsd',
      importable: false,
    });
    expect(detectTool('/usr/local/bin/ccinfobar')).toBeNull();
    expect(detectTool(undefined)).toBeNull();
    expect(detectTool('bash ~/my-line.sh')).toMatchObject({ tool: 'unknown' });
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
    expect(importFrom('claude-powerline', { file: missing }).warnings[0]).toBe(
      'no claude-powerline config file found, imported its default layout',
    );
  });

  it('follows the active language and keeps names', () => {
    withLang('tr', () => {
      const cc = importCcstatusline({ lines: [[{ id: '1', type: 'jj-revision' }]] });
      expect(cc.warnings).toEqual([
        'ccstatusline bileşeni "jj-revision" için ccinfobar karşılığı yok, atlandı',
      ]);
      const pl = importClaudePowerline({ theme: 'custom', display: { lines: [{ segments: { tmux: {} } }] } });
      expect(pl.warnings).toEqual([
        'claude-powerline bölümü "tmux" için ccinfobar karşılığı yok, atlandı',
        'özel claude-powerline renkleri her bileşene ayrı ayrı kopyalandı',
      ]);
      expect(() => importFrom('ccstatusline', { file: missing })).toThrow(
        `${missing} konumundaki ccstatusline ayarları okunamıyor`,
      );
      expect(importFrom('claude-powerline', { file: missing }).warnings[0]).toBe(
        'claude-powerline yapılandırma dosyası bulunamadı, varsayılan düzeni içe aktarıldı',
      );
      expect(detectTool('node ~/.claude/hooks/gsd-statusline.js')?.name).toBe('GSD durum satırı');
      expect(detectTool('bash ~/my-line.sh')?.name).toBe('özel bir durum satırı');
      expect(detectTool('ccline')?.name).toBe('CCometixLine');
    });
  });
});
