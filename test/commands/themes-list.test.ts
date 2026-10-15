import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runThemes } from '../../src/commands/manage.js';
import { tildify } from '../../src/core/paths.js';
import { listThemes, themesDir } from '../../src/core/themes.js';
import { withEnvLang } from '../helpers.js';

const dir = path.join(process.env.CCINFOBAR_CONFIG_DIR!, 'themes-list');

function capture(cfgFile: string, argv = ['themes', '--list']): string[] {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  try {
    runThemes(parseArgs([...argv, '--width', '80']), cfgFile);
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

  it('marks the current theme in Turkish with ids and names unchanged', () => {
    const lines = withEnvLang('tr', () => capture(path.join(dir, 'missing.json')));
    expect(lines).toHaveLength(listThemes().length);
    const current = lines.filter((l) => l.endsWith('  (kullanımda)'));
    expect(current).toHaveLength(1);
    expect(lines.some((l) => l.includes('(current)'))).toBe(false);
    for (const [i, th] of listThemes().entries())
      expect(lines[i]!.startsWith(`${th.id}  ${th.name}`)).toBe(true);
  });

  it('prints the previews footer in English and Turkish', () => {
    const cfg = path.join(dir, 'missing.json');
    const dirText = tildify(themesDir());
    expect(capture(cfg, ['themes']).at(-1)).toBe(
      `Switch with \`ccinfobar theme <id>\`. Your themes live in ${dirText}`,
    );
    const tr = withEnvLang('tr', () => capture(cfg, ['themes']));
    expect(tr.at(-1)).toBe(`\`ccinfobar theme <id>\` ile değiştirin. Temalarınızın yeri: ${dirText}`);
    expect(tr.some((l) => l.includes(' (kullanımda)  '))).toBe(true);
  });
});
