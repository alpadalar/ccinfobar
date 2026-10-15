import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runConfig } from '../../src/commands/config-cmd.js';
import { normalizeConfig } from '../../src/core/config.js';
import { getPath, parsePath } from '../../src/core/config-path.js';
import { language } from '../../src/core/i18n/index.js';
import { configDir } from '../../src/core/paths.js';
import { resolveTheme } from '../../src/core/themes.js';
import { paletteMatches } from '../../src/editor/web/search.js';
import { widgetScore } from '../../src/tui/catalog.js';
import { themeItems } from '../../src/tui/state.js';
import { CATEGORIES, getWidget } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

afterEach(() => {
  process.exitCode = undefined;
});

describe('ids under Turkish', () => {
  it('is Turkish inside withLang', () => {
    expect(withLang('tr', language)).toBe('tr');
    expect(language()).toBe('en');
  });

  it('finds widgets by type', () => {
    withLang('tr', () => {
      for (const type of ['limit-risk', 'git-branch', 'model', 'session-id']) {
        expect(getWidget(type)?.type).toBe(type);
      }
    });
  });

  it('resolves themes by id', () => {
    withLang('tr', () => {
      expect(resolveTheme('nord').id).toBe('nord');
      expect(resolveTheme('classic').id).toBe('classic');
    });
  });

  it('keeps camelCase config keys', () => {
    const cfg = withLang('tr', () =>
      normalizeConfig({
        lines: [[{ type: 'limit-risk', hideWhen: 'context.pct < 10' }]],
        gitHardening: false,
        lineAlign: ['right'],
        glyphMode: 'jetbrains',
        ambiguousWidth: 2,
      }),
    );
    expect(cfg.gitHardening).toBe(false);
    expect(cfg.lineAlign).toEqual(['right']);
    expect(cfg.glyphMode).toBe('jetbrains');
    expect(cfg.ambiguousWidth).toBe(2);
    expect(cfg.lines[0]![0]!.type).toBe('limit-risk');
  });

  it('parses config paths', () => {
    withLang('tr', () => {
      const path = parsePath('lines.0.0.hideWhen');
      expect(path).toEqual(['lines', 0, 0, 'hideWhen']);
      const root = { lines: [[{ type: 'limit-risk', hideWhen: 'context.pct < 10' }]] };
      expect(getPath(root, path)).toEqual({ found: true, value: 'context.pct < 10' });
    });
  });

  it('cases ids without the locale', () => {
    expect('title'.toLocaleUpperCase('tr')).toBe('TİTLE');
    expect('TITLE'.toLocaleLowerCase('tr')).toBe('tıtle');
    withLang('tr', () => {
      expect('limit-risk'.toUpperCase()).toBe('LIMIT-RISK');
      expect('LIMIT-RISK'.toLowerCase()).toBe('limit-risk');
      expect('gitHardening'.toLowerCase()).toBe('githardening');
    });
  });

  it('finds limit-risk by type, English and Turkish name in TUI and web search', () => {
    const def = getWidget('limit-risk')!;
    const cat = CATEGORIES.find((c) => c.id === def.category)!;
    withLang('tr', () => {
      for (const q of [
        'limit-risk',
        'LIMIT-RISK',
        'Limit risk',
        'Limit riski',
        'LİMİT RİSKİ',
        'limit riski',
      ]) {
        expect(widgetScore(def, q), q).not.toBeNull();
        expect(paletteMatches(def, cat.id, cat.name, q), q).toBe(true);
      }
      expect(widgetScore(def, 'git-branch')).toBeNull();
      expect(paletteMatches(def, cat.id, cat.name, 'git-branch')).toBe(false);
    });
  });

  it('finds themes by id in the TUI', () => {
    withLang('tr', () => {
      for (const q of ['nord', 'NORD', 'Nord'])
        expect(
          themeItems(q).map((th) => th.id),
          q,
        ).toContain('nord');
    });
  });

  it('sets and gets camelCase config paths', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    const file = path.join(configDir(), 'ids-under-tr.json');
    fs.writeFileSync(file, JSON.stringify({ lines: [[{ type: 'model' }], [{ type: 'limit-risk' }]] }));
    const run = (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      runConfig(parseArgs(['config', ...argv]), file, { out: (l) => out.push(l), err: (l) => err.push(l) });
      expect(err).toEqual([]);
      return out.join('\n');
    };
    withLang('tr', () => {
      run('set', 'gitHardening', 'false');
      run('set', 'lineAlign', '["right","center"]');
      run('set', 'lines.1.0.hideWhen', '"context.pct < 10"');
      expect(run('get', 'gitHardening')).toBe('false');
      expect(JSON.parse(run('get', 'lineAlign'))).toEqual(['right', 'center']);
      expect(run('get', 'lines.1.0.hideWhen')).toBe('context.pct < 10');
    });
    expect(process.exitCode).toBeUndefined();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.gitHardening).toBe(false);
    expect(saved.lineAlign).toEqual(['right', 'center']);
  });

  it('matches language settings without Turkish casing', () => {
    withLang('tr', () => {
      expect(normalizeConfig({ language: 'TR' }).language).toBe('tr');
      expect(normalizeConfig({ language: 'AUTO' }).language).toBe('auto');
      expect(normalizeConfig({ language: 'EN' }).language).toBe('en');
    });
  });
});
