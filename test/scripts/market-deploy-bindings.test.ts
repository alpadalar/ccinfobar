import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const file = path.resolve(__dirname, '../../.github/workflows/market-deploy.yml');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const indent = (l: string) => l.length - l.trimStart().length;

function stepAt(name: string): number {
  return lines.findIndex((l) => new RegExp(`^\\s+- name: ${name}\\s*$`).test(l));
}

function stepText(name: string): string {
  const at = stepAt(name);
  if (at < 0) return '';
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() !== '' && indent(l) <= indent(lines[at]!)) break;
    out.push(l);
  }
  return out.join('\n');
}

// the dry-run table of wrangler 4.154.0
const TABLE = [
  'env.LIMITER (RateCounter)                           Durable Object',
  'env.DB (ccinfobar-market)                           D1 Database',
  'env.READS (60 requests/60s)                         Rate Limit',
  'env.WRITES (30 requests/60s)                        Rate Limit',
  'env.SIGNIN (20 requests/60s)                        Rate Limit',
].join('\n');

const BINDINGS = [
  'env.LIMITER (RateCounter)',
  'env.DB (ccinfobar-market)',
  'env.READS (',
  'env.WRITES (',
  'env.SIGNIN (',
];

function listed(step: string): string[] {
  const m = /for b in (.*); do/.exec(step);
  return [...(m?.[1] ?? '').matchAll(/'([^']*)'/g)].map((x) => x[1]!);
}

describe('market deploy binding check', () => {
  const step = stepText('Check config');

  it('writes the dry run to a file and fails when a binding is missing', () => {
    expect(step).toContain('dry-run.txt');
    for (const b of BINDINGS) expect(step).toContain(b);
    expect(step).toContain('exit 1');
    expect(step).toContain('::error::');
    expect(step).not.toContain('secrets.');
  });

  it('lists strings that match the real wrangler output', () => {
    const strings = listed(step);
    expect(strings).toEqual(BINDINGS);
    for (const s of strings) expect(TABLE.includes(s)).toBe(true);
    const without = TABLE.split('\n')
      .filter((l) => !l.startsWith('env.LIMITER'))
      .join('\n');
    expect(strings.some((s) => !without.includes(s))).toBe(true);
  });

  it('runs before the migrations and the deploy', () => {
    const at = stepAt('Check config');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(stepAt('Apply D1 migrations'));
    expect(at).toBeLessThan(stepAt('Deploy'));
  });
});
