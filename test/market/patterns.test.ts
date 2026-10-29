import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BEARER_RE, GITHUB_TOKEN_RE, LOGIN_RE, SESSION_TOKEN_RE } from '../../src/market/patterns.js';
import { TOKEN_RE } from '../../src/market/rules.js';

const SRC = path.join(__dirname, '..', '..', 'src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

describe('marketplace patterns', () => {
  const files = walk(SRC).map((p) => ({ p, text: fs.readFileSync(p, 'utf8') }));

  for (const [name, re] of Object.entries({ GITHUB_TOKEN_RE, LOGIN_RE, SESSION_TOKEN_RE, BEARER_RE })) {
    it(`${name} is a literal in exactly one source file`, () => {
      const hits = files.filter((f) => f.text.includes(`/${re.source}/`)).map((f) => path.basename(f.p));
      expect(hits).toEqual(['patterns.ts']);
    });
  }

  it('GITHUB_TOKEN_RE bounds the length', () => {
    expect(GITHUB_TOKEN_RE.test('a'.repeat(20))).toBe(true);
    expect(GITHUB_TOKEN_RE.test('a'.repeat(19))).toBe(false);
  });

  it('LOGIN_RE refuses a leading or doubled hyphen', () => {
    expect(LOGIN_RE.test('-a')).toBe(false);
    expect(LOGIN_RE.test('a--b')).toBe(false);
    expect(LOGIN_RE.test('a-b')).toBe(true);
  });

  it('SESSION_TOKEN_RE refuses a space', () => {
    expect(SESSION_TOKEN_RE.test('ab cd')).toBe(false);
    expect(SESSION_TOKEN_RE.test('abcd')).toBe(true);
  });

  it('BEARER_RE captures the 64 hex chars', () => {
    expect(BEARER_RE.exec(`Bearer ${'a'.repeat(64)}`)?.[1]).toBe('a'.repeat(64));
  });

  it('rules.ts keeps TOKEN_RE as the header form', () => {
    expect(TOKEN_RE).toBe(BEARER_RE);
  });
});
