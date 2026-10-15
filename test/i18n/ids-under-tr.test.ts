import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../../src/core/config.js';
import { getPath, parsePath } from '../../src/core/config-path.js';
import { language } from '../../src/core/i18n/index.js';
import { resolveTheme } from '../../src/core/themes.js';
import { getWidget } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

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
});
