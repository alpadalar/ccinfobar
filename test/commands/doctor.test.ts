import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configWarnings, runDoctor } from '../../src/commands/doctor.js';
import { inspectConfigText } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { configDir } from '../../src/core/paths.js';

const cfgFile = (name: string, text: string) => {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

const capture = (fn: () => void): string[] => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => c.map(String).join(' '));
  } finally {
    spy.mockRestore();
  }
};

afterEach(() => vi.restoreAllMocks());

describe('configWarnings', () => {
  it('lists unknown widget types and unsupported option values', () => {
    const raw = {
      lines: [[{ type: 'no-such' }], [{ type: 'context-percentage', options: { mode: 'bogus' } }]],
    };
    expect(configWarnings(raw)).toEqual([
      t('doctor.unknownWidget', { type: 'no-such', line: 1 }),
      t('doctor.badOption', { type: 'context-percentage', key: 'mode' }),
    ]);
  });

  it('checks number and boolean options', () => {
    const raw = {
      lines: [
        [
          { type: 'session-cost', options: { decimals: 'x' } },
          { type: 'context-percentage', options: { thresholdColors: 'maybe' } },
        ],
      ],
    };
    expect(configWarnings(raw)).toEqual([
      t('doctor.badOption', { type: 'session-cost', key: 'decimals' }),
      t('doctor.badOption', { type: 'context-percentage', key: 'thresholdColors' }),
    ]);
  });

  it('accepts a valid config and odd shapes', () => {
    const raw = {
      lines: [
        [
          { type: 'context-percentage', options: { mode: 'remaining', thresholdColors: 'true' } },
          { type: 'session-cost', options: { decimals: 3, unknownKey: 1 } },
          { type: 'flex' },
        ],
      ],
    };
    expect(configWarnings(raw)).toEqual([]);
    for (const v of [null, 1, 'x', {}, { lines: 'x' }, { lines: [null, [1, null]] }]) {
      expect(configWarnings(v)).toEqual([]);
    }
  });
});

describe('runDoctor config report', () => {
  it('prints the exact location of a broken config', () => {
    const text = '{\n  "lines": [,]\n}';
    const file = cfgFile('broken.json', text);
    const issue = inspectConfigText(text).issue;
    expect(issue?.line).toBe(2);
    const out = capture(() => runDoctor(file));
    expect(out.some((l) => l.startsWith('✗ Config'))).toBe(true);
    expect(out).toContain(t('doctor.configIssue', { ...issue! }));
    expect(out).toContain(t('doctor.columnNote'));
  });

  it('warns about an unknown widget and still loads the config', () => {
    const file = cfgFile('unknown.json', JSON.stringify({ lines: [[{ type: 'no-such' }]] }));
    const out = capture(() => runDoctor(file));
    expect(out.some((l) => l.startsWith('✓ Config'))).toBe(true);
    expect(out).toContain(t('doctor.unknownWidget', { type: 'no-such', line: 1 }));
  });

  it('reads a config with a BOM', () => {
    const file = cfgFile('bom.json', `﻿${JSON.stringify({ lines: [[{ type: 'no-such' }]] })}`);
    const out = capture(() => runDoctor(file));
    expect(out).toContain(t('doctor.unknownWidget', { type: 'no-such', line: 1 }));
  });
});
