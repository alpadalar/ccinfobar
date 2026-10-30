import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const file = path.resolve(__dirname, '../../.github/workflows/market-deploy.yml');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const text = lines.join('\n');

const indent = (l: string) => l.length - l.trimStart().length;

function smokeStep(): string {
  const at = lines.findIndex((l) => /^\s+- name: Smoke check\s*$/.test(l));
  if (at < 0) return '';
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() !== '' && indent(l) <= indent(lines[at]!)) break;
    out.push(l);
  }
  return out.join('\n');
}

describe('market deploy smoke check', () => {
  const step = smokeStep();

  it('fails the job unless meta.json reports limiters.strict true', () => {
    expect(step).toContain('/v1/meta.json');
    expect(step).toContain('limiters');
    expect(step).toMatch(/strict\s*===\s*true/);
    expect(step).toContain('exit 1');
  });

  it('retries in a bounded loop', () => {
    expect(step).toMatch(/for i in (\d+ )+\d+; do/);
    expect(step).not.toMatch(/while\s/);
  });

  it('sends no write requests or bursts from CI', () => {
    for (const bad of ['-X POST', '--data', '--rate', "-d '"]) expect(text).not.toContain(bad);
  });

  it('reads no secrets', () => {
    expect(step).not.toContain('secrets.');
  });
});
