import { describe, expect, it } from 'vitest';
import { MASK_MAX, MASK_RULES, maskSecrets } from '../../src/data/transcript.js';

const positives: [string, string][] = [
  ['curl -u me:hunter2 https://h', 'curl -u me:… https://h'],
  ['curl --user me:hunter2 h', 'curl --user me:… h'],
  ['mysql --password hunter2 db', 'mysql --password … db'],
  ['mysql --password=hunter2 db', 'mysql --password=… db'],
  ['curl -H "X-Api-Key: abc123" h', 'curl -H "X-Api-Key: …" h'],
  ["curl -H 'Authorization: Bearer sk-abc123456789012345' h", "curl -H 'Authorization: …' h"],
  ['curl -H "X-Api-Key: abc" --silent h', 'curl -H "X-Api-Key: …" --silent h'],
  ['echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'echo …'],
  [
    'gh auth login --with-token <<< ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'gh auth login --with-token <<< …',
  ],
  ['export T=github_pat_11AAAAAAA0bbbbbbbbbbbbbbbbbbbbbb', 'export T=…'],
  ['export GITHUB_TOKEN=ghp_abcdef123', 'export GITHUB_TOKEN=…'],
  ['git clone https://me:pw@host/x', 'git clone https://me:…@host/x'],
];

const negatives = [
  'npm test -- --reporter=dot',
  'sort -u file.txt',
  'rsync -u src host:/p',
  'git log --author=me',
  'ls sk-tools',
  'cat README.md',
  'curl -H "Accept: application/json" h',
  'echo gh_short',
  'grep -i token file',
];

describe('maskSecrets table', () => {
  it.each(positives)('masks %s', (input, expected) => {
    expect(maskSecrets(input)).toBe(expected);
  });

  it.each(negatives)('keeps %s', (input) => {
    expect(maskSecrets(input)).toBe(input);
  });

  it('caps the input before masking (REL-01)', () => {
    expect(Array.from(maskSecrets('a'.repeat(5000))).length).toBe(MASK_MAX);
    expect(maskSecrets('a'.repeat(MASK_MAX))).toBe('a'.repeat(MASK_MAX));
    const smile = '\u{1F600}';
    expect(maskSecrets(smile.repeat(MASK_MAX + 5))).toBe(smile.repeat(MASK_MAX));
    const before = maskSecrets(`${'x '.repeat(5)}token=hunter2 ${'b'.repeat(2000)}`);
    expect(before.startsWith(`${'x '.repeat(5)}token=…`)).toBe(true);
    expect(before.length).toBeLessThanOrEqual(MASK_MAX);
    expect(maskSecrets(`${'y'.repeat(MASK_MAX)} token=hunter2`)).toBe('y'.repeat(MASK_MAX));
    for (const s of [
      'a'.repeat(1024),
      ' -u '.repeat(256),
      'authorization: '.repeat(64),
      '--password '.repeat(90),
    ]) {
      expect(maskSecrets(s).length).toBeLessThanOrEqual(s.length + 8);
    }
  });

  it('every rule is linear on adversarial shapes (REL-01)', () => {
    const N = 100_000;
    const shapes = [
      'a'.repeat(N),
      'token'.repeat(N / 5),
      `x://${'y'.repeat(N)}`,
      `authorization: ${' '.repeat(N)}z`,
      ` -u ${'z'.repeat(N)}`,
      ` --password "${'z'.repeat(N)}`,
      `bearer ${'a'.repeat(N)}`,
      'sk-'.repeat(N / 3),
      `ghp_${'A'.repeat(N)}`,
      `${`${'a'.repeat(50)} `.repeat(Math.floor(N / 51))}`,
    ];
    const t0 = performance.now();
    for (const shape of shapes) {
      for (const [re, rep] of MASK_RULES) shape.replace(re, rep);
      expect(maskSecrets(shape).length).toBeLessThanOrEqual(MASK_MAX + 8);
    }
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('keeps the rule order 16.1-D-04 fixed', () => {
    expect(MASK_RULES.length).toBe(7);
    expect(MASK_RULES[5]![0].source.startsWith('\\b(\\w+:')).toBe(true);
    expect(MASK_RULES[6]![0].source.includes('github_pat_')).toBe(true);
  });
});
