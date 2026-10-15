import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { benchMessages } from '../../src/core/i18n/en/bench.js';
import { configMessages } from '../../src/core/i18n/en/config.js';
import { doctorMessages } from '../../src/core/i18n/en/doctor.js';
import { explainMessages } from '../../src/core/i18n/en/explain.js';
import { hookMessages } from '../../src/core/i18n/en/hooks.js';
import { en } from '../../src/core/i18n/en/index.js';
import { installMessages } from '../../src/core/i18n/en/install.js';
import { jobsMessages } from '../../src/core/i18n/en/jobs.js';
import { previewMessages } from '../../src/core/i18n/en/preview.js';
import { widgetMessages } from '../../src/core/i18n/en/widgets.js';
import { t } from '../../src/core/i18n/index.js';

const dir = path.resolve(__dirname, '../../src/core/i18n');

function sources(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

describe('t()', () => {
  it('fills placeholders', () => {
    expect(t('install.installing', { version: '1.2.3' })).toBe('Installing ccinfobar 1.2.3');
    expect(t('safe.line', { line: 12 })).toBe('ccinfobar: config error at line 12, run ccinfobar doctor');
  });

  it('keeps placeholders without a param', () => {
    expect(t('install.installing')).toBe('Installing ccinfobar {version}');
    expect(t('install.wrote', { command: 'x' })).toBe('✓ statusLine set to "x" in {file}');
  });

  it('returns plain messages', () => {
    expect(t('loading.default')).toBe('loading…');
  });
});

describe('en table', () => {
  it('has non-empty strings only', () => {
    for (const [id, text] of Object.entries(en)) {
      expect(typeof text, id).toBe('string');
      expect(text.length, id).toBeGreaterThan(0);
    }
  });

  it('has no id in two area tables', () => {
    const areas = [
      installMessages,
      configMessages,
      doctorMessages,
      explainMessages,
      previewMessages,
      benchMessages,
      widgetMessages,
      hookMessages,
      jobsMessages,
    ];
    const sum = areas.reduce((n, a) => n + Object.keys(a).length, 0);
    expect(Object.keys(en).length).toBe(sum);
  });

  it('hook messages take versions as params and every hook id is used', () => {
    const src = sources(path.resolve(dir, '..', '..'))
      .filter((f) => !f.startsWith(dir))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    for (const [id, text] of Object.entries(hookMessages)) {
      expect(text, id).not.toMatch(/\d+\.\d+\.\d+/);
      expect(src.includes(`'${id}'`), id).toBe(true);
    }
  });

  it('is browser-safe', () => {
    const files = sources(dir);
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from ['"]node:/);
      expect(src, f).not.toMatch(/\bprocess\./);
    }
  });
});
