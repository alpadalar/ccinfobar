import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runThemes } from '../../src/commands/manage.js';
import { listThemes } from '../../src/core/themes.js';

const dir = path.join(process.env.CCINFOBAR_CONFIG_DIR!, 'themes-list');

function capture(cfgFile: string): string[] {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  try {
    runThemes(parseArgs(['themes', '--list']), cfgFile);
  } finally {
    spy.mockRestore();
  }
  return out.flatMap((s) => s.split('\n'));
}

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('themes --list', () => {
  it('prints one plain id  name line per theme', () => {
    const lines = capture(path.join(dir, 'missing.json'));
    expect(lines).toHaveLength(listThemes().length);
    for (const line of lines) {
      expect(line).toMatch(/^[a-z0-9._-]+ {2}\S/);
      expect(line).not.toContain('\u001b');
    }
    expect(lines.filter((l) => l.endsWith('  (current)'))).toHaveLength(1);
  });

  it('marks the configured theme as current', () => {
    const other = listThemes()[1]!;
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ theme: other.id }));
    const current = capture(cfg).filter((l) => l.endsWith('  (current)'));
    expect(current).toEqual([`${other.id}  ${other.name}  (current)`]);
  });
});
