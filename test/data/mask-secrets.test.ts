import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../../src/data/transcript.js';

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

  it('never grows the input and stays linear', () => {
    for (const s of [
      'a'.repeat(1024),
      ' -u '.repeat(256),
      'authorization: '.repeat(64),
      '--password '.repeat(90),
    ]) {
      expect(maskSecrets(s).length).toBeLessThanOrEqual(s.length + 8);
    }
  });
});
